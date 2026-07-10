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
import { PendingActionStore } from '../src/core/pending-actions.js';
import type { Config, SafetyMode } from '../src/config.js';

function makeConfig(
  overrides: Partial<
    Pick<
      Config,
      | 'mode'
      | 'allowTools'
      | 'denyTools'
      | 'exposeAuthTools'
      | 'allowedUploadDirs'
      | 'maxUploadMb'
      | 'confirmationMode'
      | 'confirmationTtlSec'
    >
  > = {},
): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
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
      maxSessions: 100,
      sessionIdleSec: 1800,
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
    name: 'broadcaster',
    risk: 'public',
    description: 'Visible to customers',
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

async function listNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

function makeCtx(mode: SafetyMode, allow: string[] = [], deny: string[] = []): { ctx: ToolContext; cfg: Config; fetchMock: ReturnType<typeof vi.fn> } {
  const cfg = makeConfig({ mode, allowTools: allow, denyTools: deny });
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const avito = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  return { ctx: { client: avito, config: cfg, pendingStore }, cfg, fetchMock };
}

describe('defineTool — risk annotations', () => {
  let cfg: Config;
  let ctx: ToolContext;

  beforeEach(() => {
    const setup = makeCtx('full_access');
    cfg = setup.cfg;
    ctx = setup.ctx;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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

  it('annotates money + public tools with destructiveHint=true', async () => {
    const { client } = await makeRig(ctx);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'spender')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.find((t) => t.name === 'broadcaster')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    await client.close();
  });

  it('defaults unclassified tools to write semantics', async () => {
    const { client } = await makeRig(ctx);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'unclassified')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    await client.close();
  });
});

describe('defineTool — AVITO_MCP_MODE=read_only', () => {
  let cfg: Config;
  let ctx: ToolContext;

  beforeEach(() => {
    const setup = makeCtx('read_only');
    cfg = setup.cfg;
    ctx = setup.ctx;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('hides every non-read tool from tools/list (not just blocks at runtime)', async () => {
    const { client } = await makeRig(ctx);
    const names = await listNames(client);
    expect(names).toEqual(['reader']);
    await client.close();
  });
});

describe('defineTool — AVITO_MCP_MODE=guarded', () => {
  let cfg: Config;
  let ctx: ToolContext;

  beforeEach(() => {
    const setup = makeCtx('guarded');
    cfg = setup.cfg;
    ctx = setup.ctx;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('hides money and public, keeps read and write (incl. unclassified default)', async () => {
    const { client } = await makeRig(ctx);
    const names = await listNames(client);
    expect(names).toEqual(['reader', 'unclassified', 'writer']);
    await client.close();
  });
});

describe('defineTool — AVITO_MCP_MODE=full_access', () => {
  let cfg: Config;
  let ctx: ToolContext;

  beforeEach(() => {
    const setup = makeCtx('full_access');
    cfg = setup.cfg;
    ctx = setup.ctx;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('exposes all five tools', async () => {
    const { client } = await makeRig(ctx);
    const names = await listNames(client);
    expect(names).toEqual(['broadcaster', 'reader', 'spender', 'unclassified', 'writer']);
    await client.close();
  });
});

describe('defineTool — AVITO_MCP_ALLOW_TOOLS', () => {
  let cfg: Config;
  let ctx: ToolContext;

  beforeEach(() => {
    const setup = makeCtx('full_access', ['reader', 'spender']);
    cfg = setup.cfg;
    ctx = setup.ctx;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('narrows registration to listed names regardless of mode', async () => {
    const { client } = await makeRig(ctx);
    expect(await listNames(client)).toEqual(['reader', 'spender']);
    await client.close();
  });
});

describe('defineTool — AVITO_MCP_DENY_TOOLS', () => {
  let cfg: Config;
  let ctx: ToolContext;

  beforeEach(() => {
    const setup = makeCtx('full_access', [], ['spender', 'broadcaster']);
    cfg = setup.cfg;
    ctx = setup.ctx;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('blocks listed names, lets others through', async () => {
    const { client } = await makeRig(ctx);
    expect(await listNames(client)).toEqual(['reader', 'unclassified', 'writer']);
    await client.close();
  });

  it('deny wins over allow when both contain the same name', async () => {
    const setup = makeCtx('full_access', ['spender', 'reader'], ['spender']);
    vi.unstubAllGlobals();
    const { ctx: ctx2, cfg: cfg2 } = setup;
    cfg = cfg2;
    const { client } = await makeRig(ctx2);
    expect(await listNames(client)).toEqual(['reader']); // spender blocked by deny
    await client.close();
  });
});
