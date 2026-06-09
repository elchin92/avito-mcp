/**
 * v0.9.0: the shared HTTP listener. One Express app hosts whichever subsystems are
 * enabled, routed by path:
 *   - mcpAuthRouter (OAuth 2.1 AS+RS metadata, /authorize, /token, /register) at root
 *   - /mcp           → Streamable HTTP MCP, guarded per AVITO_MCP_HTTP_AUTH
 *   - {webhook.path}/:secret → Avito webhook receiver (runs even in pure stdio mode)
 *   - /healthz       → the same snapshot as `--health`
 *
 * TLS is intentionally NOT handled here: bind 127.0.0.1 and terminate TLS at a
 * reverse proxy (nginx/Caddy) on the domain — see README. The fail-closed security
 * checks (oauth needs an owner password; none needs a loopback host) live here, at
 * start time, so a misconfigured remote server refuses to boot rather than exposing
 * the Avito credentials it holds.
 */
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import type { Config, HttpConfig } from '../config.js';
import type { ToolContext } from '../core/tool-factory.js';
import { logger } from '../logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { createOAuthSubsystem } from './oauth/index.js';
import { createMcpHttpHandler } from './mcp-http.js';
import { createWebhookRouter, secretsMatch } from './webhook.js';

export interface HttpServerHandle {
  url: string;
  /** The actual bound port (differs from config when port 0 was requested, e.g. tests). */
  port: number;
  close(): Promise<void>;
}

/**
 * True only for genuine loopback binds. NB: 0.0.0.0 / :: are wildcards (all
 * interfaces, i.e. publicly reachable) — the OPPOSITE of loopback — so they are
 * deliberately excluded. auth=none is refused on them unless allowNoAuth is set.
 */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Shared-secret bearer guard for AVITO_MCP_HTTP_AUTH=bearer. */
function bearerGuard(tokens: string[]): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const presented = match?.[1]?.trim();
    if (presented && tokens.some((t) => safeEqual(t, presented))) {
      next();
      return;
    }
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="avito-mcp"')
      .json({ error: 'unauthorized', error_description: 'Valid AVITO_MCP_HTTP_AUTH_TOKEN bearer required.' });
  };
}

/**
 * Starts the Express listener. Throws (fail-closed) on an insecure remote config.
 * Only call when the HTTP MCP transport and/or the webhook receiver is enabled.
 */
