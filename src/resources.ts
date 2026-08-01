/**
 * MCP Resources (spec 2025-11-25). This module registers static and dynamic
 * resources on the server:
 *
 *   - `avito://docs/safety`              — markdown with safety modes and confirmation
 *   - `avito://manifest`                  — JSON registry of tools (dist/manifest.json)
 *   - `avito://state/config`              — sanitized snapshot of the active config (no secrets)
 *   - `avito://state/pending-actions`     — live JSON pending-actions (subscribable!)
 *   - `avito://state/rate-limits`         — latest rate-limit snapshot per domain
 *   - `avito://swaggers/{file}`           — raw swagger (template + list callback)
 *
 * `state/pending-actions` is the only one where the server emits `notifications/resources/updated`
 * when its contents change (pending created / confirmed / cancelled). This is achieved by
 * wiring an EventEmitter-like onChange from the PendingActionStore.
 *
 * All resources are read-only. Dependencies are the same as for tools: ctx.client (for rate-limits),
 * ctx.config (for the config snapshot and secret filtering), ctx.pendingStore (for pending).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import type {
  CacheHint,
  McpServer,
  ProtocolEra,
  ReadResourceResult,
  ListResourcesResult,
} from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { logger } from './logger.js';
import { evaluatePolicy } from './core/policy.js';
import { toolContextEra, type ToolContext, type ToolRisk } from './core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Repository root. In dev mode (tsx) src/resources.ts → '..',
 * in a build (node) dist/resources.js → '..'. Same logic as in src/version.ts.
 */
const REPO_ROOT = resolve(here, '..');
const SAFETY_DOC = resolve(REPO_ROOT, 'docs', 'safety.md');
const MANIFEST = resolve(REPO_ROOT, 'dist', 'manifest.json');
const SWAGGERS_DIR = resolve(REPO_ROOT, 'swaggers');

/** Public URI for clients to subscribe to pending-actions updates. */
export const PENDING_ACTIONS_URI = 'avito://state/pending-actions';

/** v0.9.0: public URI for clients to subscribe to received Avito webhook events. */
export const WEBHOOK_EVENTS_URI = 'avito://webhook/events';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * M4.2 — the `resources/read` cache decision for one URI (or URI template).
 *
 * `cacheScope: 'public'` on the 2026-07-28 wire authorises a SHARED cache to
 * store the body and serve it to a DIFFERENT caller. That makes the dangerous
 * mistake here concrete rather than theoretical: `avito://state/pending-actions`
 * carries live `confirmation_id` values, which are bearer-like handles that
 * authorise a money or public operation on the production Avito account. One
 * `public` on that URI is a credential leak into an intermediary cache.
 *
 * Hence `accountScoped`: it is not documentation, it is the input to the guard
 * below, which refuses to let the process start with an account-scoped URI
 * marked `public`.
 */
export interface ResourceCacheDecision {
  /** The URI, or the URI template for templated resources. */
  readonly uri: string;
  /**
   * `true` when the body is derived from the configured Avito account, the
   * operator's safety policy, or live server state — i.e. when it is NOT the
   * same answer for every caller of every deployment of this package version.
   */
  readonly accountScoped: boolean;
  readonly hint: CacheHint;
  /** Why this scope and this TTL. Kept in the data so the table cannot drift from its rationale. */
  readonly why: string;
}

/**
 * Every `avito://` resource, with its scope decision. A walk of the whole set,
 * as required by M4.2:
 *
 * The two `public` entries are files SHIPPED IN THE PACKAGE — the same bytes on
 * every deployment of this version, with nothing account-derived in them. Every
 * other resource fails that test, so every other resource is `private`.
 */
