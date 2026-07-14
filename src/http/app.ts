/**
 * v0.9.0: the shared HTTP listener. One Express app hosts whichever subsystems are
 * enabled, routed by path:
 *   - mcpAuthRouter (OAuth 2.1 AS+RS metadata, /authorize, /token, /register) at root
 *   - /mcp           → Streamable HTTP MCP, guarded per AVITO_MCP_HTTP_AUTH
 *   - {webhook.path}/:secret → Avito webhook receiver (runs even in pure stdio mode)
 *   - /healthz       → minimal unauthenticated liveness/version response
 *   - /readyz        → minimal readiness bit
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
import { hasConfiguredCredentials } from '../core/credentials.js';
import { isRuntimeStateReady, runtimeStateDirectory } from '../core/runtime-state.js';
import { logger } from '../logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { createOAuthSubsystem } from './oauth/index.js';
import { createMcpHttpHandler, resolveRebindingProtection } from './mcp-http.js';
import { createWebhookRouter } from './webhook.js';

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
    res.status(401).set('WWW-Authenticate', 'Bearer realm="avito-mcp"').json({
      error: 'unauthorized',
      error_description: 'Valid AVITO_MCP_HTTP_AUTH_TOKEN bearer required.',
    });
  };
}

/** Protects OAuth/DCR and MCP routes, not just the SDK transport endpoint. */
function rebindingGuard(config: HttpConfig): RequestHandler {
  const protection = resolveRebindingProtection(config);
  return (req, res, next) => {
    let host: string | undefined;
    try {
      host = req.headers.host ? new URL(`http://${req.headers.host}`).host : undefined;
    } catch {
      host = undefined;
    }
    if (!host || !protection.allowedHosts.includes(host)) {
      res.status(403).json({ error: 'forbidden', error_description: 'Invalid Host header' });
      return;
    }

    const rawOrigin = req.headers.origin;
    if (rawOrigin) {
      let origin: string | undefined;
      try {
        const parsed = new URL(rawOrigin);
        if (parsed.pathname === '/' && !parsed.search && !parsed.hash) origin = parsed.origin;
      } catch {
        origin = undefined;
      }
      if (!origin || !protection.allowedOrigins.includes(origin)) {
        res.status(403).json({ error: 'forbidden', error_description: 'Invalid Origin header' });
        return;
      }
    }
    next();
  };
}

/**
 * Starts the Express listener. Throws (fail-closed) on an insecure remote config.
 * Only call when the HTTP MCP transport and/or the webhook receiver is enabled.
 */
