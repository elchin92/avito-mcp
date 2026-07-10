/**
 * structuredContent tests (MCP 2025-11-25) at the tool-factory level.
 *
 * Verify that tools still return content[].text as before, plus structuredContent with the
 * same payload for clients capable of parsing it. Covers the object/array/binary/error cases.
 */
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
import type { Config } from '../src/config.js';

function makeConfig(): Config {
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
  };
}

interface Rig {
  client: Client;
  cfg: Config;
  fetchMock: ReturnType<typeof vi.fn>;
}

async function makeRig(fetchResponse: Response): Promise<Rig> {
  const cfg = makeConfig();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fetchResponse.clone();
  });
  vi.stubGlobal('fetch', fetchMock);

  const avito = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const server = new McpServer({ name: 'avito-mcp', version: '0.6.0' });
  const ctx: ToolContext = { client: avito, config: cfg, pendingStore };
  defineTool(server, ctx, {
    name: 'echo',
    risk: 'read',
    description: 'echo',
    method: 'GET',
    path: '/x',
    input: { q: z.string().optional() },
    queryParams: ['q'],
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return { client, cfg, fetchMock };
}

describe('structuredContent', () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await cleanup?.();
    cleanup = undefined;
  });

  it('object responses keep API status separate from http_status', async () => {
    const { client, cfg } = await makeRig(
      new Response(JSON.stringify({ status: 'active', balance: 12345, currency: 'RUB' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'echo', arguments: {} });
    expect(res.structuredContent).toEqual({
      status: 'active',
      http_status: 200,
      balance: 12345,
      currency: 'RUB',
    });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('status=200');
  });

  it('array responses → structuredContent wraps as { items, count }', async () => {
    const { client, cfg } = await makeRig(
      new Response(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'echo', arguments: {} });
    expect(res.structuredContent).toEqual({
      status: 200,
      http_status: 200,
      items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      count: 3,
    });
  });

  it('binary responses → structuredContent with mimeType + sizeBytes + base64', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
    const { client, cfg } = await makeRig(
      new Response(pdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) },
      }),
    );
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'echo', arguments: {} });
    expect(res.structuredContent).toMatchObject({
      status: 200,
      http_status: 200,
      mimeType: 'application/pdf',
      sizeBytes: 8,
    });
    expect(typeof (res.structuredContent as { base64: string }).base64).toBe('string');
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(Buffer.from(pdf).toString('base64'));
  });

  it('error responses → isError=true + structuredContent.error_kind', async () => {
    const { client, cfg } = await makeRig(
      new Response(JSON.stringify({ error: { message: 'bad' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'echo', arguments: {} });
    expect(res.isError).toBe(true);
    // v0.7.0: structuredContent.error is the formal envelope.
    // error_kind remains for backwards-compat with v0.6.0 consumers.
    expect(res.structuredContent).toMatchObject({
      error: {
        type: 'AVITO_BAD_REQUEST',
        retryable: false,
        httpStatus: 400,
      },
      error_kind: 'avito_api_error',
    });
  });

  it('text-only responses → no structuredContent, only text', async () => {
    const { client, cfg } = await makeRig(
      new Response('plain text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'echo', arguments: {} });
    expect(res.structuredContent).toBeUndefined();
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('plain text');
  });
});
