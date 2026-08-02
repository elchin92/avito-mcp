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
import type {
  McpServerFactory,
  ProtocolEra,
  ServerCapabilities,
  ServerOptions,
} from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import type { ToolContext } from './core/tool-factory.js';
import { domains } from './meta/domain-registry.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { bindMcpLogger, runWithRequestLogSink, type RequestLogSink } from './logger.js';
import { PACKAGE_NAME, VERSION } from './version.js';
import { hasConfiguredCredentials } from './core/credentials.js';
import { applyLegacyWireDefaults } from './core/wire-compat.js';
import { applyWireErrorShapes } from './core/wire-errors.js';
import { applyListPagination } from './core/pagination.js';

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
 * The same brief, with the two sentences that name a REMOVED method rewritten
 * for revision 2026-07-28.
 *
 * The text is not decoration: it is the only thing that tells the agent this
 * server drives a live production account. But a brief is also a set of
 * instructions the model will follow literally, and `resources/subscribe` does
 * not exist on this era — a modern connection answers it `-32601`. Telling a
 * model to call a method that cannot exist does not fail loudly; it produces an
 * agent that quietly gives up on live updates.
 *
 * Kept as a separate constant rather than a `.replace()` on the legacy string:
 * a substitution would silently produce nonsense the day the legacy wording
 * changes, and the legacy string is frozen by the 1.3.3 wire contract.
 */
export const MODERN_SERVER_INSTRUCTIONS: string =
  'Avito MCP — a server for the live (production) Avito API. Before any write/money/public ' +
  'operation, always confirm the action with a human; in confirmation_mode=money_public ' +
  '(default) the server returns a confirmation_id and requires a meta_confirm_action call. ' +
  'Full reference on the safety modes is in the avito://docs/safety resource. The list of tools ' +
  'with their risk classification is in avito://manifest. Pending actions are in ' +
  'avito://state/pending-actions (open a subscriptions/listen stream with ' +
  'resourceSubscriptions: ["avito://state/pending-actions"] to be notified of changes). ' +
  'Received Avito webhook events (if the receiver is enabled) are in avito://webhook/events ' +
  '(subscribable the same way).';

