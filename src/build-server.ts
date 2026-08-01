/**
 * v0.9.0: server-construction factory, extracted from src/server.ts so the same
 * fully-wired McpServer can back BOTH the stdio transport and every Streamable
 * HTTP session.
 *
 * Heavy/stateful singletons (AvitoClient, the pending/idempotency/webhook stores)
 * live in the shared `baseCtx` created once in server.ts. Each call here builds a
 * fresh McpServer and a per-call ctx that shares those singletons but carries its
 * own `server` reference — so an HTTP deployment can hold many concurrent sessions
 * without duplicating the Avito client or token cache.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { McpServerFactory, ServerOptions } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import type { ToolContext } from './core/tool-factory.js';
import { domains } from './meta/domain-registry.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { bindMcpLogger } from './logger.js';
import { PACKAGE_NAME, VERSION } from './version.js';
import { hasConfiguredCredentials } from './core/credentials.js';
import { applyLegacyWireDefaults } from './core/wire-compat.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * M4.2 — the per-operation `ttlMs` / `cacheScope` this server emits on the
 * 2026-07-28 wire (SEP-2549 `CacheableResult`).
 *
 * Read this together with `RESOURCE_CACHE_DECISIONS` in `src/resources.ts`,
 * which decides `resources/read` per URI; the entry here is the fallback for
 * any resource that does not name its own hint.
 *
 * Era safety: these values are attached to results on a symbol-keyed property
 * that JSON never serializes, and only the 2026 codec reads it. A 2025-era
 * response is byte-identical with and without this option — which is why the
 * table can be unconditional instead of gated on `AVITO_MCP_PROTOCOL_ERA`.
 *
 * The rule behind the `cacheScope` column, applied uniformly:
 *
 *   `public` is reserved for payloads that are (a) constant for a given
 *   package version and (b) contain nothing derived from the configured Avito
 *   account, the operator's safety policy, or live server state. Everything
 *   else is `private`. `public` means a SHARED cache may hand this body to a
 *   different caller, so the question is never "is this secret" but "is this
 *   the same for everyone".
 *
 * | operation                  | scope   | ttl  | why                                                                        |
 * |----------------------------|---------|------|----------------------------------------------------------------------------|
 * | `server/discover`          | public  | 1 h  | `supportedVersions`, `capabilities` and `instructions` are process         |
 * |                            |         |      | constants of this package version; no account data, identical for every    |
 * |                            |         |      | caller of the endpoint. Static ⇒ a long TTL is the point of the field.     |
 * | `resources/templates/list` | public  | 1 h  | one unconditional template (`avito://swaggers/{slug}`) whose descriptor is |
 * |                            |         |      | shipped in the package.                                                    |
 * | `tools/list`               | private | 5 m  | MEMBERSHIP is a function of the deployment's safety policy                 |
 * |                            |         |      | (`AVITO_MCP_MODE`, allow/deny lists, `exposeAuthTools`), so it is not the  |
 * |                            |         |      | same answer for every deployment behind one cache, and it changes when     |
 * |                            |         |      | the operator changes the policy.                                           |
 * | `prompts/list`             | private | 5 m  | same registry surface; kept in step with `tools/list` deliberately.        |
 * | `resources/list`           | private | 1 m  | membership is conditional: `avito://state/pending-actions` appears only    |
 * |                            |         |      | when confirmations are on and policy allows it, `avito://webhook/events`   |
 * |                            |         |      | only when policy allows it.                                                |
 * | `resources/read`           | private | 0    | the FALLBACK for a resource that names no hint of its own. Conservative on |
 * |                            |         |      | purpose: adding a resource and forgetting its hint must fail closed, and   |
 * |                            |         |      | most of our resources are live account state.                              |
 */
export const MODERN_CACHE_HINTS: NonNullable<ServerOptions['cacheHints']> = {
  'server/discover': { ttlMs: HOUR, cacheScope: 'public' },
  'resources/templates/list': { ttlMs: HOUR, cacheScope: 'public' },
  'tools/list': { ttlMs: 5 * MINUTE, cacheScope: 'private' },
  'prompts/list': { ttlMs: 5 * MINUTE, cacheScope: 'private' },
  'resources/list': { ttlMs: MINUTE, cacheScope: 'private' },
  'resources/read': { ttlMs: 0, cacheScope: 'private' },
};

/**
 * The safety instructions handed to the model.
 *
 * Lives here as a named export because of a trap specific to the 2026-07-28
 * revision: on a modern connection there is no `initialize`, so the only
 * carrier left for this text is the `server/discover` result. Losing it would
 * not fail any request — the agent would simply stop being told that this
 * server talks to a LIVE Avito account and that write/money/public operations
 * go through the confirmation flow. `test/modern-conformance.test.ts` asserts
 * the string reaches the modern wire.
 */
export const SERVER_INSTRUCTIONS: string =
  'Avito MCP — a server for the live (production) Avito API. Before any write/money/public ' +
  'operation, always confirm the action with a human; in confirmation_mode=money_public ' +
  '(default) the server returns a confirmation_id and requires a meta_confirm_action call. ' +
  'Full reference on the safety modes is in the avito://docs/safety resource. The list of tools ' +
  'with their risk classification is in avito://manifest. Pending actions are in ' +
  'avito://state/pending-actions (you can subscribe via resources/subscribe). Received Avito ' +
  'webhook events (if the receiver is enabled) are in avito://webhook/events (subscribable).';

/**
 * Builds a fully-registered McpServer (all domains, resources, prompts) wired to
 * the shared context. `baseCtx` provides the singletons; this returns a new
 * server each call with its own per-session ctx.
 */
