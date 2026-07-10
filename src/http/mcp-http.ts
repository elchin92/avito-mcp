/**
 * v0.9.0: Streamable HTTP MCP session manager.
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

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import type { HttpConfig } from '../config.js';
import { buildMcpServer } from '../build-server.js';
import type { ToolContext } from '../core/tool-factory.js';
import { bindMcpLogger, logger, runWithMcpLogger } from '../logger.js';

/** A live MCP session: the per-session server, its HTTP transport, last activity. */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
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
    const transport = new StreamableHTTPServerTransport({
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

  const handleRequest: RequestHandler = (req, res, next) => {
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
      await Promise.allSettled(snapshot.flatMap((s) => [s.transport.close(), s.server.close()]));
    })();
    return shutdownPromise;
  }

  return { handleRequest, closeAll };
}