/** The brief the given era's clients receive. See both constants for why they differ. */
export function serverInstructionsFor(era: ProtocolEra): string {
  return era === 'modern' ? MODERN_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

/**
 * The capability block for one era.
 *
 * ── The `listChanged` decision M2 deferred to M3 ────────────────────────────
 *
 * M2 pinned `tools.listChanged` / `prompts.listChanged` to `true` because that
 * is what 1.3.x advertised (SDK v1 overwrote the declared value the moment a
 * tool was registered; v2 honours the declaration), and narrowing an advertised
 * capability is a client-visible change that does not belong in an SDK bump.
 * The decision itself was left open: EITHER start sending the notifications, OR
 * declare `false`.
 *
 * The decision is `false`, on the modern era only. Reasoning:
 *
 *   • There is nothing to notify ABOUT. The tool, prompt and resource sets are
 *     fixed for the life of a server instance: membership is decided once, at
 *     registration, by `evaluatePolicy` against a configuration that cannot
 *     change without restarting the process. `grep -rn "sendToolListChanged\|
 *     sendPromptListChanged" src/` returns nothing, and there is no code path
 *     that could make it return something without a new feature first.
 *   • On this era the claim is no longer cosmetic. `subscriptions/listen`
 *     narrows the client's requested filter against exactly these bits before
 *     acknowledging it (`honoredSubset` in the SDK's listen router), so
 *     advertising `listChanged: true` makes the server ACK `toolsListChanged`
 *     on a stream that will never carry one. The ack is the client's contract
 *     for what to expect; a client that asked for tool-list updates and was
 *     told "yes" now waits forever instead of polling. Under `false` the same
 *     request is acknowledged with the field absent — an honest "not offered"
 *     the client can act on immediately.
 *   • `resources.subscribe` stays `true`, and `resources.listChanged` stays
 *     `false`, for the same test applied to each: this server DOES emit
 *     `notifications/resources/updated` for two URIs (pending actions, webhook
 *     events) and never emits `notifications/resources/list_changed`.
 *
 * The legacy era keeps `true` verbatim. There the bits feed only the
 * `initialize` result, no client can act on them beyond deciding whether to
 * register a handler, and the M2 contract is byte-identity with 1.3.3 —
 * `test/wire-conformance.test.ts` fails on any change.
 *
 * `logging: {}` is advertised on both. The Logging feature is DEPRECATED by
 * SEP-2577, not removed, and the minimum deprecation window is twelve months;
 * the modern era still delivers `notifications/message` per request when the
 * caller asks for one via `_meta["io.modelcontextprotocol/logLevel"]`.
 */
export function capabilitiesFor(era: ProtocolEra): ServerCapabilities {
  const emitsListChanged = era !== 'modern';
  return {
    logging: {},
    resources: { subscribe: true, listChanged: emitsListChanged },
    prompts: { listChanged: emitsListChanged },
    tools: { listChanged: emitsListChanged },
  };
}

/**
 * M3 item 10 — scopes the pino→MCP log mirror to the request being handled.
 *
 * Installed by wrapping the three PUBLIC registration methods, once, before any
 * domain registers anything — the same technique and the same reasoning as
 * `applyLegacyWireDefaults`: a wrapper at each of the ~160 call sites is one
 * missed call site away from a silent hole, and new domains inherit this for
 * free.
 *
 * Why not the lower `Server.setRequestHandler`, which would be a single seam
 * for every method at once: `McpServer` installs the `tools/*`, `resources/*`
 * and `prompts/*` dispatchers IN ITS CONSTRUCTOR whenever the corresponding
 * capability is declared (`mcp` chunk, `if (options?.capabilities?.tools)
 * this.setToolRequestHandlers()`), so by the time we hold the instance those
 * handlers are already registered and a wrapper on the method would only ever
 * see later registrations. Wrapping the callbacks is the seam that is actually
 * reachable — and it is also the accurate one: the SDK's own list/dispatch
 * handlers produce no log lines, so the only code that can log inside a request
 * is ours.
 *
 * The wrapper decides nothing about log levels. It installs `ctx.mcpReq.log` as
 * the ambient sink and lets the SDK's own implementation apply the rule: no
 * `_meta["io.modelcontextprotocol/logLevel"]` on this request ⇒ nothing is
 * sent; otherwise the notification goes out on this request's own response
 * stream via `ctx.mcpReq.notify`.
 */
function installRequestLogScope(server: McpServer): void {
  type ErasedCallback = (...args: unknown[]) => unknown;
  type ErasedRegister = (...args: unknown[]) => unknown;

  /**
   * The handler context, found by SHAPE rather than by position: the callback
   * signatures differ per primitive (`(args, ctx)`, `(ctx)`, `(uri, ctx)`,
   * `(uri, variables, ctx)`), and a positional assumption would silently pick
   * the wrong argument the day one of them grows a parameter.
   */
  const contextOf = (args: unknown[]): { log?: RequestLogSink['log'] } | undefined => {
    for (let i = args.length - 1; i >= 0; i -= 1) {
      const candidate = (args[i] as { mcpReq?: { log?: RequestLogSink['log'] } } | undefined)
        ?.mcpReq;
      if (candidate !== undefined) return candidate;
    }
    return undefined;
  };

  const wrapCallback = (callback: ErasedCallback): ErasedCallback => {
    return (...args: unknown[]) => {
      const mcpReq = contextOf(args);
      if (mcpReq?.log === undefined) return callback(...args);
      const log = mcpReq.log.bind(mcpReq) as RequestLogSink['log'];
      return runWithRequestLogSink({ log }, () => callback(...args));
    };
  };

  const wrapRegistration = (register: ErasedRegister): ErasedRegister => {
    return (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last !== 'function') return register(...args);
      return register(...args.slice(0, -1), wrapCallback(last as ErasedCallback));
    };
  };

  const target = server as unknown as Record<string, ErasedRegister>;
  for (const method of ['registerTool', 'registerResource', 'registerPrompt'] as const) {
    const original = target[method]!.bind(server);
    target[method] = wrapRegistration(original);
  }
}

