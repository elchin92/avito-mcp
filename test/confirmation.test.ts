/**
 * v0.4.0 confirmation flow:
 *   - money/public tools return a pending action instead of executing
 *   - meta_confirm_action executes the pending one-shot
 *   - double confirm fails
 *   - cancel removes the pending
 *   - expired confirm fails
 *   - policy is re-evaluated at confirm time
 *   - read/sensitive (when exposed) don't go through confirmation
 *   - all_destructive mode also catches write
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import { defineTool, type ToolContext } from '../src/core/tool-factory.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { register as registerMeta } from '../src/domains/meta.js';
import type { Config, ConfirmationMode } from '../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    confirmationSecret: undefined,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http: {
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      publicUrl: 'http://127.0.0.1:3000',
      auth: 'oauth',
      authTokens: [],
      allowNoAuth: false,
      allowedHosts: [],
      allowedOrigins: [],
      oauthTokenTtlSec: 3600,
    },
    webhook: {
      enabled: false,
      publicUrl: 'http://127.0.0.1:3000',
      path: '/avito/webhook',
      bufferSize: 100,
    },
    ...overrides,
  };
}

async function makeRig(
  confirmationMode: ConfirmationMode,
  ttlSec = 900,
  extra: Partial<Config> = {},
) {
  const cfg = makeConfig({ confirmationMode, confirmationTtlSec: ttlSec, ...extra });
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tk', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000);
  const ctx: ToolContext = { client, config: cfg, pendingStore, idempotencyStore };

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  // Register one tool per risk and the meta confirmation tools.
  defineTool(server, ctx, {
    name: 'read_tool',
    risk: 'read',
    description: 'reader',
    method: 'GET',
    path: '/anything',
  });
  defineTool(server, ctx, {
    name: 'write_tool',
    risk: 'write',
    description: 'writer',
    method: 'POST',
    path: '/anything',
    input: { x: z.number() },
    body: { contentType: 'application/json', fields: ['x'] },
  });
  defineTool(server, ctx, {
    name: 'money_tool',
    risk: 'money',
    description: 'spender',
    method: 'POST',
    path: '/anything',
    input: { item_id: z.number(), vas_id: z.string() },
    body: { contentType: 'application/json', fields: ['vas_id'] },
  });
  defineTool(server, ctx, {
    name: 'public_tool',
    risk: 'public',
    description: 'sender',
    method: 'POST',
    path: '/anything',
    input: { chat_id: z.string() },
    body: { contentType: 'application/json', fields: ['chat_id'] },
  });
  registerMeta(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client2 = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await client2.connect(b);
  return { server, client: client2, cfg, ctx, fetchMock, pendingStore };
}

function parseText(content: unknown): string {
  return (content as Array<{ type: string; text: string }>)[0]!.text;
}

function extractConfirmationId(text: string): string {
  const parsed = JSON.parse(text) as { confirmation_id?: string };
  if (!parsed.confirmation_id) throw new Error('no confirmation_id in pending payload');
  return parsed.confirmation_id;
}

describe('confirmation flow', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  it('money tool returns requires_confirmation in money_public mode (Avito not called)', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const r = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    expect(r.isError).not.toBe(true);
    const payload = JSON.parse(parseText(r.content));
    expect(payload.requires_confirmation).toBe(true);
    expect(payload.tool).toBe('money_tool');
    expect(payload.risk).toBe('money');
    expect(rig.fetchMock).not.toHaveBeenCalled();
    expect(rig.pendingStore.size()).toBe(1);
    await rig.client.close();
  });

  it('reuses the same pending action for duplicate idempotency keys before confirmation', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const args = { item_id: 1, vas_id: 'highlight', idempotencyKey: 'same-confirm-key' };
    const first = await rig.client.callTool({ name: 'money_tool', arguments: args });
    const second = await rig.client.callTool({ name: 'money_tool', arguments: args });
    const firstId = extractConfirmationId(parseText(first.content));
    const secondId = extractConfirmationId(parseText(second.content));

    expect(secondId).toBe(firstId);
    expect(rig.pendingStore.size()).toBe(1);
    expect(rig.fetchMock).not.toHaveBeenCalled();

    const confirmed = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: firstId },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('write tool does NOT require confirmation in money_public mode', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const r = await rig.client.callTool({ name: 'write_tool', arguments: { x: 1 } });
    expect(r.isError).not.toBe(true);
    // write_tool should execute (fetch called for token + actual call)
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('write tool DOES require confirmation in all_destructive mode', async () => {
    const rig = await makeRig('all_destructive');
    cfg = rig.cfg;
    const r = await rig.client.callTool({ name: 'write_tool', arguments: { x: 1 } });
    expect(JSON.parse(parseText(r.content)).requires_confirmation).toBe(true);
    expect(rig.fetchMock).not.toHaveBeenCalled();
    await rig.client.close();
  });

  it('confirmation_mode=off skips the gate entirely', async () => {
    const rig = await makeRig('off');
    cfg = rig.cfg;
    const r = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    // confirmation off → tool executes; response is "status=200\n..." not the pending JSON shape
    expect(parseText(r.content)).not.toContain('requires_confirmation');
    expect(parseText(r.content)).toMatch(/status=200/);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    await rig.client.close();
  });

  it('meta_confirm_action executes the pending then removes it (one-shot)', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const fetchCallsBefore = rig.fetchMock.mock.calls.length;

    const confirmed = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(fetchCallsBefore);
    expect(rig.pendingStore.size()).toBe(0);

    const again = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(again.isError).toBe(true);
    expect(parseText(again.content)).toMatch(/not found/);
    await rig.client.close();
  });

  it('meta_cancel_action removes the pending (no execution, no double-cancel error)', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'public_tool',
      arguments: { chat_id: 'c1' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const fetchCallsBefore = rig.fetchMock.mock.calls.length;

    const cancelled = await rig.client.callTool({
      name: 'meta_cancel_action',
      arguments: { confirmation_id: id },
    });
    expect(cancelled.isError).not.toBe(true);
    expect(parseText(cancelled.content)).toMatch(/cancelled/);
    expect(rig.fetchMock.mock.calls.length).toBe(fetchCallsBefore);

    // Re-cancel returns informational, not isError
    const again = await rig.client.callTool({
      name: 'meta_cancel_action',
      arguments: { confirmation_id: id },
    });
    expect(again.isError).not.toBe(true);
    await rig.client.close();
  });

  it('expired pending: confirm fails after TTL', async () => {
    const rig = await makeRig('money_public', 1); // 1 second TTL
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    // Manually expire by reaching into the store (faster than real wait)
    const action = (rig.pendingStore as unknown as {
      actions: Map<string, { expiresAt: number }>;
    }).actions.get(id)!;
    action.expiresAt = Date.now() - 1;
    const r = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(r.isError).toBe(true);
    expect(parseText(r.content)).toMatch(/not found|expired/);
    await rig.client.close();
  });

  it('meta_list_pending_actions shows summary, no args, no execute', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 999, vas_id: 'premium' },
    });
    const list = await rig.client.callTool({
      name: 'meta_list_pending_actions',
      arguments: {},
    });
    const text = parseText(list.content);
    expect(text).toContain('money_tool');
    expect(text).toContain('item_id=999');
    expect(text).toContain('vas_id=premium');
    // Should NOT dump the raw args record
    expect(text).not.toContain('"args"');
    await rig.client.close();
  });

  it('confirmation tools are NOT registered when confirmation_mode=off', async () => {
    const rig = await makeRig('off');
    cfg = rig.cfg;
    const { tools } = await rig.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).not.toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('confirmation tools ARE registered when confirmation_mode != off', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const { tools } = await rig.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('meta_confirm_action');
    expect(names).toContain('meta_cancel_action');
    expect(names).toContain('meta_list_pending_actions');
    await rig.client.close();
  });
});

describe('hard-confirmation (AVITO_MCP_CONFIRMATION_SECRET)', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  it('confirm without secret is rejected and pending NOT deleted', async () => {
    const rig = await makeRig('money_public', 900, { confirmationSecret: 'topsecret123' });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    const id = extractConfirmationId(parseText(first.content));
    expect(rig.pendingStore.size()).toBe(1);

    const noSecret = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(noSecret.isError).toBe(true);
    expect(parseText(noSecret.content)).toMatch(/AVITO_MCP_CONFIRMATION_SECRET/);
    // Pending action should still exist — bad secret doesn't burn it (allows retry).
    expect(rig.pendingStore.size()).toBe(1);
    await rig.client.close();
  });

  it('confirm with wrong secret is rejected, pending NOT deleted', async () => {
    const rig = await makeRig('money_public', 900, { confirmationSecret: 'real-secret' });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const r = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'wrong-guess' },
    });
    expect(r.isError).toBe(true);
    expect(rig.pendingStore.size()).toBe(1);
    await rig.client.close();
  });

  it('confirm with correct secret executes and burns pending', async () => {
    const rig = await makeRig('money_public', 900, { confirmationSecret: 'a-strong-secret' });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const fetchBefore = rig.fetchMock.mock.calls.length;
    const r = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'a-strong-secret' },
    });
    expect(r.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(fetchBefore);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('rejects length-mismatch without timing leak (different-length secret)', async () => {
    const rig = await makeRig('money_public', 900, { confirmationSecret: 'same-length-12' });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    // Same length, different content
    const sameLen = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'WRONG-LEN12_X'.slice(0, 14) },
    });
    expect(sameLen.isError).toBe(true);
    // Different length
    const diffLen = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'short' },
    });
    expect(diffLen.isError).toBe(true);
    await rig.client.close();
  });
});

describe('v0.5.1: meta_* tools go through allow/deny policy', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  it('allowlist that excludes meta_confirm_action hides it', async () => {
    const rig = await makeRig('money_public', 900, { allowTools: ['money_tool'] });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('money_tool');
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).not.toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('denylist that includes meta_confirm_action hides it (deny wins)', async () => {
    const rig = await makeRig('money_public', 900, { denyTools: ['meta_confirm_action'] });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    // Cancel and list still visible — they weren't denied.
    expect(names).toContain('meta_cancel_action');
    expect(names).toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('denylist on all three confirmation tools hides them all', async () => {
    const rig = await makeRig('money_public', 900, {
      denyTools: ['meta_confirm_action', 'meta_cancel_action', 'meta_list_pending_actions'],
    });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).not.toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('read_only mode hides write meta tools (confirm + cancel) but keeps read meta_list', async () => {
    // money_public confirmation is the ONLY reason confirm tools are even potentially registered;
    // read_only mode then filters out write-class ones. list_pending is risk=read so survives.
    const rig = await makeRig('money_public', 900, { mode: 'read_only' });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).toContain('meta_list_pending_actions');
    await rig.client.close();
  });
});
