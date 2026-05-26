/**
 * Тесты dry-run middleware (v0.7.0). Проверяем что:
 *   - destructive tools принимают параметр dryRun (присутствует в schema)
 *   - dryRun=true возвращает preview без HTTP-вызова
 *   - dryRun=false выполняет реальный HTTP-вызов
 *   - AVITO_MCP_DRY_RUN_DEFAULT=true делает то же, что dryRun=true
 *   - read tools НЕ имеют dryRun в schema (там бессмысленно)
 *   - dryRun обходит confirmation flow
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
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import type { Config } from '../src/config.js';

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
    confirmationMode: 'off',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    ...overrides,
  };
}

async function makeRig(cfg: Config) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) {
      return new Response(
        JSON.stringify({ access_token: 't', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const avito = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000);
  const server = new McpServer({ name: 'avito-mcp', version: '0.7.0' });
  const ctx: ToolContext = { client: avito, config: cfg, pendingStore, idempotencyStore };
  defineTool(server, ctx, {
    name: 'writer',
    risk: 'write',
    description: 'destructive',
    method: 'POST',
    path: '/x',
    input: { val: z.string() },
    body: { contentType: 'application/json', fields: ['val'] },
  });
  defineTool(server, ctx, {
    name: 'reader',
    risk: 'read',
    description: 'read',
    method: 'GET',
    path: '/y',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return { client, fetchMock };
}

describe('dry-run middleware', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup?.();
    cleanup = undefined;
  });

  it('destructive tool schema has dryRun and idempotencyKey; read tool does NOT', async () => {
    const cfg = makeConfig();
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const { tools } = await client.listTools();
    const writer = tools.find((t) => t.name === 'writer')!;
    const reader = tools.find((t) => t.name === 'reader')!;
    const writerProps = writer.inputSchema.properties as Record<string, unknown>;
    expect(writerProps.dryRun).toBeDefined();
    expect(writerProps.idempotencyKey).toBeDefined();
    const readerProps = (reader.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(readerProps.dryRun).toBeUndefined();
    expect(readerProps.idempotencyKey).toBeUndefined();
  });

  it('dryRun=true returns preview without HTTP call', async () => {
    const cfg = makeConfig();
    const { client, fetchMock } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({
      name: 'writer',
      arguments: { val: 'hello', dryRun: true },
    });
    expect(res.structuredContent).toMatchObject({
      dryRun: true,
      explicit_request: true,
      operation: { tool: 'writer', method: 'POST', path: '/x' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dryRun=false makes real HTTP call', async () => {
    const cfg = makeConfig();
    const { client, fetchMock } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    await client.callTool({
      name: 'writer',
      arguments: { val: 'hello', dryRun: false },
    });
    // fetchMock called: one for token, one for /x
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('/x'))).toBe(true);
  });

  it('AVITO_MCP_DRY_RUN_DEFAULT=true short-circuits without explicit param', async () => {
    const cfg = makeConfig({ dryRunDefault: true });
    const { client, fetchMock } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({
      name: 'writer',
      arguments: { val: 'hello' },
    });
    expect(res.structuredContent).toMatchObject({ dryRun: true, explicit_request: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dryRun bypasses confirmation flow (no pending action created)', async () => {
    const cfg = makeConfig({ confirmationMode: 'all_destructive' });
    const { client, fetchMock } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({
      name: 'writer',
      arguments: { val: 'hello', dryRun: true },
    });
    // We should NOT get a requires_confirmation envelope.
    expect(res.structuredContent).toMatchObject({ dryRun: true });
    expect((res.structuredContent as Record<string, unknown>).requires_confirmation).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
