/**
 * Тесты MCP-prompts (v0.6.0).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { registerPrompts } from '../src/prompts.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';

function makeConfig(): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: false,
    allowedUploadDirs: [],
    maxUploadMb: 15,
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
  };
}

async function makeRig() {
  const cfg = makeConfig();
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const avito = new AvitoClient(cfg);
  const server = new McpServer(
    { name: 'avito-mcp', version: '0.6.0' },
    { capabilities: { prompts: {} } },
  );
  const ctx: ToolContext = { client: avito, config: cfg, pendingStore, server };
  registerPrompts(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(b);
  return { client, ctx, cfg };
}

describe('MCP prompts', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('exposes 5 prompts', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([
      'avito_check_unread_chats',
      'avito_daily_overview',
      'avito_explain_tool',
      'avito_promote_item',
      'avito_safety_report',
    ]);
    // titles присутствуют
    for (const p of prompts) {
      expect(p.title?.startsWith('Avito')).toBe(true);
    }
  });

  it('avito_daily_overview renders prompt with date range derived from days arg', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const got = await client.getPrompt({
      name: 'avito_daily_overview',
      arguments: { days: '14' },
    });
    expect(got.messages).toHaveLength(1);
    const text = (got.messages[0].content as { text: string }).text;
    expect(text).toContain('14 дней');
    expect(text).toContain('user_get_user_balance');
    expect(text).toContain('items_get_items_info');
    expect(text).toContain('items_post_account_spendings');
  });

  it('avito_promote_item embeds item_id and does not invoke purchase tools', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const got = await client.getPrompt({
      name: 'avito_promote_item',
      arguments: { item_id: '789012' },
    });
    const text = (got.messages[0].content as { text: string }).text;
    expect(text).toContain('789012');
    expect(text).toContain('items_post_vas_prices');
    expect(text).toContain('promotion_get_bbip_suggests_by_items_v1');
    // explicit guard:
    expect(text.toLowerCase()).toContain('не покуп'); // "Не покупай"
  });

  it('avito_check_unread_chats stays read-only — no send/blacklist references in the prompt', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const got = await client.getPrompt({
      name: 'avito_check_unread_chats',
      arguments: {},
    });
    const text = (got.messages[0].content as { text: string }).text;
    expect(text).toContain('messenger_get_chats_v2');
    expect(text).toContain('unread_only');
    // explicit guard: no send/blacklist hint
    expect(text).not.toContain('messenger_post_send_message');
    expect(text).not.toContain('messenger_post_blacklist');
  });
});
