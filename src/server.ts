#!/usr/bin/env node
import type { ToolContext } from './core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from './version.js';

function printHelp(): void {
  process.stdout.write(
    `${PACKAGE_NAME} ${VERSION}\n` +
      `\n` +
      `Universal MCP server for the Avito API.\n` +
      `\n` +
      `Usage:\n` +
      `  avito-mcp                  Start the MCP stdio server (default)\n` +
      `  avito-mcp --http           Start the remote Streamable HTTP server (OAuth 2.1 by default)\n` +
      `  avito-mcp --both           Run stdio AND HTTP in one process\n` +
      `  avito-mcp --version        Print version and exit\n` +
      `  avito-mcp --help           Print this help and exit\n` +
      `  avito-mcp --health         Print health snapshot as JSON and exit\n` +
      `\n` +
      `CLI flags (v0.7.0 — sugar for env vars; do not require a value):\n` +
      `  --readonly                 Same as AVITO_MCP_MODE=read_only (only risk='read' tools)\n` +
      `  --guarded                  Same as AVITO_MCP_MODE=guarded (blocks money/public)\n` +
      `  --dry-run                  Same as AVITO_MCP_DRY_RUN_DEFAULT=true (every destructive\n` +
      `                             tool returns preview by default; agent can override with\n` +
      `                             dryRun: false)\n` +
      `  --no-confirmation          Same as AVITO_MCP_CONFIRMATION_MODE=off\n` +
      `  --http | --both | --stdio  v0.9.0: same as AVITO_MCP_TRANSPORT=http|both|stdio\n` +
      `\n` +
      `Environment variables (see .env.example for the full list):\n` +
      `  Client_id, Client_secret, Profile_id   Required for Avito API calls (not introspection)\n` +
      `  AVITO_BASE_URL          Override Avito API base URL (default: https://api.avito.ru)\n` +
      `  AVITO_MCP_CPA_SOURCE    CPA X-Source value (default: avito-mcp)\n` +
      `  AVITO_TOKEN_FILE        Override OAuth token cache path\n` +
      `  AVITO_ENV_FILE          Path to .env file (default: ./.env)\n` +
      `  AVITO_MCP_MODE          read_only | guarded | full_access (default: full_access)\n` +
      `  AVITO_MCP_ALLOW_TOOLS   Comma-separated tool names; if set, only these register\n` +
      `  AVITO_MCP_DENY_TOOLS    Comma-separated tool names; always blocked (wins over allow)\n` +
      `  AVITO_MCP_CONFIRMATION_MODE     off | money_public (default) | all_destructive\n` +
      `  AVITO_MCP_CONFIRMATION_TTL_SEC  Pending action TTL in seconds (default: 900)\n` +
      `  AVITO_MCP_CONFIRMATION_SECRET   Enables hard-confirmation (minimum 32 characters)\n` +
      `  AVITO_MCP_EXPOSE_AUTH_TOOLS     1 to expose sensitive auth_* tools (default: hidden)\n` +
      `  AVITO_MCP_ALLOWED_UPLOAD_DIRS   Comma-separated dirs for messenger_upload_images\n` +
      `  AVITO_MCP_MAX_UPLOAD_MB         Max per-file upload size in MB (default: 15)\n` +
      `  AVITO_MCP_MAX_BINARY_MB         Max HTTP response body size in MB (default: 20)\n` +
      `  AVITO_MCP_DRY_RUN_DEFAULT       v0.7.0: default for dryRun on destructive tools\n` +
      `                                  (true|false; default: false)\n` +
      `  AVITO_MCP_IDEMPOTENCY_TTL_SEC   v0.7.0: TTL of idempotency ledger entries (default: 3600)\n` +
      `  AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS v0.7.0: max wait for cross-process token lock (default: 30000)\n` +
      `  AVITO_SAFE_MODE         DEPRECATED: use AVITO_MCP_MODE=read_only instead\n` +
      `  LOG_LEVEL               pino log level (default: info)\n` +
      `\n` +
      `Remote HTTP transport (v0.9.0 — only when AVITO_MCP_TRANSPORT=http|both):\n` +
      `  AVITO_MCP_TRANSPORT             stdio (default) | http | both\n` +
      `  AVITO_MCP_HTTP_HOST             bind address (default: 127.0.0.1 — front with a TLS proxy)\n` +
      `  AVITO_MCP_HTTP_PORT             listen port (default: 3000)\n` +
      `  AVITO_MCP_HTTP_PUBLIC_URL       public https URL for OAuth metadata, e.g. https://mcp.example.com\n` +
      `  AVITO_MCP_HTTP_AUTH             oauth (default) | bearer | none\n` +
      `  AVITO_MCP_OAUTH_OWNER_PASSWORD  required in oauth mode; minimum 32 bytes\n` +
      `  AVITO_MCP_OAUTH_TOKEN_TTL_SEC   access-token TTL (default: 3600)\n` +
      `  AVITO_MCP_OAUTH_STORE_FILE      optional durable single-writer OAuth state file\n` +
      `  AVITO_MCP_HTTP_AUTH_TOKEN       bearer-mode shared secret(s), comma-separated\n` +
      `  AVITO_MCP_HTTP_MAX_SESSIONS     concurrent MCP session cap (default: 100)\n` +
      `  AVITO_MCP_HTTP_SESSION_IDLE_SEC idle session TTL (default: 1800)\n` +
      `  AVITO_MCP_HTTP_ALLOWED_HOSTS    CSV — DNS-rebinding protection (Host allowlist)\n` +
      `  AVITO_MCP_HTTP_ALLOWED_ORIGINS  CSV — DNS-rebinding protection (Origin allowlist)\n` +
      `\n` +
      `Avito webhook receiver (v0.9.0 — runs even in stdio mode):\n` +
      `  AVITO_MCP_WEBHOOK_SECRET        receiver path secret; minimum 32 bytes\n` +
      `  AVITO_MCP_WEBHOOK_PUBLIC_URL    public base Avito POSTs to (default: HTTP public URL)\n` +
      `  AVITO_MCP_WEBHOOK_PATH          mount path prefix (default: /avito/webhook)\n` +
      `  AVITO_MCP_WEBHOOK_BUFFER        retained events ring-buffer size (default: 100)\n` +
      `  AVITO_MCP_WEBHOOK_LOG_FILE      optional rotating JSONL with normalized metadata\n` +
      `\n` +
      `Docs: https://github.com/elchin92/avito-mcp\n`,
  );
}

