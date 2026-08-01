/**
 * v0.9.0: Streamable HTTP MCP session manager.
 * M3.3: plus the modern (2026-07-28) leg, mounted only when
 * `AVITO_MCP_PROTOCOL_ERA` asks for it.
 *
 * ── Era routing (M3.3) ──────────────────────────────────────────────────────
 * `AVITO_MCP_PROTOCOL_ERA=legacy` (the default) returns EXACTLY the handler
 * below and nothing else: no `createMcpHandler`, no classification step, no
 * extra `await` on the hot path. That is deliberate — the acceptance criterion
 * for M3 is that the flag-off process is indistinguishable from M2, and the
 * cheapest way to guarantee that is for the second path not to exist.
 *
 * `dual` puts the SDK's own `classifyInboundRequest` in front: it is the very
 * code `createMcpHandler` runs to make its routing decision (and the code the
 * exported `isLegacyRequest` predicate delegates to), so a hand-wired split
 * cannot disagree with the entry about what "legacy" means. Requests it calls
 * legacy go to the sessionful manager below, unchanged; everything else —
 * including the modern path's own validation-ladder rejections (`-32602`,
 * `-32020`, unsupported-version) — goes to the modern handler, which owns those
 * answers. `modern` mounts only the modern leg and lets it refuse 2025-era
 * traffic (`legacy: 'reject'`).
 *
 * Two answers are OURS rather than the SDK's, because the SDK does not produce
 * them: the `Allow` header on the modern era's `405` (`modernMethodNotAllowed`)
 * and the `-32020` for a modern request that omits `MCP-Protocol-Version`
 * (`missingProtocolVersionHeader`). Both are documented at their definitions.
 *
 * Mounted by the HTTP server on the /mcp route (POST/GET/DELETE). Maintains one
 * StreamableHTTPServerTransport + McpServer per MCP session, keyed by the session
 * id the SDK mints during `initialize`. The heavy singletons (AvitoClient, the
 * pending/idempotency/webhook stores) live in the shared `baseCtx`; each session
 * gets its own McpServer via buildMcpServer so many clients can connect at once
 * without duplicating the Avito client or token cache.
 *
 * Stateful contract (SDK semantics + Streamable HTTP spec):
 *   • POST with no `mcp-session-id` and an `initialize` body → mint a new session
 *     (subject to the AVITO_MCP_HTTP_MAX_SESSIONS cap → 503 above it).
 *   • POST/GET/DELETE with a known `mcp-session-id` → route to that transport.
 *   • Missing session id on a non-init request → 400 JSON-RPC.
 *   • UNKNOWN session id → 404 (spec-mandated; clients re-initialize on it).
 *   • Sessions idle past AVITO_MCP_HTTP_SESSION_IDLE_SEC are reaped.
 *
 * Express applies express.json() upstream, so req.body is already parsed; we pass
 * it as the 3rd arg to handleRequest so the transport doesn't try to re-read the
 * stream. Rebinding protection is always enabled; startup fails when complete
 * Host and Origin allowlists cannot be derived.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  classifyInboundRequest,
  createMcpHandler,
  isInitializeRequest,
} from '@modelcontextprotocol/server';
import type {
  InboundClassificationOutcome,
  McpHttpHandler,
  McpServer,
  AuthInfo,
} from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import type { RequestHandler } from 'express';
import type { HttpConfig, ProtocolEraMode } from '../config.js';
import { buildMcpServer, createServerFactory } from '../build-server.js';
import type { ToolContext } from '../core/tool-factory.js';
import { bindMcpLogger, logger, runWithMcpLogger } from '../logger.js';
import { MODERN_PROTOCOL_VERSION } from '../version.js';

/** A live MCP session: the per-session server, its HTTP transport, last activity. */
interface Session {
  server: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  lastSeenAt: number;
  activeRequests: number;
  principal: string;
  unbindLogger: () => void;
}

/** 400: request carries no session id where one is required. */
function missingSessionError(res: Parameters<RequestHandler>[1]): void {
  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Bad Request: Mcp-Session-Id header is required',
    },
    id: null,
  });
}