export const RESOURCE_CACHE_DECISIONS: readonly ResourceCacheDecision[] = [
  {
    uri: 'avito://docs/safety',
    accountScoped: false,
    hint: { ttlMs: HOUR, cacheScope: 'public' },
    why: 'docs/safety.md as shipped in the package: identical for every deployment of this version, and it describes the modes rather than reporting which one is active.',
  },
  {
    uri: 'avito://swaggers/{slug}',
    accountScoped: false,
    hint: { ttlMs: HOUR, cacheScope: 'public' },
    why: 'raw upstream OpenAPI files from swaggers/, shipped in the package and never account-derived.',
  },
  {
    uri: 'avito://manifest',
    accountScoped: true,
    hint: { ttlMs: MINUTE, cacheScope: 'private' },
    why: 'liveManifest() re-evaluates the active safety policy per entry, so the body reports which tools THIS deployment exposes and why the rest are hidden. Short TTL because the policy is fixed for the life of the process but the file underneath is regenerated by builds.',
  },
  {
    uri: 'avito://state/config',
    accountScoped: true,
    hint: { ttlMs: MINUTE, cacheScope: 'private' },
    why: 'the effective configuration of this deployment (mode, allow/deny, confirmation, upload dirs). Secrets are redacted, but the shape of an operator’s safety posture is not something to hand to another caller from a shared cache.',
  },
  {
    uri: 'avito://state/rate-limits',
    accountScoped: true,
    hint: { ttlMs: 0, cacheScope: 'private' },
    why: 'live X-RateLimit counters observed on THIS account’s Avito calls. ttlMs 0: a cached snapshot is worse than no snapshot, because a client would throttle against stale numbers.',
  },
  {
    uri: PENDING_ACTIONS_URI,
    accountScoped: true,
    hint: { ttlMs: 0, cacheScope: 'private' },
    why: 'live confirmation_id handles that authorise money/public operations. ttlMs 0 AND private: this is the single most dangerous cache decision in the migration.',
  },
  {
    uri: WEBHOOK_EVENTS_URI,
    accountScoped: true,
    hint: { ttlMs: 0, cacheScope: 'private' },
    why: 'the contents of messages received by this account. ttlMs 0: the buffer changes on every delivery, and a shared cache must never see it.',
  },
];

/**
 * Fails the process rather than the request: an account-scoped URI marked
 * `public` is not a bug you want to discover from a cache hit in production, so
 * the table is checked when this module loads, before any server is built.
 */
function assertResourceCacheDecisions(): Map<string, CacheHint> {
  const byUri = new Map<string, CacheHint>();
  for (const decision of RESOURCE_CACHE_DECISIONS) {
    if (byUri.has(decision.uri)) {
      throw new Error(`Duplicate resource cache decision for ${decision.uri}`);
    }
    if (decision.accountScoped && decision.hint.cacheScope === 'public') {
      throw new Error(
        `Resource cache decision for ${decision.uri} marks an account-scoped URI as cacheScope:"public"`,
      );
    }
    const ttl = decision.hint.ttlMs;
    if (ttl === undefined || !Number.isSafeInteger(ttl) || ttl < 0) {
      throw new Error(`Resource cache decision for ${decision.uri} has an invalid ttlMs: ${ttl}`);
    }
    byUri.set(decision.uri, decision.hint);
  }
  return byUri;
}

const CACHE_HINT_BY_URI = assertResourceCacheDecisions();

/**
 * The hint for a registered resource. Throws for an unknown URI on purpose: a
 * resource added without a scope decision would otherwise silently inherit the
 * server-level `resources/read` fallback, and the point of M4.2 is that every
 * URI gets a decision someone made on purpose.
 */
export function resourceCacheHint(uri: string): CacheHint {
  const hint = CACHE_HINT_BY_URI.get(uri);
  if (hint === undefined) {
    throw new Error(
      `No resource cache decision for ${uri}. Add one to RESOURCE_CACHE_DECISIONS in src/resources.ts.`,
    );
  }
  return hint;
}

/**
 * Removes from config the fields that must NEVER leak to the client:
 * client_id / client_secret / confirmation_secret / token_file path, plus the
 * v0.9.0 nested secrets (http.oauthOwnerPassword, http.authTokens,
 * http.oauthStoreFile, webhook.secret, webhook.logFile).
 *
 * For every redacted key we always emit an explicit marker: '[redacted]' if
 * the value was set, or null if it was not. The client sees this even when the
 * original field was undefined / absent — no surprises from a "lost" field.
 *
 * Defence in depth: after the explicit redactions, a recursive sweep censors
 * any remaining key whose NAME looks secret-bearing, so a future config field
 * cannot silently leak through this resource again.
 */