/**
 * v0.7.0: applies CLI flags to process.env BEFORE config.ts is loaded.
 * This lets the existing config loader stay completely unaware of the CLI —
 * to it, the flags just look like environment variables set by the user.
 *
 * Flags do NOT override values the user has already set in env — env wins.
 * This follows the general UNIX principle: explicit env overrides CLI sugar.
 */
function applyCliFlagsToEnv(argv: string[]): void {
  const setIfMissing = (key: string, value: string): void => {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  };
  if (argv.includes('--readonly')) setIfMissing('AVITO_MCP_MODE', 'read_only');
  if (argv.includes('--guarded')) setIfMissing('AVITO_MCP_MODE', 'guarded');
  if (argv.includes('--dry-run')) setIfMissing('AVITO_MCP_DRY_RUN_DEFAULT', 'true');
  if (argv.includes('--no-confirmation')) setIfMissing('AVITO_MCP_CONFIRMATION_MODE', 'off');
  // v0.9.0: transport selection sugar.
  if (argv.includes('--http')) setIfMissing('AVITO_MCP_TRANSPORT', 'http');
  if (argv.includes('--both')) setIfMissing('AVITO_MCP_TRANSPORT', 'both');
  if (argv.includes('--stdio')) setIfMissing('AVITO_MCP_TRANSPORT', 'stdio');
}

/**
 * v0.7.0: --health prints a JSON snapshot of the state and exits. It does not
 * attach the stdio transport and does not hit the Avito API. Useful for probes /
 * docker healthcheck / quick "why is it not working" diagnostics.
 */
async function printHealthAndExit(): Promise<void> {
  const { config } = await import('./config.js');
  const { healthPayload } = await import('./build-server.js');
  process.stdout.write(JSON.stringify(healthPayload(config), null, 2) + '\n');
}

