#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { ToolContext } from './core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from './version.js';

function printHelp(): void {
  process.stdout.write(
    `${PACKAGE_NAME} ${VERSION}\n` +
      `\n` +
      `Universal MCP server for the Avito API.\n` +
      `\n` +
      `Usage:\n` +
      `  avito-mcp                  Start the MCP stdio server\n` +
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
      `\n` +
      `Environment variables (see .env.example for the full list):\n` +
      `  Client_id, Client_secret, Profile_id   Required Avito OAuth credentials\n` +
      `  AVITO_BASE_URL          Override Avito API base URL (default: https://api.avito.ru)\n` +
      `  AVITO_TOKEN_FILE        Override OAuth token cache path\n` +
      `  AVITO_ENV_FILE          Path to .env file (default: ./.env)\n` +
      `  AVITO_MCP_MODE          read_only | guarded | full_access (default: full_access)\n` +
      `  AVITO_MCP_ALLOW_TOOLS   Comma-separated tool names; if set, only these register\n` +
      `  AVITO_MCP_DENY_TOOLS    Comma-separated tool names; always blocked (wins over allow)\n` +
      `  AVITO_MCP_CONFIRMATION_MODE     off | money_public (default) | all_destructive\n` +
      `  AVITO_MCP_CONFIRMATION_TTL_SEC  Pending action TTL in seconds (default: 900)\n` +
      `  AVITO_MCP_CONFIRMATION_SECRET   Enables hard-confirmation (v0.5.0)\n` +
      `  AVITO_MCP_EXPOSE_AUTH_TOOLS     1 to expose sensitive auth_* tools (default: hidden)\n` +
      `  AVITO_MCP_ALLOWED_UPLOAD_DIRS   Comma-separated dirs for messenger_upload_images\n` +
      `  AVITO_MCP_MAX_UPLOAD_MB         Max per-file upload size in MB (default: 15)\n` +
      `  AVITO_MCP_MAX_BINARY_MB         Max binary response size in MB (default: 20)\n` +
      `  AVITO_MCP_DRY_RUN_DEFAULT       v0.7.0: default for dryRun on destructive tools\n` +
      `                                  (true|false; default: false)\n` +
      `  AVITO_MCP_IDEMPOTENCY_TTL_SEC   v0.7.0: TTL of idempotency ledger entries (default: 3600)\n` +
      `  AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS v0.7.0: max wait for cross-process token lock (default: 30000)\n` +
      `  AVITO_SAFE_MODE         DEPRECATED: use AVITO_MCP_MODE=read_only instead\n` +
      `  LOG_LEVEL               pino log level (default: info)\n` +
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
}

/**
 * v0.7.0: --health prints a JSON snapshot of the state and exits. It does not
 * attach the stdio transport and does not hit the Avito API. Useful for probes /
 * docker healthcheck / quick "why is it not working" diagnostics.
 */
async function printHealthAndExit(): Promise<void> {
  const { config } = await import('./config.js');
  const payload = {
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
    credentialsConfigured: !!config.clientId && !!config.clientSecret,
    baseUrl: config.baseUrl,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
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
    { registerResources },
    { registerPrompts },
  ] = await Promise.all([
    import('./config.js'),
    import('./logger.js'),
    import('./core/client.js'),
    import('./meta/domain-registry.js'),
    import('./core/pending-actions.js'),
    import('./core/idempotency.js'),
    import('./resources.js'),
    import('./prompts.js'),
  ]);

  // Server metadata — title/description/websiteUrl are MCP-2025-11-25 Implementation fields.
  // Aware MCP clients (Inspector, Claude Desktop) render these in the connection picker.
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: 'Avito MCP',
      version: VERSION,
      description:
        '145 tools for the Avito API: listings, messenger, orders, delivery, ' +
        'promotion, autoload, analytics. With a safety policy (read_only / guarded / ' +
        'full_access), a confirmation flow for money/public operations, and hard-confirmation via ' +
        'AVITO_MCP_CONFIRMATION_SECRET.',
      websiteUrl: 'https://github.com/elchin92/avito-mcp',
    },
    {
      // Declare capabilities we explicitly support. Tools/resources/prompts are also
      // auto-detected by the SDK from registrations, but logging is opt-in.
      capabilities: {
        logging: {},
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        tools: { listChanged: false },
      },
      instructions:
        'Avito MCP — a server for the live (production) Avito API. Before any write/money/public ' +
        'operation, always confirm the action with a human; in confirmation_mode=money_public ' +
        '(default) the server returns a confirmation_id and requires a meta_confirm_action call. ' +
        'Full reference on the safety modes is in the avito://docs/safety resource. The list of tools ' +
        'with their risk classification is in avito://manifest. Pending actions are in ' +
        'avito://state/pending-actions (you can subscribe via resources/subscribe).',
    },
  );

  const client = new AvitoClient(config);
  const pendingStore = new PendingActionStore(config.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(config.idempotencyTtlSec * 1000);
  const ctx: ToolContext = { client, config, pendingStore, idempotencyStore, server };

  // v0.7.4: credentials are optional at startup. If absent, we still register the full
  // catalogue (tools/list works) but warn loudly — any API call will fail with CONFIG_ERROR
  // until Client_id/Client_secret/Profile_id are set. Enables introspection by registry
  // indexers / inspectors and `npx avito-mcp` previews.
  const credentialsConfigured = !!config.clientId && !!config.clientSecret && config.profileId !== undefined;

  for (const register of domains) {
    register(server, ctx);
  }
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // After connect: pipe selected pino events to the MCP client as logging/message
  // notifications. Pino keeps writing to stderr; MCP-clients now see them too.
  bindMcpLogger(server);

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