export async function startHttpServer(
  baseCtx: ToolContext,
  config: Config,
): Promise<HttpServerHandle> {
  const h: HttpConfig = config.http;
  const httpMcpEnabled = h.transport === 'http' || h.transport === 'both';

  const app = express();
  let closing = false;
  let oauthReady: (() => boolean) | undefined;
  app.disable('x-powered-by');
  // The documented remote setup is a local reverse proxy (nginx/Caddy) doing TLS.
  // Trust exactly that hop so req.ip (rate-limit keying, logs) is the real client
  // address — and ONLY loopback, so a spoofed X-Forwarded-For from a direct
  // connection is never believed.
  app.set('trust proxy', 'loopback');
  // ── health probe (always on) ───────────────────────────────────────────────
  // Deliberately minimal: this endpoint is reachable without auth, so it must
  // not describe the deployment (auth scheme, safety mode, URLs, credential
  // state). The rich snapshot stays on the local-only `--health` CLI.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: PACKAGE_NAME, version: VERSION });
  });
  // Readiness deliberately exposes one bit only. Config has already been parsed
  // if this handler exists; a persistent OAuth store proved its directory/lease
  // at construction and reports false once durable shutdown starts.
  app.get('/readyz', async (_req, res) => {
    const apiReady =
      !httpMcpEnabled ||
      (hasConfiguredCredentials(config) && (await baseCtx.client.tokenStore.isStorageReady()));
    const runtimeReady = await isRuntimeStateReady(runtimeStateDirectory(config));
    const webhookReady = baseCtx.webhookStore?.isReady() ?? true;
    const ready = !closing && apiReady && runtimeReady && webhookReady && (oauthReady?.() ?? true);
    res.status(ready ? 200 : 503).json({ ok: ready });
  });

  // ── webhook receiver (independent of MCP transport) ─────────────────────────
  if (config.webhook.enabled && baseCtx.webhookStore) {
    if (!config.webhook.secret || Buffer.byteLength(config.webhook.secret, 'utf8') < 32) {
      throw new Error(
        'AVITO_MCP_WEBHOOK_SECRET must contain at least 32 bytes from a cryptographically secure generator',
      );
    }
    app.use(createWebhookRouter(config.webhook, baseCtx.webhookStore));
    logger.info(
      { path: `${config.webhook.path}/<secret>`, publicUrl: config.webhook.publicUrl },
      'Avito webhook receiver mounted',
    );
  }

  // ── remote MCP over Streamable HTTP ─────────────────────────────────────────
  const preServerClosers: Array<() => Promise<void>> = [];
  const postServerClosers: Array<() => Promise<void>> = [];
  if (baseCtx.webhookStore) postServerClosers.push(() => baseCtx.webhookStore!.flush());
  if (httpMcpEnabled) {
    app.use(rebindingGuard(h));
    let guard: RequestHandler;
    let closeOAuth: (() => Promise<void>) | undefined;
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
      oauthReady = () => oauth.provider.isReady();
      closeOAuth = () => oauth.close();
      logger.info({ publicUrl: h.publicUrl }, 'OAuth 2.1 authorization server mounted');
    } else if (h.auth === 'bearer') {
      if (h.authTokens.length === 0) {
        throw new Error(
          'AVITO_MCP_HTTP_AUTH=bearer requires AVITO_MCP_HTTP_AUTH_TOKEN (comma-separated allowed token[s]).',
        );
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
      logger.warn(
        { host: h.host },
        'HTTP MCP running WITHOUT authentication (AVITO_MCP_HTTP_AUTH=none)',
      );
    }

    let mcp: ReturnType<typeof createMcpHttpHandler>;
    try {
      mcp = createMcpHttpHandler(baseCtx, h);
    } catch (err) {
      await closeOAuth?.().catch(() => undefined);
      throw err;
    }
    preServerClosers.push(() => mcp.closeAll());
    if (closeOAuth) postServerClosers.push(closeOAuth);
    // Authenticate before parsing a potentially multi-megabyte MCP request.
    app.all('/mcp', guard, express.json({ limit: '4mb' }), mcp.handleRequest);
  }

  // ── uniform 404 + error contract ─────────────────────────────────────────────
  // Catch-all 404 stays terse JSON. The mounted webhook route deliberately
  // returns a uniform 200 for valid and invalid secret candidates.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  // Final error handler. Webhook body failures are handled inside its router so
  // this generic path never needs to inspect or compare a secret URL.
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const status =
      typeof (err as { status?: unknown })?.status === 'number' &&
      (err as { status: number }).status >= 400 &&
      (err as { status: number }).status < 600
        ? (err as { status: number }).status
        : 500;
    logger.warn({ err: (err as Error)?.message, path: req.path, status }, 'http request error');
    if (!res.headersSent) {
      res.status(status).json({ error: status === 400 ? 'bad_request' : 'error' });
    } else {
      res.end();
    }
  };
  app.use(errorHandler);

  const server = await new Promise<HttpServer>((resolve, reject) => {
    // Express 5 invokes the listen callback with an Error on bind failure.
    // Ignoring that argument incorrectly resolves startup before the `error`
    // event is observed.
    const s = app.listen(h.port, h.host, (err?: Error) => (err ? reject(err) : resolve(s)));
    s.on('error', reject);
  }).catch(async (err: unknown) => {
    // A bind failure happens after MCP reapers and possibly an OAuth file lease
    // have been created. Release both before propagating the startup error.
    closing = true;
    await Promise.allSettled([
      ...preServerClosers.map((close) => close()),
      ...postServerClosers.map((close) => close()),
    ]);
    throw err;
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

  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${h.host}:${boundPort}`,
    port: boundPort,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        // Stop accepting new work first. The callback waits for existing HTTP
        // requests, so close MCP transports next to release long-lived SSE.
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        let firstError: unknown;
        for (const close of preServerClosers) {
          try {
            await close();
          } catch (err) {
            firstError ??= err;
          }
        }
        try {
          await serverClosed;
        } catch (err) {
          firstError ??= err;
        }
        // No OAuth request can mutate the store after serverClosed resolves.
        for (const close of postServerClosers) {
          try {
            await close();
          } catch (err) {
            firstError ??= err;
          }
        }
        if (firstError) throw firstError;
      })();
      return closePromise;
    },
  };
}