export function buildMcpServer(baseCtx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: 'Avito MCP',
      version: VERSION,
      description:
        '148 tools for the Avito API: listings, messenger, orders, delivery, ' +
        'promotion, autoload, analytics, webhook events. With a safety policy (read_only / guarded / ' +
        'full_access), a confirmation flow for money/public operations, and hard-confirmation via ' +
        'AVITO_MCP_CONFIRMATION_SECRET.',
      websiteUrl: 'https://github.com/elchin92/avito-mcp',
    },
    {
      capabilities: {
        logging: {},
        resources: { subscribe: true, listChanged: true },
        // M2: `true` here is what 1.3.x actually advertised, not a claim we make
        // lightly. SDK v1's McpServer overwrote the declared value with
        // `listChanged: true` the moment a tool/prompt was registered; v2 honours
        // the declaration instead. The tool and prompt sets are static, so
        // neither notification is ever emitted either way — but M2's contract is
        // "identical to 1.3.x on the wire", and narrowing an advertised
        // capability is a client-visible change that belongs in its own release,
        // not smuggled in with an SDK bump. Revisit at M3.
        prompts: { listChanged: true },
        tools: { listChanged: true },
      },
      // Delivered by `initialize` on a 2025 connection and by `server/discover`
      // on a 2026 one — the SDK's `_ondiscover()` copies `_instructions` into
      // the discover result, so ONE declaration feeds both eras. See
      // SERVER_INSTRUCTIONS for why that matters more than it looks.
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: MODERN_CACHE_HINTS,
    },
  );

  // M2: pin the tool-descriptor details v2 changed (JSON Schema dialect and the
  // `execution` field) back to what 1.3.x emitted, before anything registers.
  applyLegacyWireDefaults(server);

  // Per-session ctx: shares the singletons in baseCtx, but binds this server so
  // resources/prompts/logging target the right session.
  const ctx: ToolContext = { ...baseCtx, server };

  for (const register of domains) {
    register(server, ctx);
  }
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  return server;
}

/**
 * M3.2 — the {@link McpServerFactory} both v2 serving entries take.
 *
 * `serveStdio(factory)` and `createMcpHandler(factory)` do NOT accept a ready
 * instance: they own the era decision and call the factory themselves — once per
 * connection for stdio (plus once more for a `server/discover` probe instance
 * that is discarded again if the client falls back to `initialize`), and once
 * per HTTP request for the modern path. That makes every side effect inside the
 * factory a per-call cost, so:
 *
 *   • The heavy singletons stay in `baseCtx` (AvitoClient, token cache, the
 *     pending/idempotency/webhook stores) and are never rebuilt here.
 *   • The one per-instance side effect we do need — registering the instance as
 *     an MCP log sink — is torn down on that instance's own `close()`. The sink
 *     registry in `src/logger.ts` is a strong `Map`, so an unbound instance
 *     would be a permanent leak of a fully-registered 148-tool server; both
 *     entries close the instances they discard, which is what makes the
 *     `onclose` hook a reliable teardown point.
 *
 * `background` mirrors the existing split: a stdio connection is the process's
 * only client and receives background (non-request-scoped) log events, whereas
 * an HTTP instance only receives the events produced inside its own request.
 */
export function createServerFactory(
  baseCtx: ToolContext,
  options: { background: boolean },
): McpServerFactory {
  return () => {
    const server = buildMcpServer(baseCtx);
    const unbind = bindMcpLogger(server, { background: options.background });

    // Teardown is hooked in TWO places because neither covers the other:
    //
    //   • `onclose` fires when the connection ends — including when the peer
    //     hangs up and nobody calls `close()` on our side. Chained, not
    //     assigned: both v2 entries install their own `onclose` afterwards and
    //     chain onto whatever they find, so overwriting would drop theirs (and
    //     assigning after them would drop ours).
    //   • `close()` covers an instance that is discarded WITHOUT ever having
    //     been connected. `Protocol.close()` is `await this._transport?.close()`
    //     — with no transport it is a no-op and `onclose` never fires, so an
    //     instance built for a connection that failed before `connect()` would
    //     otherwise stay in the sink registry forever.
    //
    // `unbind` is idempotent, so both firing is harmless.
    const previousOnClose = server.server.onclose;
    server.server.onclose = () => {
      unbind();
      previousOnClose?.();
    };
    const originalClose = server.close.bind(server);
    server.close = async () => {
      try {
        await originalClose();
      } finally {
        unbind();
      }
    };
    return server;
  };
}

/**
 * The rich local JSON snapshot returned by `--health`.
 * Pure (no I/O, no Avito call): safe for docker healthchecks and quick diagnostics.
 */
export function healthPayload(config: Config): Record<string, unknown> {
  return {
    ok: true,
    name: PACKAGE_NAME,
    version: VERSION,
    timestamp: new Date().toISOString(),
    safety: {
      mode: config.mode,
      confirmationMode: config.confirmationMode,
      hardConfirmation: !!config.confirmationSecret,
      dryRunDefault: config.dryRunDefault,
      exposeAuthTools: config.exposeAuthTools,
      allowToolsCount: config.allowTools.length,
      denyToolsCount: config.denyTools.length,
    },
    transport: config.http.transport,
    http: {
      enabled: config.http.transport === 'http' || config.http.transport === 'both',
      auth: config.http.auth,
      publicUrl: config.http.publicUrl,
    },
    webhook: {
      enabled: config.webhook.enabled,
      publicUrl: config.webhook.enabled ? config.webhook.publicUrl : null,
    },
    credentialsConfigured: hasConfiguredCredentials(config),
    baseUrl: config.baseUrl,
  };
}