/**
 * Builds a fully-registered McpServer (all domains, resources, prompts) wired to
 * the shared context. `baseCtx` provides the singletons; this returns a new
 * server each call with its own per-session ctx.
 */
export function buildMcpServer(
  baseCtx: ToolContext,
  options: { era?: ProtocolEra } = {},
): McpServer {
  // Default `legacy`, deliberately: every construction site that does not name
  // an era — `generate-manifest.ts`, the sessionful HTTP path, the hand-wired
  // stdio connection, and every existing test — is a 2025 site, and a default
  // of `modern` would move their wire without anyone asking.
  const era: ProtocolEra = options.era ?? 'legacy';
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
      // Era-dependent since M3 — see capabilitiesFor() for the listChanged
      // decision and why it is not the same answer on both wires.
      capabilities: capabilitiesFor(era),
      // Delivered by `initialize` on a 2025 connection and by `server/discover`
      // on a 2026 one — the SDK's `_ondiscover()` copies `_instructions` into
      // the discover result. See SERVER_INSTRUCTIONS / MODERN_SERVER_INSTRUCTIONS
      // for why the two eras are handed different text.
      instructions: serverInstructionsFor(era),
      cacheHints: MODERN_CACHE_HINTS,
    },
  );

  // M2: pin the tool-descriptor details v2 changed (JSON Schema dialect and the
  // `execution` field) back to what 1.3.x emitted, before anything registers.
  // The era selects the one pin that is not era-neutral — see the function.
  applyLegacyWireDefaults(server, era);

  // M3 item 10. Modern only: on the legacy era `notifications/message` is a
  // connection-level feature gated by `logging/setLevel`, and re-routing it
  // per request would change a wire this stage is contractually not allowed to
  // touch.
  if (era === 'modern') installRequestLogScope(server);

  // Per-session ctx: shares the singletons in baseCtx, but binds this server so
  // resources/prompts/logging target the right session. `era` travels with it
  // because registration itself differs (resources/subscribe exists on one wire
  // only) and so does request handling (the log mirror's delivery seam).
  const ctx: ToolContext = { ...baseCtx, server, era };

  for (const register of domains) {
    register(server, ctx);
  }
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  // LAST, and it has to be last: these replace the request handlers that are
  // already installed, so anything registered after them would keep the SDK's
  // own shapes. See src/core/wire-errors.ts for what each era gets.
  applyWireErrorShapes(server, era);
  // M4.3, modern era only. Independent of the layer above rather than ordered
  // after it: it wraps the four list methods, which `applyWireErrorShapes`
  // does not touch on this era. See src/core/pagination.ts.
  applyListPagination(server, era);

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
 *
 * M3 item 10 makes that split era-dependent as well. `background: true` means
 * "mirror every pino line to this instance as `notifications/message`, whenever
 * it happens" — which on revision 2026-07-28 is precisely the MUST NOT: the
 * notification would be sent for requests that asked for no log level, and on a
 * stream that is not the one carrying any request's response. So a MODERN
 * instance is never registered as a connection-level sink at all, whatever
 * `background` says. That is not a loss of the audit channel: the modern era
 * delivers it request-scoped through `runWithRequestLogSink` (see
 * `src/core/tool-factory.ts`), which is the only delivery the revision allows.
 */
export function createServerFactory(
  baseCtx: ToolContext,
  options: { background: boolean },
): McpServerFactory {
  return (mcpCtx) => {
    const server = buildMcpServer(baseCtx, { era: mcpCtx.era });
    const unbind =
      mcpCtx.era === 'modern'
        ? (): void => undefined
        : bindMcpLogger(server, { background: options.background });

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