/**
 * 404: session id present but unknown (terminated, reaped, or lost to a server
 * restart). The Streamable HTTP spec mandates 404 here — clients react to it by
 * re-initializing with a fresh session, so a 400 would leave them wedged.
 */
function unknownSessionError(res: Parameters<RequestHandler>[1]): void {
  res.status(404).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Session not found',
    },
    id: null,
  });
}

/**
 * The JSON-RPC error code SEP-2243 assigns to "the mirrored headers and the
 * body disagree". Declared here because the SDK keeps it internal: it is
 * reachable only through `classifyInboundRequest`'s rejection objects, which
 * is fine for the cells the SDK checks itself but not for the one it leaves to
 * the server (see `missingProtocolVersionHeader`).
 *
 * `test/modern-conformance.test.ts` pins this number against a rejection the
 * SDK produces, so the two can never drift apart.
 */
const HEADER_MISMATCH_ERROR_CODE = -32020;

/** Single-valued header lookup; Node lowercases names, so field-name case is already handled. */
function headerValue(req: Parameters<RequestHandler>[0], name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined ? undefined : value;
}

/**
 * Whether a body-less request identifies itself as modern-era traffic.
 *
 * Only consulted for GET/DELETE (and other non-POST methods), where there is no
 * body for the SDK's body-primary classifier to read — it can only answer
 * `legacy / http-method` for every one of them, which under `dual` would hand a
 * 2026 client's GET to the 2025 session manager and answer it `400 Mcp-Session-Id
 * header is required` instead of the `405` the revision asks for.
 *
 * Deliberately NOT used for POST: on POST the era comes from the body envelope
 * (the SDK's rule), and `MCP-Protocol-Version` is not an era signal there — the
 * header is mandatory on 2025-11-25 too, so branching on its presence would
 * misroute every legacy POST.
 */
function namesModernRevision(value: string | undefined): boolean {
  return value !== undefined && value.trim() === MODERN_PROTOCOL_VERSION;
}

/**
 * `405` for the modern era, WITH the `Allow` header the spec's SHOULD asks for.
 *
 * The SDK's own modern-only refusal (`modernOnlyStrictRejection`, cell
 * `modern-only-method-not-allowed`) produces the right status and the right
 * JSON-RPC body but no `Allow` header — `rejectionResponse` builds a bare
 * `Response.json(..., { status })`. So this answer is ours, and the modern
 * branch never delegates a non-POST to the SDK.
 *
 * `Allow: POST` and not `GET, POST, DELETE`: the value states what the ERA this
 * caller is speaking allows, and 2026-07-28 removed both the GET stream and the
 * DELETE session teardown. Under `dual` the endpoint does still answer GET and
 * DELETE — for 2025 callers, who reach the legacy branch and never see this.
 */
function modernMethodNotAllowed(res: Parameters<RequestHandler>[1]): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
}

/**
 * `-32020` for a modern request that omits `MCP-Protocol-Version`.
 *
 * This is the ONE cell of the SEP-2243 header matrix the SDK does not cover.
 * `validateStandardRequestHeaders` enforces `Mcp-Method` (presence) and
 * `Mcp-Name` (presence, sentinel decoding, agreement with `params.name`/`.uri`),
 * and `classifyInboundRequest` enforces header↔body agreement for
 * `MCP-Protocol-Version` and `Mcp-Method` — but nothing rejects a request that
 * simply omits the version header, because the classifier reads the era out of
 * the body envelope and no longer needs it. The spec is explicit that it is
 * still required: "Every POST request to the MCP endpoint MUST include an
 * `MCP-Protocol-Version` header", and a server that does not serve pre-2025-06-18
 * clients "MUST reject a request without the header per Server Validation".
 *
 * Shaped exactly like the SDK's own missing-header rejections (`crossCheckMismatch`,
 * cell `method-header-missing`), so a client cannot tell which of the three
 * headers it forgot apart by the error's structure.
 */