export async function startHttpServer(baseCtx: ToolContext, config: Config): Promise<HttpServerHandle> {
  const h: HttpConfig = config.http;
  const httpMcpEnabled = h.transport === 'http' || h.transport === 'both';

  const app = express();
  app.disable('x-powered-by');
  // The documented remote setup is a local reverse proxy (nginx/Caddy) doing TLS.
  // Trust exactly that hop so req.ip (rate-limit keying, logs) is the real client
  // address — and ONLY loopback, so a spoofed X-Forwarded-For from a direct
  // connection is never believed.
  app.set('trust proxy', 'loopback');
  // JSON for MCP/DCR; urlencoded for the OAuth /token request and the /authorize
  // consent form (both are application/x-www-form-urlencoded). body-parser's _body
  // guard makes this safe even where the SDK auth handlers also parse.
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ── health probe (always on) ───────────────────────────────────────────────
  // Deliberately minimal: this endpoint is reachable without auth, so it must
  // not describe the deployment (auth scheme, safety mode, URLs, credential
  // state). The rich snapshot stays on the local-only `--health` CLI.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: PACKAGE_NAME, version: VERSION });
  });

  // ── webhook receiver (independent of MCP transport) ─────────────────────────
  if (config.webhook.enabled && baseCtx.webhookStore) {
    app.use(createWebhookRouter(config.webhook, baseCtx.webhookStore));
    logger.info(
      { path: `${config.webhook.path}/<secret>`, publicUrl: config.webhook.publicUrl },
      'Avito webhook receiver mounted',
    );
  }

  // ── remote MCP over Streamable HTTP ─────────────────────────────────────────
  const closers: Array<() => Promise<void>> = [];
  if (httpMcpEnabled) {
    const mcp = createMcpHttpHandler(baseCtx, h);
    closers.push(() => mcp.closeAll());

    let guard: RequestHandler;
    if (h.auth === 'oauth') {
      if (!h.oauthOwnerPassword) {
        throw new Error(
          'AVITO_MCP_HTTP_AUTH=oauth requires AVITO_MCP_OAUTH_OWNER_PASSWORD (the password that ' +
            'gates the /authorize consent step — without it nobody can mint a token and the server is unusable).',
        );
      }
      const oauth = createOAuthSubsystem(h);
      app.use(oauth.router); // mcpAuthRouter must be mounted at the app root
      guard = oauth.requireAuth;
      logger.info({ publicUrl: h.publicUrl }, 'OAuth 2.1 authorization server mounted');
    } else if (h.auth === 'bearer') {
      if (h.authTokens.length === 0) {
        throw new Error('AVITO_MCP_HTTP_AUTH=bearer requires AVITO_MCP_HTTP_AUTH_TOKEN (comma-separated allowed token[s]).');
      }
      guard = bearerGuard(h.authTokens);
      logger.warn('HTTP MCP using shared-secret bearer auth (AVITO_MCP_HTTP_AUTH=bearer)');
    } else {
      // auth === 'none'
      if (!isLoopback(h.host) && !h.allowNoAuth) {
        throw new Error(
          `AVITO_MCP_HTTP_AUTH=none is refused on non-loopback host ${h.host}: this would expose the ` +
            'Avito credentials unauthenticated. Use oauth/bearer, or set AVITO_MCP_HTTP_ALLOW_NO_AUTH=1 to override.',
        );
      }
      guard = (_req, _res, next) => next();
      logger.warn({ host: h.host }, 'HTTP MCP running WITHOUT authentication (AVITO_MCP_HTTP_AUTH=none)');
    }

    app.all('/mcp', guard, mcp.handleRequest);
  }

  // ── uniform 404 + error contract ─────────────────────────────────────────────
  // Catch-all 404: byte-identical to the webhook route's wrong-secret answer, so
  // a probe can't distinguish "receiver exists, wrong secret" from "no receiver
  // here" (Express' default HTML 404 differs in content-type and headers).
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  // Final error handler. Without one, Express answers a body-parse failure with
  // its default HTML page — a full stack trace in development mode. Two contracts:
  //   • a genuine Avito delivery (correct secret in the path) is ALWAYS answered
  //     200 even if the body was malformed, so Avito never retries/disables us;
  //   • everything else gets a terse JSON status with no internals.
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const status =
      typeof (err as { status?: unknown })?.status === 'number' &&
      (err as { status: number }).status >= 400 &&
      (err as { status: number }).status < 600
        ? (err as { status: number }).status
        : 500;
    const w = config.webhook;
    if (w.enabled && w.secret) {
      const prefix = `${w.path}/`;
      if (req.path.startsWith(prefix) && secretsMatch(req.path.slice(prefix.length), w.secret)) {
        logger.warn({ err: (err as Error)?.message }, 'webhook delivery error (answered 200 anyway)');
        if (!res.headersSent) res.status(200).json({ ok: true });
        return;
      }
    }
    logger.warn({ err: (err as Error)?.message, path: req.path, status }, 'http request error');
    if (!res.headersSent) {
      res.status(status).json({ error: status === 400 ? 'bad_request' : 'error' });
    } else {
      res.end();
    }
  };
  app.use(errorHandler);

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const s = app.listen(h.port, h.host, () => resolve(s));
    s.on('error', reject);
  });

  logger.info(
    {
      host: h.host,
      port: h.port,
      auth: httpMcpEnabled ? h.auth : 'n/a',
      httpMcp: httpMcpEnabled,
      webhook: config.webhook.enabled,
      publicUrl: h.publicUrl,
    },
    'avito-mcp HTTP listener started',
  );

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : h.port;

  return {
    url: `http://${h.host}:${boundPort}`,
    port: boundPort,
    close: async () => {
      for (const c of closers) await c().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
