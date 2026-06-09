/**
 * v0.5.0: binary content from Avito (PDF labels, audio recordings) is detected
 * by the client and returned as a structured { mimeType, sizeBytes, base64 } envelope
 * instead of leaking raw bytes as text.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import type { Config } from '../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 1,
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

function makeClient(overrides: Partial<Config> = {}): { client: AvitoClient; cfg: Config; fetchMock: ReturnType<typeof vi.fn> } {
  const cfg = makeConfig(overrides);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const client = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  return { client, cfg, fetchMock };
}

interface BinaryResponse {
  __binary: boolean;
  mimeType: string;
  sizeBytes: number;
  base64: string;
}

describe('AvitoClient — binary response handling', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  beforeEach(() => {
    /* no-op */
  });

  it('wraps application/pdf content as base64 envelope', async () => {
    const rig = makeClient();
    cfg = rig.cfg;
    const fakePdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(fakePdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const resp = await rig.client.request<BinaryResponse>({
      method: 'GET',
      path: '/labels/123/download',
    });
    expect(resp.status).toBe(200);
    const data = resp.data as unknown as BinaryResponse;
    expect(data.__binary).toBe(true);
    expect(data.mimeType).toBe('application/pdf');
    expect(data.sizeBytes).toBe(fakePdf.length);
    expect(Buffer.from(data.base64, 'base64').equals(fakePdf)).toBe(true);
  });

  it('wraps audio/mpeg content as base64 envelope', async () => {
    const rig = makeClient();
    cfg = rig.cfg;
    const fakeAudio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0]);
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(fakeAudio, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    const resp = await rig.client.request<BinaryResponse>({
      method: 'GET',
      path: '/calltracking/v1/getRecordByCallId/',
    });
    const data = resp.data as unknown as BinaryResponse;
    expect(data.__binary).toBe(true);
    expect(data.mimeType).toBe('audio/mpeg');
    expect(data.sizeBytes).toBe(fakeAudio.length);
  });

  it('keeps JSON responses as parsed objects, NOT base64', async () => {
    const rig = makeClient();
    cfg = rig.cfg;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ orders: [1, 2, 3] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const resp = await rig.client.request<{ orders: number[] }>({
      method: 'GET',
      path: '/orders',
    });
    expect((resp.data as unknown as { __binary?: boolean }).__binary).toBeUndefined();
    expect(resp.data.orders).toEqual([1, 2, 3]);
  });

  it('keeps plain text/* responses as text, NOT base64', async () => {
    const rig = makeClient();
    cfg = rig.cfg;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });
    const resp = await rig.client.request<string>({
      method: 'GET',
      path: '/anything',
    });
    expect(typeof resp.data).toBe('string');
    expect(resp.data).toBe('Hello world');
  });

  it('handles empty binary response gracefully (null data)', async () => {
    const rig = makeClient();
    cfg = rig.cfg;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new ArrayBuffer(0), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    const resp = await rig.client.request({
      method: 'GET',
      path: '/empty.pdf',
    });
    expect(resp.data).toBeNull();
  });

  it('v0.5.1: rejects oversized binary by Content-Length header (no read into memory)', async () => {
    const rig = makeClient({ maxBinaryMb: 1 }); // 1 MB cap
    cfg = rig.cfg;
    let payloadFetched = false;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      payloadFetched = true;
      // Server claims 5 MB (5*1024*1024) — client should reject by header alone.
      return new Response(Buffer.alloc(100), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(5 * 1024 * 1024),
        },
      });
    });
    await expect(
      rig.client.request({ method: 'GET', path: '/huge.pdf' }),
    ).rejects.toThrow(/Binary response too large/);
    expect(payloadFetched).toBe(true);
  });

  it('v0.5.1: rejects oversized binary by actual size when Content-Length is absent', async () => {
    const rig = makeClient({ maxBinaryMb: 1 });
    cfg = rig.cfg;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // No content-length header; server lies. Real payload is 2 MB.
      return new Response(Buffer.alloc(2 * 1024 * 1024), {
        status: 200,
        headers: { 'content-type': 'application/pdf' }, // no content-length
      });
    });
    await expect(
      rig.client.request({ method: 'GET', path: '/huge.pdf' }),
    ).rejects.toThrow(/Binary response too large/);
  });

  it('v0.5.1: accepts binary that fits under the limit', async () => {
    const rig = makeClient({ maxBinaryMb: 1 });
    cfg = rig.cfg;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(Buffer.alloc(500 * 1024), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(500 * 1024),
        },
      });
    });
    const resp = await rig.client.request({ method: 'GET', path: '/small.pdf' });
    const data = resp.data as unknown as { sizeBytes: number };
    expect(data.sizeBytes).toBe(500 * 1024);
  });
});
