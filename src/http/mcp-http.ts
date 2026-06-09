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
 * Stateful contract (SDK semantics):
 *   • POST with no `mcp-session-id` and an `initialize` body → mint a new session.
 *   • POST/GET/DELETE with a known `mcp-session-id` → route to that transport.
 *   • Anything else (missing/unknown session on a non-init request) → 400 JSON-RPC.
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

/** A live MCP session: the per-session server and its HTTP transport. */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/** JSON-RPC error response for a request that carries no usable session. */
function noSessionError(res: Parameters<RequestHandler>[1]): void {
  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'No valid session',
    },
    id: null,
  });
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

  // DNS-rebinding protection is only meaningful when at least one allow-list is
  // configured; otherwise the SDK validators have nothing to compare against.
  const enableDnsRebindingProtection =
    httpConfig.allowedHosts.length > 0 || httpConfig.allowedOrigins.length > 0;

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

  async function createSession(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection,
      allowedHosts: httpConfig.allowedHosts.length ? httpConfig.allowedHosts : undefined,
      allowedOrigins: httpConfig.allowedOrigins.length ? httpConfig.allowedOrigins : undefined,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport });
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
            noSessionError(res);
            return;
          }
          await session.transport.handleRequest(req, res, req.body);
          return;
        }

        // No session id: only an `initialize` POST may open one.
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          await createSession(req, res);
          return;
        }

        // Missing/unknown session on a non-init request.
        noSessionError(res);
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
    const transports = [...sessions.values()].map((s) => s.transport);
    sessions.clear();
    await Promise.allSettled(transports.map((t) => t.close()));
  }

  return { handleRequest, closeAll };
}