const SECRET_KEY_RE = /(secret|password|token|credential)s?$/i;

function redactSecretKeysDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecretKeysDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      const empty =
        v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0);
      out[k] = empty ? null : '[redacted]';
    } else {
      out[k] = redactSecretKeysDeep(v, depth + 1);
    }
  }
  return out;
}

function sanitizeConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const REDACTED_KEYS = [
    'clientId',
    'clientSecret',
    'confirmationSecret',
    'tokenFile',
    'allowedUploadDirs',
  ] as const;
  const mark = (v: unknown): string | null =>
    v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0)
      ? null
      : '[redacted]';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if ((REDACTED_KEYS as readonly string[]).includes(k)) {
      out[k] = mark(v);
    } else {
      out[k] = v;
    }
  }
  // Ensure all redacted keys are present, even if they were absent from cfg.
  for (const k of REDACTED_KEYS) {
    if (!(k in out)) out[k] = null;
  }
  // v0.9.1: the nested http/webhook blocks introduced in v0.9.0 carry secrets too.
  if (typeof out.http === 'object' && out.http !== null) {
    const http = { ...(out.http as Record<string, unknown>) };
    http.oauthOwnerPassword = mark(http.oauthOwnerPassword);
    http.authTokens = mark(http.authTokens);
    // File paths follow the tokenFile convention: presence yes, location no.
    http.oauthStoreFile = mark(http.oauthStoreFile);
    out.http = http;
  }
  if (typeof out.webhook === 'object' && out.webhook !== null) {
    const webhook = { ...(out.webhook as Record<string, unknown>) };
    webhook.secret = mark(webhook.secret);
    webhook.logFile = mark(webhook.logFile);
    out.webhook = webhook;
  }
  return redactSecretKeysDeep(out) as Record<string, unknown>;
}

interface ManifestTool {
  name: string;
  domain: string;
  risk: ToolRisk | 'unknown';
  [key: string]: unknown;
}

function liveManifest(raw: string, ctx: ToolContext): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const sourceTools = Array.isArray(parsed.tools) ? (parsed.tools as ManifestTool[]) : [];
  const tools = sourceTools.filter((tool) => {
    if (!tool || typeof tool.name !== 'string') return false;
    if (tool.name === 'messenger_upload_images' && ctx.config.allowedUploadDirs.length === 0) {
      return false;
    }
    if (
      ctx.config.confirmationMode === 'off' &&
      ['meta_confirm_action', 'meta_cancel_action', 'meta_list_pending_actions'].includes(tool.name)
    ) {
      return false;
    }
    const knownRisks = new Set<ToolRisk>(['sensitive', 'read', 'write', 'money', 'public']);
    const risk: ToolRisk = knownRisks.has(tool.risk as ToolRisk)
      ? (tool.risk as ToolRisk)
      : 'write';
    return evaluatePolicy(tool.name, risk, ctx.config).allowed;
  });

  const risks: Array<ToolRisk | 'unknown'> = [
    'sensitive',
    'read',
    'write',
    'money',
    'public',
    'unknown',
  ];
  const byRisk = Object.fromEntries(
    risks.map((risk) => [
      risk,
      tools
        .filter((tool) => tool.risk === risk)
        .map((tool) => tool.name)
        .sort(),
    ]),
  );
  const domains = [...new Set(tools.map((tool) => tool.domain))].sort();
  const byDomain = Object.fromEntries(
    domains.map((domain) => [
      domain,
      tools
        .filter((tool) => tool.domain === domain)
        .map((tool) => tool.name)
        .sort(),
    ]),
  );
  return {
    ...parsed,
    catalogue_scope: 'active_policy',
    tool_count: tools.length,
    counts_by_risk: Object.fromEntries(risks.map((risk) => [risk, byRisk[risk]!.length])),
    counts_by_domain: Object.fromEntries(
      domains.map((domain) => [domain, byDomain[domain]!.length]),
    ),
    by_risk: byRisk,
    by_domain: byDomain,
    tools,
  };
}

