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
 * stream.
 */
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandler } from 'express';

import type { HttpConfig } from '../config.js';
import { buildMcpServer } from '../build-server.js';
import type { ToolContext } from '../core/tool-factory.js';
import { logger } from '../logger.js';

/** A live MCP session: the per-session server, its HTTP transport, last activity. */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
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

/**
 * Resolves the DNS-rebinding protection setup (exported for tests). Explicit
 * allowlists win. When
 * none are configured we DERIVE them from the public URL and the bind address —
 * protection must default to ON (the MCP spec's Origin-validation MUST; the
 * classic attack is a malicious site rebinding its hostname to 127.0.0.1 and
 * driving a localhost MCP server from the victim's browser). The single case
 * with nothing to derive from — a wildcard bind with no explicit public URL —
 * keeps protection off with a loud warning rather than guessing and locking
 * LAN clients out.
 */
export function resolveRebindingProtection(h: HttpConfig): {
  enabled: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
} {
  if (h.allowedHosts.length > 0 || h.allowedOrigins.length > 0) {
    return {
      enabled: true,
      allowedHosts: h.allowedHosts.length ? h.allowedHosts : undefined,
      allowedOrigins: h.allowedOrigins.length ? h.allowedOrigins : undefined,
    };
  }
  const wildcardBind = h.host === '0.0.0.0' || h.host === '::';
  const explicitPublicUrl = !!process.env.AVITO_MCP_HTTP_PUBLIC_URL?.trim();
  if (wildcardBind && !explicitPublicUrl) {
    logger.warn(
      { host: h.host },
      'DNS-rebinding protection is OFF: wildcard bind with no AVITO_MCP_HTTP_PUBLIC_URL — ' +
        'nothing to derive an allowlist from. Set AVITO_MCP_HTTP_ALLOWED_HOSTS to enable it.',
    );
    return { enabled: false };
  }
  const hosts = new Set<string>();
  const origins = new Set<string>();
  try {
    const pub = new URL(h.publicUrl);
    hosts.add(pub.host);
    origins.add(pub.origin);
  } catch {
    /* unparseable public URL — fall through to the bind-address entries */
  }
  if (!wildcardBind) {
    hosts.add(hostHeader(h.host, h.port));
    origins.add(`http://${hostHeader(h.host, h.port)}`);
  }
  // Local clients address a loopback bind either way.
  hosts.add(`localhost:${h.port}`);
  hosts.add(`127.0.0.1:${h.port}`);
  origins.add(`http://localhost:${h.port}`);
  origins.add(`http://127.0.0.1:${h.port}`);
  return { enabled: true, allowedHosts: [...hosts], allowedOrigins: [...origins] };
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
  const reaper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [sid, session] of sessions) {
      if (session.lastSeenAt < cutoff) {
        logger.info({ sessionId: sid, idleSec: httpConfig.sessionIdleSec }, 'reaping idle mcp http session');
        void session.transport.close().catch(() => dropSession(sid));
      }
    }
  }, 60_000);
  reaper.unref();

  async function createSession(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: rebinding.enabled,
      allowedHosts: rebinding.allowedHosts,
      allowedOrigins: rebinding.allowedOrigins,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport, lastSeenAt: Date.now() });
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
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
          session.lastSeenAt = Date.now();
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        // No session id: only an `initialize` POST may open one.
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          if (sessions.size >= httpConfig.maxSessions) {
            logger.warn({ active: sessions.size, max: httpConfig.maxSessions }, 'mcp http session limit reached');
            res.status(503).json({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Too many concurrent sessions, try again later' },
              id: null,
            });
            return;
          }
          await createSession(req, res);
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

  async function closeAll(): Promise<void> {
    clearInterval(reaper);
    // Snapshot BEFORE clearing: dropSession no-ops once the map is empty, so
    // both halves must be closed explicitly here.
    const snapshot = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(
      snapshot.flatMap((s) => [s.transport.close(), s.server.close()]),
    );
  }

  return { handleRequest, closeAll };
}
