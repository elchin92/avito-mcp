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
      `  AVITO_SAFE_MODE         Set to "read-only" to block all write / money / public tools\n` +
      `  LOG_LEVEL               pino log level (default: info)\n` +
      `\n` +
      `Docs: https://github.com/elchin92/avito-mcp\n`,
  );
}

async function startServer(): Promise<void> {
  // Deferred so --version / --help don't trigger dotenv loading or config validation.
  const [{ config }, { logger }, { AvitoClient }, { domains }] = await Promise.all([
    import('./config.js'),
    import('./logger.js'),
    import('./core/client.js'),
    import('./meta/domain-registry.js'),
  ]);

  const server = new McpServer({
    name: PACKAGE_NAME,
    version: VERSION,
  });

  const client = new AvitoClient(config);
  const ctx: ToolContext = { client, config };

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
      safeMode: process.env.AVITO_SAFE_MODE ?? 'off',
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
