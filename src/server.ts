#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { ToolContext } from './core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from './version.js';

function printHelp(): void {
  process.stdout.write(
    `${PACKAGE_NAME} ${VERSION}\n` +
      `\n` +
      `Local MCP server for the Avito API.\n` +
      `\n` +
      `Usage:\n` +
      `  avito-mcp                Start the MCP stdio server\n` +
      `  avito-mcp --version      Print version and exit\n` +
      `  avito-mcp --help         Print this help and exit\n` +
      `\n` +
      `Environment variables (see .env.example for the full list):\n` +
      `  Client_id, Client_secret, Profile_id   Required Avito credentials\n` +
      `  AVITO_BASE_URL          Override Avito API base URL (default: https://api.avito.ru)\n` +
      `  AVITO_TOKEN_FILE        Override OAuth token cache path\n` +
      `  AVITO_ENV_FILE          Path to .env file (default: ./.env)\n` +
      `  AVITO_MCP_MODE          read_only | guarded | full_access (default: full_access)\n` +
      `                          - read_only:   only risk='read' tools are registered\n` +
      `                          - guarded:     blocks risk='money' and risk='public'\n` +
      `                          - full_access: all tools (default; legacy behaviour)\n` +
      `  AVITO_MCP_ALLOW_TOOLS   Comma-separated tool names; if set, only these register\n` +
      `  AVITO_MCP_DENY_TOOLS    Comma-separated tool names; always blocked (wins over allow)\n` +
      `  AVITO_MCP_CONFIRMATION_MODE     off | money_public (default) | all_destructive\n` +
      `  AVITO_MCP_CONFIRMATION_TTL_SEC  Pending action TTL in seconds (default: 900)\n` +
      `  AVITO_MCP_CONFIRMATION_SECRET   v0.5.0: enables hard-confirmation (human-typed secret)\n` +
      `  AVITO_MCP_EXPOSE_AUTH_TOOLS     1 to expose sensitive auth_* tools (default: hidden)\n` +
      `  AVITO_MCP_ALLOWED_UPLOAD_DIRS   Comma-separated dirs that messenger_upload_images may read\n` +
      `  AVITO_MCP_MAX_UPLOAD_MB         Max per-file upload size in MB (default: 15)\n` +
      `  AVITO_MCP_MAX_BINARY_MB         Max binary response size in MB (default: 20)\n` +
      `  AVITO_SAFE_MODE         DEPRECATED: use AVITO_MCP_MODE=read_only instead\n` +
      `  LOG_LEVEL               pino log level (default: info)\n` +
      `\n` +
      `Docs: https://github.com/elchin92/avito-mcp\n`,
  );
}

async function startServer(): Promise<void> {
  // Deferred so --version / --help don't trigger dotenv loading or config validation.
  const [{ config }, { logger }, { AvitoClient }, { domains }, { PendingActionStore }] =
    await Promise.all([
      import('./config.js'),
      import('./logger.js'),
      import('./core/client.js'),
      import('./meta/domain-registry.js'),
      import('./core/pending-actions.js'),
    ]);

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: VERSION,
  });

  const client = new AvitoClient(config);
  const pendingStore = new PendingActionStore(config.confirmationTtlSec * 1000);
  const ctx: ToolContext = { client, config, pendingStore };

  for (const register of domains) {
    register(server, ctx);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(
    {
      version: VERSION,
      baseUrl: config.baseUrl,
      profileId: config.profileId,
      domains: domains.length,
      mode: config.mode,
      allowToolsCount: config.allowTools.length,
      denyToolsCount: config.denyTools.length,
      exposeAuthTools: config.exposeAuthTools,
      uploadDirsCount: config.allowedUploadDirs.length,
      confirmationMode: config.confirmationMode,
      hardConfirmation: !!config.confirmationSecret,
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