function jsonResource(uri: string, payload: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function textResource(uri: string, mimeType: string, text: string): ReadResourceResult {
  return { contents: [{ uri, mimeType, text }] };
}

function safeReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The URIs this server emits `notifications/resources/updated` for, filtered by
 * the deployment's active policy.
 *
 * Exported because on the modern era the subscription registry does NOT live on
 * an `McpServer` instance any more. Revision 2026-07-28 replaced
 * `resources/subscribe` (a per-connection `Set<uri>` on a long-lived server)
 * with `subscriptions/listen` (a stream owned by the serving ENTRY, fed by a
 * `ServerEventBus` that outlives every per-request instance). So the publisher
 * side moved out of this module and into `src/http/mcp-http.ts`, which holds
 * the handler — but the POLICY decision about which URIs exist at all must not
 * be duplicated there, or a resource hidden by `AVITO_MCP_MODE` would still
 * announce its changes to anyone who asked.
 */
export function subscribableResourceUris(config: Config): string[] {
  const uris: string[] = [];
  if (
    config.confirmationMode !== 'off' &&
    evaluatePolicy('meta_list_pending_actions', 'read', config).allowed
  ) {
    uris.push(PENDING_ACTIONS_URI);
  }
  if (evaluatePolicy('messenger_get_webhook_events', 'read', config).allowed) {
    uris.push(WEBHOOK_EVENTS_URI);
  }
  return uris;
}

/**
 * How a client of this era asks to be told when `uri` changes. Goes into the
 * resource DESCRIPTION, which is text the model reads and acts on — naming
 * `resources/subscribe` to a 2026 client produces an agent that calls a method
 * answering `-32601` and then stops trying.
 *
 * `legacy` returns the caller's own wording verbatim rather than a shared
 * phrasing. The two descriptions were worded differently in 1.3.x, and
 * "harmonising" them would have rewritten a client-visible string on a wire
 * this stage is contractually not allowed to move — which is exactly what the
 * capture-and-diff of the legacy handshake caught before this shipped.
 */
function subscriptionHint(era: ProtocolEra, uri: string, legacy: string): string {
  return era === 'modern'
    ? `Subscribable: open a subscriptions/listen stream with resourceSubscriptions: ["${uri}"] ` +
        'and receive notifications/resources/updated on the same stream'
    : legacy;
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  const era = toolContextEra(ctx);
  const pendingActionsDecision = evaluatePolicy('meta_list_pending_actions', 'read', ctx.config);
  const pendingActionsVisible =
    ctx.config.confirmationMode !== 'off' && pendingActionsDecision.allowed;
  const webhookEventsDecision = evaluatePolicy('messenger_get_webhook_events', 'read', ctx.config);
  // ─────────── avito://docs/safety ───────────
  server.registerResource(
    'safety-docs',
    'avito://docs/safety',
    {
      cacheHint: resourceCacheHint('avito://docs/safety'),
      title: 'Safety modes & confirmation guide',
      description:
        'Markdown documentation for AVITO_MCP_MODE, AVITO_MCP_CONFIRMATION_MODE, ' +
        'AVITO_MCP_CONFIRMATION_SECRET and the upload guard. The same file as docs/safety.md.',
      mimeType: 'text/markdown',
    },
    async (uri): Promise<ReadResourceResult> => {
      const body = safeReadFile(SAFETY_DOC);
      if (body === null) {
        return textResource(
          uri.toString(),
          'text/markdown',
          '# Safety docs not found\n\nFile docs/safety.md is missing in this build.',
        );
      }
      return textResource(uri.toString(), 'text/markdown', body);
    },
  );

  // ─────────── avito://manifest ───────────
  server.registerResource(
    'tools-manifest',
    'avito://manifest',
    {
      cacheHint: resourceCacheHint('avito://manifest'),
      title: 'Tools manifest (live tool registry)',
      description:
        'JSON catalogue of every registered MCP tool with its risk/domain/annotations. ' +
        'The same file as dist/manifest.json — generated via npm run generate:manifest.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const body = safeReadFile(MANIFEST);
      if (body === null) {
        return jsonResource(uri.toString(), {
          error: 'manifest_missing',
          hint: 'Run npm run generate:manifest first',
          name: PACKAGE_NAME,
          version: VERSION,
        });
      }
      try {
        return jsonResource(uri.toString(), liveManifest(body, ctx));
      } catch (err) {
        logger.warn({ err, manifest: MANIFEST }, 'failed to parse tools manifest');
        return jsonResource(uri.toString(), {
          error: 'manifest_invalid',
          name: PACKAGE_NAME,
          version: VERSION,
        });
      }
    },
  );

  // ─────────── avito://state/config ───────────
  server.registerResource(
    'config-snapshot',
    'avito://state/config',
    {
      cacheHint: resourceCacheHint('avito://state/config'),
      title: 'Active server configuration',
      description:
        'Snapshot of the effective config (mode, allow/deny, confirmation, upload), without secrets. ' +
        'Use it to quickly understand which mode the server is running in.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      return jsonResource(uri.toString(), {
        name: PACKAGE_NAME,
        version: VERSION,
        config: sanitizeConfig(ctx.config as unknown as Record<string, unknown>),
      });
    },
  );

  // ─────────── avito://state/rate-limits ───────────
  server.registerResource(
    'rate-limits',
    'avito://state/rate-limits',
    {
      cacheHint: resourceCacheHint('avito://state/rate-limits'),
      title: 'Latest rate-limits snapshot',
      description:
        'Current X-RateLimit-Limit / Remaining / Reset per logical Avito API domain. ' +
        'Empty if no request has been made yet.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const snaps = ctx.client.rateLimiter.getStatus();
      return jsonResource(uri.toString(), {
        observed_at: new Date().toISOString(),
        snapshots: snaps,
        count: snaps.length,
      });
    },
  );

  // ─────────── avito://state/pending-actions ───────────
  // Mirrors meta_list_pending_actions and must obey the same allow/deny policy,
  // because it exposes the same bearer-like confirmation ids.
  if (pendingActionsVisible) {
    server.registerResource(
      'pending-actions',
      PENDING_ACTIONS_URI,
      {
        cacheHint: resourceCacheHint(PENDING_ACTIONS_URI),
        title: 'Pending actions (live)',
        description:
          'Pending actions currently awaiting confirmation. ' +
          `${subscriptionHint(
            era,
            PENDING_ACTIONS_URI,
            'Subscribable: a client can subscribe via resources/subscribe and receive ' +
              'notifications/resources/updated',
          )} on every create/confirm/cancel/expire.`,
        mimeType: 'application/json',
      },
      async (uri): Promise<ReadResourceResult> => {
        const items = await ctx.pendingStore.listPersistent();
        return jsonResource(uri.toString(), {
          count: items.length,
          confirmation_mode: ctx.config.confirmationMode,
          confirmation_ttl_sec: ctx.config.confirmationTtlSec,
          hard_confirmation: !!ctx.config.confirmationSecret,
          pending: items.map((a) => ({
            id: a.id,
            tool: a.toolName,
            risk: a.risk,
            summary: a.summary,
            created_at: new Date(a.createdAt).toISOString(),
            expires_at: new Date(a.expiresAt).toISOString(),
          })),
        });
      },
    );
  } else {
    logger.info(
      {
        resource: PENDING_ACTIONS_URI,
        tool: 'meta_list_pending_actions',
        reason:
          ctx.config.confirmationMode === 'off'
            ? 'AVITO_MCP_CONFIRMATION_MODE=off'
            : pendingActionsDecision.allowed
              ? 'resource unavailable'
              : pendingActionsDecision.reason,
      },
      'resource hidden by policy',
    );
  }

  // ─────────── avito://webhook/events ───────────
  // v0.9.0: subscribable, like pending-actions. Emits resources/updated on every
  // received Avito webhook delivery. When the receiver is disabled (no webhookStore)
  // it still lists so clients can discover the capability — it just reports enabled:false.
  if (webhookEventsDecision.allowed) {
    server.registerResource(
      'webhook-events',
      WEBHOOK_EVENTS_URI,
      {
        cacheHint: resourceCacheHint(WEBHOOK_EVENTS_URI),
        title: 'Avito webhook events (live)',
        description:
          'Recently received Avito messenger webhook events (new chat messages). ' +
          `${subscriptionHint(
            era,
            WEBHOOK_EVENTS_URI,
            'Subscribable: resources/subscribe → notifications/resources/updated',
          )} on each delivery. Requires the ` +
          'webhook receiver to be enabled (AVITO_MCP_WEBHOOK_SECRET); otherwise reports enabled:false. ' +
          'For filtered/paged access use the messenger_get_webhook_events tool.',
        mimeType: 'application/json',
      },
      async (uri): Promise<ReadResourceResult> => {
        const enabled = ctx.config.webhook.enabled;
        return jsonResource(uri.toString(), {
          enabled,
          public_url: enabled ? ctx.config.webhook.publicUrl : null,
          stats: ctx.webhookStore?.stats() ?? null,
          events: ctx.webhookStore?.list({ limit: 50 }) ?? [],
        });
      },
    );
  } else {
    logger.info(
      {
        resource: WEBHOOK_EVENTS_URI,
        tool: 'messenger_get_webhook_events',
        reason: webhookEventsDecision.reason,
      },
      'resource hidden by policy',
    );
  }

  // ── subscriptions ──────────────────────────────────────────────────────────
  //
  // Legacy (2025-11-25) ONLY. The SDK McpServer does not register
  // subscribe/unsubscribe automatically — we declare the capability, so the
  // handlers must exist. We implement it lightly: track a set of subscribers
  // and, on a pending-actions change, notify only them.
  //
  // Revision 2026-07-28 removed both RPCs and both notification routes from the
  // instance: `subscriptions/listen` streams are owned by the serving ENTRY
  // (`createMcpHandler`), fed by a `ServerEventBus` that outlives the
  // per-request instance this function is registering onto. Installing this
  // block on a modern instance would be worse than useless — every one of the
  // 148-tool per-request instances would attach and detach two listeners on the
  // process-wide stores for a `subscribers` set that can never be non-empty,
  // because nothing on this era can call `resources/subscribe`. The publisher
  // side lives in `src/http/mcp-http.ts`; see `subscribableResourceUris`.
  if (era !== 'modern') {
    const subscribers = new Set<string>();
    server.server.setRequestHandler('resources/subscribe', async (req) => {
      if (req.params.uri === PENDING_ACTIONS_URI && !pendingActionsVisible) return {};
      if (req.params.uri === WEBHOOK_EVENTS_URI && !webhookEventsDecision.allowed) return {};
      if (req.params.uri !== PENDING_ACTIONS_URI && req.params.uri !== WEBHOOK_EVENTS_URI) {
        return {};
      }
      subscribers.add(req.params.uri);
      return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', async (req) => {
      subscribers.delete(req.params.uri);
      return {};
    });

    // Wire up the emitter: every change in PendingActionStore -> sendResourceUpdated,
    // if there is a subscriber for this URI.
    //
    // The stores are process-wide singletons while Streamable HTTP builds one
    // McpServer per session, so every subscription registered here MUST be torn
    // down when this server closes — otherwise each session leaks two listeners
    // (and sendResourceUpdated calls against dead sessions) forever.
    const unsubscribers: Array<() => void> = [];
    if (pendingActionsVisible) {
      unsubscribers.push(
        ctx.pendingStore.onChange(() => {
          if (!subscribers.has(PENDING_ACTIONS_URI)) return;
          server.server.sendResourceUpdated({ uri: PENDING_ACTIONS_URI }).catch((err: unknown) => {
            logger.debug({ err }, 'sendResourceUpdated failed');
          });
        }),
      );
    }

    // v0.9.0: same wiring for webhook events — notify subscribers on each delivery.
    if (ctx.webhookStore && webhookEventsDecision.allowed) {
      unsubscribers.push(
        ctx.webhookStore.onChange(() => {
          if (!subscribers.has(WEBHOOK_EVENTS_URI)) return;
          server.server.sendResourceUpdated({ uri: WEBHOOK_EVENTS_URI }).catch((err: unknown) => {
            logger.debug({ err }, 'sendResourceUpdated failed');
          });
        }),
      );
    }

    const previousOnClose = server.server.onclose;
    server.server.onclose = () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      subscribers.clear();
      previousOnClose?.();
    };
  }

  // ─────────── avito://swaggers/{file} ───────────
  // ResourceTemplate with a list callback — the client sees each swagger as a separate resource.
  const swaggerFiles = existsSync(SWAGGERS_DIR)
    ? readdirSync(SWAGGERS_DIR).filter((f) => f.toLowerCase().endsWith('.json'))
    : [];
  const swaggerSlug = (filename: string): string =>
    encodeURIComponent(filename.replace(/\.json$/i, ''));

  server.registerResource(
    'swagger-file',
    new ResourceTemplate('avito://swaggers/{slug}', {
      list: async (): Promise<ListResourcesResult> => ({
        resources: swaggerFiles.map((f) => ({
          uri: `avito://swaggers/${swaggerSlug(f)}`,
          name: f.replace(/\.json$/i, ''),
          title: f.replace(/\.json$/i, ''),
          mimeType: 'application/json',
          description: `Raw Avito swagger ${f}`,
        })),
      }),
      complete: {
        slug: async (value: string): Promise<string[]> =>
          swaggerFiles
            .map((f) => swaggerSlug(f))
            .filter((s) => s.toLowerCase().startsWith(value.toLowerCase()))
            .slice(0, 100),
      },
    }),
    {
      cacheHint: resourceCacheHint('avito://swaggers/{slug}'),
      title: 'Avito swagger (raw OpenAPI)',
      description:
        'Raw swagger files from swaggers/. One resource per file. ' +
        'Use it to give an agent the full context of an endpoint without MCP tools.',
      mimeType: 'application/json',
    },
    // Item 14: on the MODERN era every failure here is a `ResourceNotFoundError`
    // — `-32602` with `data.uri`, the pair revision 2026-07-28 reassigns "resource
    // not found" to. A bare `throw new Error` becomes `-32603 Internal error`,
    // which tells a client the server broke rather than that it asked for
    // something that does not exist.
    //
    // And on the modern era the three failure branches answer IDENTICALLY. A
    // distinct error for "you tried to escape the directory" is an oracle: it
    // confirms which candidate paths the guard found interesting. `..` is not a
    // resource of this server, so "not found" is both the safest answer and the
    // true one.
    //
    // The legacy era keeps its 1.3.x messages and its `-32603` verbatim. The
    // improvement is real, but it is a client-visible change on a wire this
    // stage promises not to move, and the capture-and-diff of the legacy
    // handshake is what makes that promise checkable rather than aspirational.
    // Item 14 is scoped to the modern connection; the legacy answer moves in a
    // release that says so.
    async (uri, variables): Promise<ReadResourceResult> => {
      const requested = uri.toString();
      const notFound = (legacyMessage: string): Error =>
        era === 'modern' ? new ResourceNotFoundError(requested) : new Error(legacyMessage);

      const slugRaw = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      const slug = decodeURIComponent(String(slugRaw ?? ''));
      // Path-traversal protection: disallow '..', '/' and null bytes.
      if (
        !slug ||
        slug.includes('..') ||
        slug.includes('/') ||
        slug.includes('\\') ||
        slug.includes('\0')
      ) {
        throw notFound(`Invalid swagger slug: ${slug}`);
      }
      const filename = `${slug}.json`;
      const full = join(SWAGGERS_DIR, filename);
      // Verify the resolved path does not escape the directory.
      const rel = relative(resolve(SWAGGERS_DIR), resolve(full));
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw notFound(`Swagger path escapes directory: ${slug}`);
      }
      const body = safeReadFile(full);
      if (body === null) {
        throw notFound(
          `Swagger '${slug}' not found. Available: ${swaggerFiles.join(', ')}`,
        );
      }
      return {
        contents: [{ uri: requested, mimeType: 'application/json', text: body }],
      };
    },
  );

  logger.info(
    {
      resourceCount: 4 + Number(pendingActionsVisible) + Number(webhookEventsDecision.allowed),
      swaggerCount: swaggerFiles.length,
    },
    'MCP resources registered',
  );
}
