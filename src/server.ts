#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './config.js';
import { logger } from './logger.js';
import { AvitoClient } from './core/client.js';
import type { ToolContext } from './core/tool-factory.js';
import { domains } from './meta/domain-registry.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'avito-mcp',
    version: '0.1.0',
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
      baseUrl: config.baseUrl,
      profileId: config.profileId,
      domains: domains.length,
    },
    'avito-mcp started',
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'avito-mcp failed to start');
  process.exit(1);
});
