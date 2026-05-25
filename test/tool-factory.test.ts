import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type { Config } from '../src/config.js';

function makeConfig(): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
  };
}

async function makeRig(ctx: ToolContext) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  defineTool(server, ctx, {
    name: 'reader',
    risk: 'read',
    description: 'A read-only tool',
    method: 'GET',
    path: '/anything',
  });
  defineTool(server, ctx, {
    name: 'writer',
    risk: 'write',
    description: 'A write tool',
    method: 'POST',
    path: '/anything',
    input: { x: z.number() },
    body: { contentType: 'application/json', fields: ['x'] },
  });
  defineTool(server, ctx, {
    name: 'spender',
    risk: 'money',
    description: 'Spends money',
    method: 'POST',
    path: '/anything',
  });
  defineTool(server, ctx, {
    name: 'unclassified',
    description: 'No risk specified — defaults to write',
    method: 'POST',
    path: '/anything',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(b);
  return { server, client };
}

describe('defineTool — risk classification', () => {
  let cfg: Config;
  let fetchMock: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    cfg = makeConfig();
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const avito = new AvitoClient(cfg, { retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 } });
    ctx = { client: avito, config: cfg };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.AVITO_SAFE_MODE;
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('annotates read tools with readOnlyHint=true, destructiveHint=false', async () => {
    const { client } = await makeRig(ctx);
    const { tools } = await client.listTools();
    const reader = tools.find((t) => t.name === 'reader')!;
    expect(reader.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    await client.close();
  });

  it('annotates write tools with readOnlyHint=false, destructiveHint=false', async () => {
    const { client } = await makeRig(ctx);
    const { tools } = await client.listTools();
    const writer = tools.find((t) => t.name === 'writer')!;
    expect(writer.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    await client.close();
  });

  it('annotates money tools with destructiveHint=true', async () => {
    const { client } = await makeRig(ctx);
    const { tools } = await client.listTools();
    const spender = tools.find((t) => t.name === 'spender')!;
    expect(spender.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    await client.close();
  });

  it('treats unclassified tools as write (fail-closed default)', async () => {
    const { client } = await makeRig(ctx);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'unclassified')!;
    expect(t.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    await client.close();
  });
});

describe('defineTool — AVITO_SAFE_MODE=read-only', () => {
  let cfg: Config;
  let fetchMock: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    cfg = makeConfig();
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const avito = new AvitoClient(cfg, { retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 } });
    ctx = { client: avito, config: cfg };
    process.env.AVITO_SAFE_MODE = 'read-only';
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.AVITO_SAFE_MODE;
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('allows read tools (no Avito call made — but tool succeeds at MCP layer)', async () => {
    // fetch is mocked to return token + data, so the read call goes through
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { client } = await makeRig(ctx);
    const r = await client.callTool({ name: 'reader', arguments: {} });
    expect(r.isError).not.toBe(true);
    await client.close();
  });

  it('blocks write tools with isError + explanation', async () => {
    const { client } = await makeRig(ctx);
    const r = await client.callTool({ name: 'writer', arguments: { x: 1 } });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('AVITO_SAFE_MODE=read-only');
    expect(text).toContain('writer');
    expect(text).toContain('write');
    expect(fetchMock).not.toHaveBeenCalled(); // never reached Avito
    await client.close();
  });

  it('blocks money tools', async () => {
    const { client } = await makeRig(ctx);
    const r = await client.callTool({ name: 'spender', arguments: {} });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('money');
    await client.close();
  });

  it('blocks unclassified tools (fail-closed)', async () => {
    const { client } = await makeRig(ctx);
    const r = await client.callTool({ name: 'unclassified', arguments: {} });
    expect(r.isError).toBe(true);
    await client.close();
  });
});
