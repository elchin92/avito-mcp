/**
 * Debug-скрипт: запускает MCP-сервер в той же программе через InMemoryTransport
 * и печатает список зарегистрированных tools (имя + описание + JSON-схему inputSchema).
 * Запуск: `npm run list-tools` или `npx tsx scripts/list-tools.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { config } from '../src/config.js';
import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import { domains } from '../src/meta/domain-registry.js';
import { PACKAGE_NAME, VERSION } from '../src/version.js';

async function main() {
  const server = new McpServer({ name: PACKAGE_NAME, version: VERSION });
  const pendingStore = new PendingActionStore(config.confirmationTtlSec * 1000);
  const ctx: ToolContext = { client: new AvitoClient(config), config, pendingStore };
  for (const register of domains) register(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);

  const client = new Client({ name: 'list-tools', version: VERSION }, { capabilities: {} });
  await client.connect(b);

  const { tools } = await client.listTools();
  process.stdout.write(`Registered tools: ${tools.length}\n\n`);
  for (const tool of tools) {
    process.stdout.write(`▸ ${tool.name}\n`);
    if (tool.description) {
      process.stdout.write(`  ${tool.description.replace(/\n/g, '\n  ')}\n`);
    }
    process.stdout.write(`  inputSchema: ${JSON.stringify(tool.inputSchema)}\n\n`);
  }

  // E2E sanity: реальный вызов одного read-only tool через MCP протокол → боевой Avito.
  if (process.env.CALL_USER_INFO === '1') {
    process.stdout.write('\n== Calling user_get_user_info_self via MCP ==\n');
    const result = await client.callTool({ name: 'user_get_user_info_self', arguments: {} });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    process.stdout.write('\n== Calling user_get_user_balance (no args → uses Profile_id) ==\n');
    const balance = await client.callTool({ name: 'user_get_user_balance', arguments: {} });
    process.stdout.write(JSON.stringify(balance, null, 2) + '\n');
  }

  await client.close();
  await server.close();
}

main().catch((err) => {
  process.stderr.write(`list-tools failed: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