function missingProtocolVersionHeader(
  res: Parameters<RequestHandler>[1],
  id: string | number | null,
  method: string,
): void {
  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: HEADER_MISMATCH_ERROR_CODE,
      message:
        'Bad Request: the request headers and body disagree: the body names method ' +
        `${method} but the required MCP-Protocol-Version header is absent`,
      data: {
        mismatch: {
          header: '(missing)',
          body: `the body names method ${method} but the required MCP-Protocol-Version header is absent`,
        },
      },
    },
    id,
  });
}

/** Host header form for an address: IPv6 literals need brackets. */
function hostHeader(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function normalizeAllowedHost(value: string): string {
  try {
    if (!value || value.trim() !== value || value.includes('*')) throw new Error('invalid host');
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('host must not contain credentials, a path, query or fragment');
    }
    return parsed.host;
  } catch (err) {
    throw new Error(`Invalid AVITO_MCP_HTTP_ALLOWED_HOSTS entry: ${value}`, { cause: err });
  }
}

function normalizeAllowedOrigin(value: string): { origin: string; host: string } {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('origin must be an HTTP(S) scheme + authority only');
    }
    return { origin: parsed.origin, host: parsed.host };
  } catch (err) {
    throw new Error(`Invalid AVITO_MCP_HTTP_ALLOWED_ORIGINS entry: ${value}`, { cause: err });
  }
}

/**
 * Resolves the DNS-rebinding protection setup (exported for tests). Explicit
 * allowlists win. When
 * none are configured we DERIVE them from the public URL and the bind address —
 * protection must default to ON (the MCP spec's Origin-validation MUST; the
 * classic attack is a malicious site rebinding its hostname to 127.0.0.1 and
 * driving a localhost MCP server from the victim's browser). A wildcard bind
 * without a usable public URL or complete explicit lists fails startup.
 */
export function resolveRebindingProtection(h: HttpConfig): {
  enabled: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
} {
  const wildcardBind = h.host === '0.0.0.0' || h.host === '::';
  const hosts = new Set<string>();
  const origins = new Set<string>();
  const explicitHosts = h.allowedHosts.map(normalizeAllowedHost);
  const explicitOrigins = h.allowedOrigins.map(normalizeAllowedOrigin);
  try {
    const pub = new URL(h.publicUrl);
    if (pub.protocol !== 'http:' && pub.protocol !== 'https:') {
      throw new Error('public URL must use HTTP(S)');
    }
    if (pub.hostname !== '0.0.0.0' && pub.hostname !== '[::]' && pub.hostname !== '::') {
      hosts.add(pub.host);
      origins.add(pub.origin);
    }
  } catch (err) {
    throw new Error(`Invalid AVITO_MCP_HTTP_PUBLIC_URL: ${(err as Error).message}`, { cause: err });
  }
  if (!wildcardBind) {
    hosts.add(hostHeader(h.host, h.port));
    origins.add(`http://${hostHeader(h.host, h.port)}`);
  }
  if (isLoopbackBind(h.host)) {
    hosts.add(`localhost:${h.port}`);
    hosts.add(`127.0.0.1:${h.port}`);
    origins.add(`http://localhost:${h.port}`);
    origins.add(`http://127.0.0.1:${h.port}`);
  }

  // An explicit origin can safely supply its own Host counterpart. The reverse
  // is not true because a Host value does not say whether its origin is HTTP or
  // HTTPS, so explicit hosts alone still require a derivable public URL/origin.
  if (explicitHosts.length === 0) {
    for (const { host } of explicitOrigins) hosts.add(host);
  }

  const allowedHosts = explicitHosts.length > 0 ? [...new Set(explicitHosts)] : [...hosts];
  const allowedOrigins =
    explicitOrigins.length > 0
      ? [...new Set(explicitOrigins.map(({ origin }) => origin))]
      : [...origins];
  if (allowedHosts.length === 0 || allowedOrigins.length === 0) {
    throw new Error(
      'DNS-rebinding protection cannot derive both Host and Origin allowlists. ' +
        'Set AVITO_MCP_HTTP_PUBLIC_URL to the external URL or configure both ' +
        'AVITO_MCP_HTTP_ALLOWED_HOSTS and AVITO_MCP_HTTP_ALLOWED_ORIGINS.',
    );
  }
  return { enabled: true, allowedHosts, allowedOrigins };
}

