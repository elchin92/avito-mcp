import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AvitoClient } from '../src/core/client.js';
import { AvitoApiError } from '../src/core/errors.js';
import type { Config } from '../src/config.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '50',
      ...extraHeaders,
    },
  });
}

function tokenResponse(token = 'tok', expiresIn = 3600) {
  return jsonResponse({ access_token: token, expires_in: expiresIn, token_type: 'bearer' });
}

describe('AvitoClient', () => {
  let cfg: Config;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cfg = makeConfig();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cfg.tokenFile, { force: true });
  });

  it('fetches token then makes authenticated request', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('abc'))
      .mockResolvedValueOnce(jsonResponse({ id: 1, name: 'me' }));

    const client = new AvitoClient(cfg);
    const r = await client.request({ method: 'GET', path: '/core/v1/accounts/self' });

    expect(r.status).toBe(200);
    expect(r.data).toEqual({ id: 1, name: 'me' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe('https://api.test.example/token');
    expect((tokenInit as RequestInit).method).toBe('POST');
    const [apiUrl, apiInit] = fetchMock.mock.calls[1]!;
    expect(apiUrl).toBe('https://api.test.example/core/v1/accounts/self');
    expect((apiInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer abc' });
  });

  it('handles 401 by refreshing token and retrying once', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('first-token'))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401, headers: {} }))
      .mockResolvedValueOnce(tokenResponse('second-token'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new AvitoClient(cfg);
    const r = await client.request({ method: 'GET', path: '/anything' });
    expect(r.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws AvitoApiError after second 401', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('t1'))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(tokenResponse('t2'))
      .mockResolvedValueOnce(new Response('still unauthorized', { status: 401 }));

    const client = new AvitoClient(cfg);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      AvitoApiError,
    );
  });

  it('retries on 429 with exponential backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('rate-limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate-limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ done: true }));

    const client = new AvitoClient(cfg, {
      retry: { retry429BaseMs: 5, max429Retries: 3, retry5xxBackoffMs: 5, max5xxRetries: 1 },
    });
    const r = await client.request({ method: 'GET', path: '/x' });
    expect(r.data).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries once on 5xx', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new AvitoClient(cfg, {
      retry: { retry429BaseMs: 5, max429Retries: 3, retry5xxBackoffMs: 5, max5xxRetries: 1 },
    });
    const r = await client.request({ method: 'GET', path: '/x' });
    expect(r.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a POST after a 5xx response by default', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('possibly processed', { status: 503 }));
    const client = new AvitoClient(cfg, {
      retry: { retry5xxBackoffMs: 1, max5xxRetries: 3, retryJitterRatio: 0 },
    });
    await expect(
      client.request({ method: 'POST', path: '/mutation', body: { value: 1 } }),
    ).rejects.toBeInstanceOf(AvitoApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels a retryable response body before the next attempt', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        canceled = true;
      },
    });
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(body, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new AvitoClient(cfg, {
      retry: { retry5xxBackoffMs: 1, max5xxRetries: 1, retryJitterRatio: 0 },
    });
    await client.request({ method: 'GET', path: '/retry' });
    expect(canceled).toBe(true);
  });

  it('caps Retry-After before retrying', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new AvitoClient(cfg, {
      retry: { max429Retries: 1, maxRetryAfterMs: 5, retryJitterRatio: 0 },
    });
    const started = Date.now();
    await client.request({ method: 'GET', path: '/retry-after' });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('does not retry 5xx beyond max5xxRetries', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('boom again', { status: 502 }));

    const client = new AvitoClient(cfg, {
      retry: { retry429BaseMs: 5, max429Retries: 0, retry5xxBackoffMs: 5, max5xxRetries: 1 },
    });
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      AvitoApiError,
    );
  });

  it('throws AvitoApiError on non-retryable 4xx', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));

    const client = new AvitoClient(cfg);
    const err = await client.request({ method: 'GET', path: '/missing' }).catch((e) => e);
    expect(err).toBeInstanceOf(AvitoApiError);
    expect(err.status).toBe(404);
  });

  it('records rate-limit headers per domain', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({}, 200, {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '42',
      }),
    );

    const client = new AvitoClient(cfg);
    await client.request({ method: 'GET', path: '/messenger/v3/x' });
    const snaps = client.rateLimiter.getStatus();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.domain).toBe('messenger');
    expect(snaps[0]?.limit).toBe(60);
    expect(snaps[0]?.remaining).toBe(42);
  });

  it('serialises JSON body and sets Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({}));

    const client = new AvitoClient(cfg);
    await client.request({
      method: 'POST',
      path: '/x',
      body: { a: 1 },
    });
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('serialises form-urlencoded body', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({}));

    const client = new AvitoClient(cfg);
    await client.request({
      method: 'POST',
      path: '/x',
      body: { a: 'hello world', b: 1 },
      bodyContentType: 'application/x-www-form-urlencoded',
    });
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.body).toBe('a=hello+world&b=1');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
  });

  it('skips Authorization when auth=false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ public: true }));
    const client = new AvitoClient(cfg);
    const r = await client.request({ method: 'GET', path: '/public/thing', auth: false });
    expect(r.data).toEqual({ public: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds only code-owned allowlisted static headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new AvitoClient(cfg);
    await client.request({
      method: 'GET',
      path: '/public/thing',
      auth: false,
      staticHeaders: { 'X-Source': 'operator-configured' },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ 'X-Source': 'operator-configured' });

    await expect(
      client.request({
        method: 'GET',
        path: '/public/thing',
        auth: false,
        staticHeaders: { Authorization: 'model-controlled' } as never,
      }),
    ).rejects.toThrow(/not allowlisted/);
  });

  it('supports an explicitly opted-in GET JSON body through the low-level transport', async () => {
    let seenBody = '';
    let seenSource: string | undefined;
    const server = createServer((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        seenBody += chunk;
      });
      req.on('end', () => {
        const source = req.headers['x-source'];
        seenSource = Array.isArray(source) ? source[0] : source;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      cfg.baseUrl = `http://127.0.0.1:${address.port}`;
      const client = new AvitoClient(cfg);
      const result = await client.request({
        method: 'GET',
        path: '/swagger-get-body',
        auth: false,
        body: { ids: [1, 2] },
        allowGetBody: true,
        staticHeaders: { 'X-Source': 'cpa' },
      });
      expect(result.data).toEqual({ ok: true });
      expect(seenBody).toBe('{"ids":[1,2]}');
      expect(seenSource).toBe('cpa');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