async function startServer(): Promise<void> {
  // Deferred so --version / --help don't trigger dotenv loading or config validation.
  const [
    { config },
    { logger, bindMcpLogger },
    { AvitoClient },
    { domains },
    { PendingActionStore },
    { IdempotencyStore },
    { WebhookStore },
    { buildMcpServer },
  ] = await Promise.all([
    import('./config.js'),
    import('./logger.js'),
    import('./core/client.js'),
    import('./meta/domain-registry.js'),
    import('./core/pending-actions.js'),
    import('./core/idempotency.js'),
    import('./core/webhook-store.js'),
    import('./build-server.js'),
  ]);

  // Shared singletons. They back the stdio server AND every Streamable HTTP session,
  // so the Avito client and token cache are never duplicated across sessions.
  const client = new AvitoClient(config);
  const pendingStore = new PendingActionStore(config.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(config.idempotencyTtlSec * 1000);
  const webhookStore = config.webhook.enabled
    ? new WebhookStore(config.webhook.bufferSize, config.webhook.logFile)
    : undefined;
  const baseCtx: ToolContext = { client, config, pendingStore, idempotencyStore, webhookStore };

  // v0.7.4: credentials are optional at startup. If absent, we still register the full
  // catalogue (tools/list works) but warn loudly — any API call will fail with CONFIG_ERROR
  // until Client_id/Client_secret/Profile_id are set.
  const credentialsConfigured = !!config.clientId && !!config.clientSecret && config.profileId !== undefined;

  const transportMode = config.http.transport;
  const runStdio = transportMode === 'stdio' || transportMode === 'both';
  const runHttpMcp = transportMode === 'http' || transportMode === 'both';

  // ── stdio transport (default) ──────────────────────────────────────────────
  if (runStdio) {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const server = buildMcpServer(baseCtx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // After connect: mirror selected pino events to the stdio client as logging notifications.
    bindMcpLogger(server);
  }

  // Misconfiguration guards for the webhook receiver (config stays permissive;
  // the user-facing warnings live here where the logger is available).
  const { parseBool } = await import('./config.js');
  if (parseBool(process.env.AVITO_MCP_WEBHOOK_ENABLED) && !config.webhook.secret) {
    logger.warn(
      'AVITO_MCP_WEBHOOK_ENABLED is set but AVITO_MCP_WEBHOOK_SECRET is missing — the webhook ' +
        'receiver stays DISABLED (without a secret every delivery would be rejected).',
    );
  }
  if (config.webhook.enabled) {
    try {
      const host = new URL(config.webhook.publicUrl).hostname;
      if (host === 'localhost' || host === '::1' || host.startsWith('127.') || host === '0.0.0.0') {
        logger.warn(
          { publicUrl: config.webhook.publicUrl },
          'webhook public URL is a loopback address — Avito cannot deliver events to it. ' +
            'Set AVITO_MCP_WEBHOOK_PUBLIC_URL (or AVITO_MCP_HTTP_PUBLIC_URL) to the public HTTPS address.',
        );
      }
    } catch {
      /* publicUrl not parseable — startHttpServer/register tool will surface it */
    }
  }

  // ── HTTP listener: remote MCP (Streamable HTTP) and/or the webhook receiver ──
  let httpUrl: string | undefined;
  if (runHttpMcp || config.webhook.enabled) {
    const { startHttpServer } = await import('./http/app.js');
    const handle = await startHttpServer(baseCtx, config);
    httpUrl = handle.url;

    // Graceful shutdown: close sessions + listener on SIGTERM/SIGINT (Docker stop,
    // systemd restart, Ctrl-C). Without this Node kills in-flight /mcp responses
    // and never flushes the OAuth store. Pure-stdio runs keep the default
    // behaviour — their lifecycle is the stdin pipe.
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'avito-mcp shutting down');
      void handle
        .close()
        .catch((err) => logger.warn({ err }, 'error during HTTP shutdown'))
        .finally(() => process.exit(0));
      // Hard exit if something hangs (an open SSE stream, a stuck close).
      setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  if (!credentialsConfigured) {
    logger.warn(
      {
        hasClientId: !!config.clientId,
        hasClientSecret: !!config.clientSecret,
        hasProfileId: config.profileId !== undefined,
      },
      'avito-mcp running in INTROSPECTION-ONLY mode: credentials missing. tools/list, resources ' +
        'and prompts work, but every Avito API call will fail with CONFIG_ERROR until Client_id, ' +
        'Client_secret and Profile_id are set.',
    );
  }

  logger.info(
    {
      version: VERSION,
      baseUrl: config.baseUrl,
      profileId: config.profileId,
      domains: domains.length,
      mode: config.mode,
      transport: transportMode,
      httpUrl,
      httpAuth: runHttpMcp ? config.http.auth : undefined,
      webhookEnabled: config.webhook.enabled,
      credentialsConfigured,
      allowToolsCount: config.allowTools.length,
      denyToolsCount: config.denyTools.length,
      exposeAuthTools: config.exposeAuthTools,
      uploadDirsCount: config.allowedUploadDirs.length,
      confirmationMode: config.confirmationMode,
      hardConfirmation: !!config.confirmationSecret,
      dryRunDefault: config.dryRunDefault,
      idempotencyTtlSec: config.idempotencyTtlSec,
      tokenLockTimeoutMs: config.tokenLockTimeoutMs,
      capabilities: ['tools', 'resources', 'prompts', 'logging'],
    },
    'avito-mcp started',
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  applyCliFlagsToEnv(argv);
  if (argv.includes('--health')) {
    await printHealthAndExit();
    return;
  }
  await startServer();
}

main().catch(async (err) => {
  try {
    const { logger } = await import('./logger.js');
    logger.fatal({ err }, 'avito-mcp failed to start');
  } catch {
    process.stderr.write(`avito-mcp failed to start: ${err?.stack ?? String(err)}\n`);
  }
  process.exit(1);
});