function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Stable, non-secret identity used to bind a session to its authenticated caller. */
function requestPrincipal(req: Parameters<RequestHandler>[0]): string {
  const auth = (req as typeof req & { auth?: AuthInfo }).auth;
  if (auth) {
    return `oauth:${auth.clientId}:${auth.resource?.href ?? ''}`;
  }
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1]) {
    return `bearer:${createHash('sha256').update(match[1]).digest('base64url')}`;
  }
  return 'anonymous';
}

/**
 * Builds the Express handler for the Streamable HTTP MCP endpoint plus a
 * `closeAll()` for graceful shutdown. The handler is transport-agnostic about the
 * HTTP method: it inspects the `mcp-session-id` header and the body to decide
 * whether to open a new session, route to an existing one, or reject.
 */
export function createMcpHttpHandler(
  baseCtx: ToolContext,
  httpConfig: HttpConfig,
  protocolEra: ProtocolEraMode = 'legacy',
): { handleRequest: RequestHandler; closeAll(): Promise<void> } {
  const sessions = new Map<string, Session>();
  const initializations = new Set<Promise<void>>();
  let initializingSessions = 0;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;

  const rebinding = resolveRebindingProtection(httpConfig);
  if (rebinding.enabled) {
    logger.info(
      { allowedHosts: rebinding.allowedHosts, allowedOrigins: rebinding.allowedOrigins },
      'mcp http DNS-rebinding protection active',
    );
  }

  /** Drop a session from the map and best-effort close its server. */
  function dropSession(sid: string): void {
    const existing = sessions.get(sid);
    if (!existing) return;
    sessions.delete(sid);
    existing.unbindLogger();
    logger.debug({ sessionId: sid, active: sessions.size }, 'mcp http session closed');
    // The transport is already closing (that's why we're here); close the server
    // so its resources/subscriptions are released. Errors here are non-fatal.
    void existing.server.close().catch((err) => {
      logger.warn({ err, sessionId: sid }, 'error closing mcp server for session');
    });
  }

  // Reap sessions whose client vanished without a DELETE (crash, sleep, network
  // change): without this each abandoned session pins a full McpServer forever.
  // transport.close() fires onclose → dropSession, releasing both halves.
  const idleMs = httpConfig.sessionIdleSec * 1000;
  const reaper = setInterval(
    () => {
      const cutoff = Date.now() - idleMs;
      for (const [sid, session] of sessions) {
        if (session.activeRequests === 0 && session.lastSeenAt < cutoff) {
          logger.info(
            { sessionId: sid, idleSec: httpConfig.sessionIdleSec },
            'reaping idle mcp http session',
          );
          void session.transport.close().catch(() => dropSession(sid));
        }
      }
    },
    Math.min(60_000, Math.max(1_000, idleMs)),
  );
  reaper.unref();

  async function createSession(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): Promise<void> {
    const principal = requestPrincipal(req);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: rebinding.enabled,
      allowedHosts: rebinding.allowedHosts,
      allowedOrigins: rebinding.allowedOrigins,
      onsessioninitialized: (sid) => {
        sessions.set(sid, {
          server,
          transport,
          lastSeenAt: Date.now(),
          activeRequests: 1,
          principal,
          unbindLogger: () => undefined,
        });
        logger.debug({ sessionId: sid, active: sessions.size }, 'mcp http session initialized');
      },
      onsessionclosed: (sid) => {
        dropSession(sid);
      },
    });

    // Also clean up if the transport closes for any other reason (client
    // disconnect, error, shutdown) — onsessionclosed only fires on DELETE.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) dropSession(sid);
    };

    const server = buildMcpServer(baseCtx);
    const unbindLogger = bindMcpLogger(server, { background: false });
    try {
      await runWithMcpLogger(server, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
      // A malformed initialize can be answered without creating a session. Do
      // not leave its connected server/transport resident.
      const sessionId = transport.sessionId;
      if (!sessionId) {
        unbindLogger();
        await Promise.allSettled([transport.close(), server.close()]);
      } else {
        const session = sessions.get(sessionId);
        if (session) {
          session.unbindLogger = unbindLogger;
          session.activeRequests = Math.max(0, session.activeRequests - 1);
          session.lastSeenAt = Date.now();
        } else {
          unbindLogger();
        }
      }
    } catch (err) {
      unbindLogger();
      await Promise.allSettled([transport.close(), server.close()]);
      throw err;
    }
  }

  const handleLegacyRequest: RequestHandler = (req, res, next) => {
    void (async () => {
      try {
        const sessionId = req.headers['mcp-session-id'];
        const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

        // Existing session: route every method (POST/GET/DELETE) to its transport.
        if (sid) {
          const session = sessions.get(sid);
          if (!session) {
            unknownSessionError(res);
            return;
          }
          if (session.principal !== requestPrincipal(req)) {
            logger.warn({ sessionId: sid }, 'mcp http session principal mismatch');
            // Use the same answer as an unknown ID so a foreign principal cannot
            // use the endpoint as a session-existence oracle.
            unknownSessionError(res);
            return;
          }
          session.lastSeenAt = Date.now();
          session.activeRequests += 1;
          try {
            await runWithMcpLogger(session.server, () =>
              session.transport.handleRequest(req, res, req.body),
            );
          } finally {
            session.activeRequests = Math.max(0, session.activeRequests - 1);
            session.lastSeenAt = Date.now();
          }
          return;
        }

        // No session id: only an `initialize` POST may open one.
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          if (closing || sessions.size + initializingSessions >= httpConfig.maxSessions) {
            logger.warn(
              {
                active: sessions.size,
                initializing: initializingSessions,
                max: httpConfig.maxSessions,
              },
              'mcp http session limit reached',
            );
            res.status(503).json({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Too many concurrent sessions, try again later' },
              id: null,
            });
            return;
          }
          // Reserve synchronously, before createSession reaches its first await.
          // Without this, concurrent initialize calls all observe the same size.
          initializingSessions += 1;
          const initialization = createSession(req, res);
          initializations.add(initialization);
          try {
            await initialization;
          } finally {
            initializations.delete(initialization);
            initializingSessions -= 1;
          }
          return;
        }

        // Missing session id on a non-initialize request.
        missingSessionError(res);
      } catch (err) {
        logger.error({ err }, 'mcp http request handling failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        } else {
          // Response already partially written (e.g. SSE stream): hand off to
          // Express' default error handler, which will tear down the connection.
          next(err);
        }
      }
    })();
  };

  // ── modern (2026-07-28) leg — M3.3 ─────────────────────────────────────────
  // Constructed only when the operator asked for it. `legacy: 'reject'` because
  // WE own the legacy routing (via isLegacyRequest) and hand this entry only the
  // traffic it must answer; leaving the default `'stateless'` would give the SDK
  // a second, session-less 2025 implementation running beside the real one.
  let modern: McpHttpHandler | undefined;
  let modernNodeHandler: ReturnType<typeof toNodeHandler> | undefined;
  if (protocolEra !== 'legacy') {
    modern = createMcpHandler(createServerFactory(baseCtx, { background: false }), {
      legacy: 'reject',
      onerror: (err) => logger.warn({ err, era: 'modern' }, 'mcp http modern handler error'),
    });
    modernNodeHandler = toNodeHandler(modern, {
      onerror: (err) => logger.error({ err, era: 'modern' }, 'mcp http modern adapter error'),
    });
  }

  /**
   * Era dispatcher. Only reachable when `protocolEra !== 'legacy'` — the legacy
   * default returns `handleLegacyRequest` itself, so the default deployment does
   * not even execute this function.
   *
   * The era decision comes from `classifyInboundRequest`, the SDK's own routing
   * step exported as a building block ("Power users composing transport-neutral
   * routing can also use the exported building blocks directly:
   * `classifyInboundRequest` for the era decision"). It is the same function the
   * `isLegacyRequest` predicate delegates to — `isLegacyRequest` is literally
   * `classifyEntryRequest(...).outcome.kind === 'legacy'` — so our split still
   * cannot disagree with what `createMcpHandler` would decide. Calling the
   * classifier directly buys three things the predicate cannot give:
   *
   *   • the routed message, so a rejection can echo the request `id`;
   *   • `messageKind`, so the version-header rule applies to requests only
   *     (the revision explicitly leaves notification-POST header requirements
   *     undefined);
   *   • no `toWebRequest` clone and no extra `await` on the hot path.
   *
   * `test/modern-conformance.test.ts` asserts the two agree across a matrix, so
   * the substitution is checked rather than assumed.
   */
  const dispatchByEra: RequestHandler = (req, res, next) => {
    void (async () => {
      try {
        const httpMethod = req.method.toUpperCase();
        const protocolVersionHeader = headerValue(req, 'mcp-protocol-version');

        // Body-less methods: the classifier has nothing to read, so the era can
        // only come from the version header. `modern` has no 2025 session
        // operations at all, hence the unconditional 405 there.
        if (httpMethod !== 'POST') {
          if (protocolEra === 'modern' || namesModernRevision(protocolVersionHeader)) {
            modernMethodNotAllowed(res);
            return;
          }
          handleLegacyRequest(req, res, next);
          return;
        }

        const mcpMethodHeader = headerValue(req, 'mcp-method');
        const mcpNameHeader = headerValue(req, 'mcp-name');
        const route: InboundClassificationOutcome = classifyInboundRequest({
          httpMethod,
          ...(protocolVersionHeader !== undefined ? { protocolVersionHeader } : {}),
          ...(mcpMethodHeader !== undefined ? { mcpMethodHeader } : {}),
          ...(mcpNameHeader !== undefined ? { mcpNameHeader } : {}),
          ...(req.body !== undefined ? { body: req.body as unknown } : {}),
        });

        // `reject` outcomes belong to the modern leg: they ARE its answers
        // (-32602 for a malformed envelope, -32020 for a header/body mismatch),
        // and the SDK re-derives the identical rejection when the request
        // reaches it. Only `legacy` goes to the 2025 manager — and only in
        // `dual`; under `modern` the SDK owns the refusal (-32022 naming what
        // we do serve), which is not something to reimplement here.
        if (route.kind === 'legacy') {
          if (protocolEra === 'dual') {
            handleLegacyRequest(req, res, next);
            return;
          }
          await modernNodeHandler!(req, res, req.body);
          return;
        }

        if (
          route.kind === 'modern' &&
          route.messageKind === 'request' &&
          protocolVersionHeader === undefined
        ) {
          missingProtocolVersionHeader(res, route.message.id, route.message.method);
          return;
        }

        await modernNodeHandler!(req, res, req.body);
      } catch (err) {
        logger.error({ err }, 'mcp http era dispatch failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        } else {
          next(err);
        }
      }
    })();
  };

  // The legacy default is the ORIGINAL handler by identity, not a wrapper around
  // it: no added await, no added branch, nothing that could behave differently
  // under load than the M2 build did.
  const handleRequest: RequestHandler =
    protocolEra === 'legacy' ? handleLegacyRequest : dispatchByEra;

  function closeAll(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      clearInterval(reaper);
      await Promise.allSettled([...initializations]);
      // Snapshot BEFORE clearing: dropSession no-ops once the map is empty, so
      // both halves must be closed explicitly here.
      const snapshot = [...sessions.values()];
      sessions.clear();
      for (const session of snapshot) session.unbindLogger();
      await Promise.allSettled([
        ...snapshot.flatMap((s) => [s.transport.close(), s.server.close()]),
        // Aborts in-flight modern exchanges and closes their per-request
        // instances; a no-op when the modern leg was never mounted.
        ...(modern ? [modern.close()] : []),
      ]);
    })();
    return shutdownPromise;
  }

  return { handleRequest, closeAll };
}
