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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ReadResourceResult,
  type ListResourcesResult,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './logger.js';
import { evaluatePolicy } from './core/policy.js';
import type { ToolContext, ToolRisk } from './core/tool-factory.js';
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

export function registerResources(server: McpServer, ctx: ToolContext): void {
  const pendingActionsDecision = evaluatePolicy('meta_list_pending_actions', 'read', ctx.config);
  const pendingActionsVisible =
    ctx.config.confirmationMode !== 'off' && pendingActionsDecision.allowed;
  const webhookEventsDecision = evaluatePolicy('messenger_get_webhook_events', 'read', ctx.config);
  // ─────────── avito://docs/safety ───────────
  server.registerResource(
    'safety-docs',
    'avito://docs/safety',
    {
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
        title: 'Pending actions (live)',
        description:
          'Pending actions currently awaiting confirmation. Subscribable: a client can ' +
          'subscribe via resources/subscribe and receive notifications/resources/updated ' +
          'on every create/confirm/cancel/expire.',
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
        title: 'Avito webhook events (live)',
        description:
          'Recently received Avito messenger webhook events (new chat messages). Subscribable: ' +
          'resources/subscribe → notifications/resources/updated on each delivery. Requires the ' +
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

  // The SDK McpServer does not register subscribe/unsubscribe automatically — we
  // declared the capability in server.ts, so the handlers must exist. We implement
  // it lightly: track a set of subscribers and, on a pending-actions change, notify only them.
  const subscribers = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    if (req.params.uri === PENDING_ACTIONS_URI && !pendingActionsVisible) return {};
    if (req.params.uri === WEBHOOK_EVENTS_URI && !webhookEventsDecision.allowed) return {};
    if (req.params.uri !== PENDING_ACTIONS_URI && req.params.uri !== WEBHOOK_EVENTS_URI) return {};
    subscribers.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
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
      title: 'Avito swagger (raw OpenAPI)',
      description:
        'Raw swagger files from swaggers/. One resource per file. ' +
        'Use it to give an agent the full context of an endpoint without MCP tools.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
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
        throw new Error(`Invalid swagger slug: ${slug}`);
      }
      const filename = `${slug}.json`;
      const full = join(SWAGGERS_DIR, filename);
      // Verify the resolved path does not escape the directory.
      const rel = relative(resolve(SWAGGERS_DIR), resolve(full));
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Swagger path escapes directory: ${slug}`);
      }
      const body = safeReadFile(full);
      if (body === null) {
        throw new Error(`Swagger '${slug}' not found. Available: ${swaggerFiles.join(', ')}`);
      }
      return {
        contents: [{ uri: uri.toString(), mimeType: 'application/json', text: body }],
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
