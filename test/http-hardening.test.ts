/**
 * v0.9.1: hardening tests for the HTTP surface added in v0.9.0.
 *
 * Covers:
 *   - DNS-rebinding protection defaults (resolveRebindingProtection): derived
 *     allowlists, validated explicit lists and fail-closed wildcard binds.
 *   - Streamable HTTP session contract: 400 for a missing Mcp-Session-Id,
 *     404 (-32001) for an unknown one (spec-mandated so clients re-initialize),
 *     503 above the session cap.
 *   - /healthz exposes only { ok, name, version } without auth.
 *   - Uniform webhook responses for valid and invalid secret candidates.
 *   - Webhook error contract: malformed JSON is answered with the same 200 for
 *     either secret branch, without recording or exposing parser diagnostics.
 *   - Webhook config semantics (AVITO_MCP_WEBHOOK_ENABLED / path normalization).
 *   - WebhookStore JSONL log: parent directory is created automatically.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { WebhookStore } from '../src/core/webhook-store.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/app.js';
import { resolveRebindingProtection } from '../src/http/mcp-http.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config, HttpConfig, WebhookConfig } from '../src/config.js';

const WEBHOOK_SECRET = 'hardening-webhook-secret-0123456789abcdef';
const SPECIAL_WEBHOOK_SECRET = 'base64-secret-0123456789abcdef/+=';
const MCP_ORIGIN = 'https://mcp.example.com';

interface RawWebhookResult {
  status: number;
  body: string;
  elapsedMs: number;
  connection?: string;
  socketClosedMs?: number;
}

function rawSlowWebhook(
  base: string,
  secret: string,
  options: { delayMs: number; complete: boolean },
): Promise<RawWebhookResult> {
  const body = JSON.stringify({ payload: { type: 'message', value: { chat_id: 'slow-body' } } });
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let responseResult: Omit<RawWebhookResult, 'socketClosedMs'> | undefined;
    let socketClosedMs: number | undefined;
    const finishIfReady = () => {
      if (!responseResult || (!options.complete && socketClosedMs === undefined)) return;
      settled = true;
      resolve({ ...responseResult, socketClosedMs });
    };
    const req = httpRequest(
      `${base}/avito/webhook/${secret}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          responseResult = {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            elapsedMs: Date.now() - startedAt,
            connection: res.headers.connection,
          };
          finishIfReady();
        });
      },
    );
    const safetyTimer = setTimeout(() => {
      if (!settled) req.destroy(new Error('slow webhook request did not receive a response'));
    }, 3_000);
    req.once('socket', (socket) => {
      socket.once('close', () => {
        socketClosedMs = Date.now() - startedAt;
        clearTimeout(safetyTimer);
        finishIfReady();
      });
    });
    req.once('error', (error) => {
      if (!settled && !responseResult) reject(error);
    });
    req.write(body.slice(0, 1));
    if (options.complete) {
      setTimeout(() => req.end(body.slice(1)), options.delayMs);
    }
  });
}

function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    transport: 'http',
    host: '127.0.0.1',
    port: 0, // ephemeral — the handle reports the real port
    publicUrl: 'https://mcp.example.com',
    auth: 'none',
    authTokens: [],
    allowNoAuth: true,
    allowedHosts: [],
    allowedOrigins: [],
    maxSessions: 100,
    sessionIdleSec: 1800,
    oauthTokenTtlSec: 3600,
    ...overrides,
  };
}

function makeWebhookConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    enabled: true,
    secret: WEBHOOK_SECRET,
    publicUrl: 'https://mcp.example.com',
    path: '/avito/webhook',
    bufferSize: 100,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345678,
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
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    confirmationSecret: undefined,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http: makeHttpConfig(),
    webhook: makeWebhookConfig(),
    ...overrides,
  } as Config;
}

async function startRig(overrides: Partial<Config> = {}): Promise<{
  handle: HttpServerHandle;
  base: string;
  cfg: Config;
  webhookStore: WebhookStore;
}> {
  const cfg = makeConfig(overrides);
  // DNS-rebinding allowlists are resolved before listen(). Reserve a concrete
  // test port so the derived Host entry matches the eventual request Host.
  if (cfg.http.port === 0) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    cfg.http.port = (probe.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  }
  const webhookStore = new WebhookStore(cfg.webhook.bufferSize, cfg.webhook.logFile);
  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
    idempotencyStore: new IdempotencyStore(cfg.idempotencyTtlSec * 1000),
    webhookStore,
  };
  const handle = await startHttpServer(ctx, cfg);
  return { handle, base: `http://127.0.0.1:${handle.port}`, cfg, webhookStore };
}

describe('DNS-rebinding protection defaults (resolveRebindingProtection)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives allowlists from publicUrl + bind address when none are configured', () => {
    const r = resolveRebindingProtection(makeHttpConfig({ port: 3000 }));
    expect(r.enabled).toBe(true);
    expect(r.allowedHosts).toContain('mcp.example.com'); // from publicUrl
    expect(r.allowedHosts).toContain('127.0.0.1:3000'); // bind address
    expect(r.allowedHosts).toContain('localhost:3000');
    expect(r.allowedOrigins).toContain('https://mcp.example.com');
  });

  it('explicit allowlists win over derivation', () => {
    const r = resolveRebindingProtection(makeHttpConfig({ allowedHosts: ['only.example:1234'] }));
    expect(r.enabled).toBe(true);
    expect(r.allowedHosts).toEqual(['only.example:1234']);
    expect(r.allowedOrigins).toContain(MCP_ORIGIN);
  });

  it('derives a missing Host list from explicit origins and rejects malformed entries', () => {
    const r = resolveRebindingProtection(
      makeHttpConfig({ allowedOrigins: ['https://ONLY.example'] }),
    );
    expect(r.allowedOrigins).toEqual(['https://only.example']);
    expect(r.allowedHosts).toEqual([
      'mcp.example.com',
      '127.0.0.1:0',
      'localhost:0',
      'only.example',
    ]);
    expect(() =>
      resolveRebindingProtection(
        makeHttpConfig({
          allowedHosts: ['mcp.example.com'],
          allowedOrigins: ['https://mcp.example.com/path'],
        }),
      ),
    ).toThrow(/ALLOWED_ORIGINS/);
  });

  it('wildcard bind without a usable public URL fails closed', () => {
    expect(() =>
      resolveRebindingProtection(
        makeHttpConfig({ host: '0.0.0.0', publicUrl: 'http://0.0.0.0:3000' }),
      ),
    ).toThrow(/cannot derive/i);
  });

  it('wildcard bind WITH an explicit public URL derives from it', () => {
    vi.stubEnv('AVITO_MCP_HTTP_PUBLIC_URL', 'https://mcp.example.com');
    const r = resolveRebindingProtection(makeHttpConfig({ host: '0.0.0.0' }));
    expect(r.enabled).toBe(true);
    expect(r.allowedHosts).toContain('mcp.example.com');
  });
});

describe('Streamable HTTP session contract + app surface', () => {
  let handle: HttpServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function initialize(base: string, token?: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'mcp.example.com',
        origin: MCP_ORIGIN,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'hardening-test', version: '1' },
        },
      }),
    });
  }

  it('POST /mcp without a session id (non-initialize) → 400', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('Mcp-Session-Id');
  });

  it('POST /mcp with an UNKNOWN session id → 404 -32001 (client must re-initialize)', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'session-lost-to-a-restart',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Session not found');
  });

  it('initialize beyond the session cap → 503', async () => {
    const rig = await startRig({ http: makeHttpConfig({ maxSessions: 0 }) });
    handle = rig.handle;

    const r = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(r.status).toBe(503);
  });

  it('reserves the session cap atomically across concurrent initialize calls', async () => {
    const rig = await startRig({ http: makeHttpConfig({ maxSessions: 1 }) });
    handle = rig.handle;

    const responses = await Promise.all([initialize(rig.base), initialize(rig.base)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 503]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
  });

  it('does not let a different authenticated principal reuse an existing session id', async () => {
    const tokenA = `test-bearer-principal-a-${'a'.repeat(32)}`;
    const tokenB = `test-bearer-principal-b-${'b'.repeat(32)}`;
    const rig = await startRig({
      http: makeHttpConfig({ auth: 'bearer', authTokens: [tokenA, tokenB] }),
    });
    handle = rig.handle;

    const initialized = await initialize(rig.base, tokenA);
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await initialized.arrayBuffer();

    const call = (token: string) =>
      fetch(`${rig.base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          host: 'mcp.example.com',
          origin: MCP_ORIGIN,
          'mcp-session-id': sessionId!,
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });

    const foreign = await call(tokenB);
    expect(foreign.status).toBe(404);
    const owner = await call(tokenA);
    expect(owner.status).toBe(200);
    await Promise.all([foreign.arrayBuffer(), owner.arrayBuffer()]);
  });

  it('rejects an Origin outside the derived allowlist', async () => {
    const rig = await startRig();
    handle = rig.handle;
    const response = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'mcp.example.com',
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'origin-test', version: '1' },
        },
      }),
    });
    expect(response.status).toBe(403);
  });

  it('applies Host and Origin protection to OAuth/DCR routes', async () => {
    const rig = await startRig({
      http: makeHttpConfig({
        auth: 'oauth',
        oauthOwnerPassword: 'oauth-rebinding-owner-password-strong',
      }),
    });
    handle = rig.handle;
    const body = JSON.stringify({
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'avito:mcp',
    });

    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${rig.base}/register`,
        {
          method: 'POST',
          headers: {
            host: 'attacker.example',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.once('error', reject);
      req.end(body);
    });
    expect(badHost).toBe(403);

    const badOrigin = await fetch(`${rig.base}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      body,
    });
    expect(badOrigin.status).toBe(403);

    const accepted = await fetch(`${rig.base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: MCP_ORIGIN },
      body,
    });
    expect(accepted.status).toBe(201);
    await accepted.arrayBuffer();
  });

  it('does not reap a session while its SSE request is active', async () => {
    const rig = await startRig({ http: makeHttpConfig({ sessionIdleSec: 1 }) });
    handle = rig.handle;
    const initialized = await initialize(rig.base);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await initialized.arrayBuffer();

    const stream = await fetch(`${rig.base}/mcp`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        host: 'mcp.example.com',
        origin: MCP_ORIGIN,
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': '2025-03-26',
      },
    });
    expect(stream.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const stillLive = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'mcp.example.com',
        origin: MCP_ORIGIN,
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(stillLive.status).not.toBe(404);
    await stillLive.arrayBuffer();
    await stream.body?.cancel();
  });

  it('/healthz answers a minimal payload (no deployment details)', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['name', 'ok', 'version']);
  });

  it('/readyz exposes only a readiness bit', async () => {
    const rig = await startRig();
    handle = rig.handle;
    const response = await fetch(`${rig.base}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('/readyz fails closed for incomplete credentials or unusable durable state', async () => {
    const missing = await startRig({ clientSecret: '' });
    handle = missing.handle;
    expect((await fetch(`${missing.base}/readyz`)).status).toBe(503);
    await handle.close();
    handle = undefined;

    const root = join(tmpdir(), `http-unusable-token-${randomBytes(6).toString('hex')}`);
    await fs.writeFile(root, 'not a directory');
    try {
      const unusable = await startRig({ tokenFile: join(root, 'token.json') });
      handle = unusable.handle;
      expect((await fetch(`${unusable.base}/readyz`)).status).toBe(503);
    } finally {
      await fs.rm(root, { force: true });
    }

    await handle?.close();
    handle = undefined;
    const runtimeRoot = join(tmpdir(), `http-unusable-runtime-${randomBytes(6).toString('hex')}`);
    await fs.writeFile(runtimeRoot, 'not a directory');
    try {
      const unusable = await startRig({ runtimeStateDir: join(runtimeRoot, 'runtime') });
      handle = unusable.handle;
      expect((await fetch(`${unusable.base}/readyz`)).status).toBe(503);
    } finally {
      await fs.rm(runtimeRoot, { force: true });
    }
  });

  it('/readyz is ready with an owned persistent OAuth store and shutdown releases it', async () => {
    const root = join(tmpdir(), `http-ready-oauth-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'state', 'oauth.json');
    try {
      const rig = await startRig({
        http: makeHttpConfig({
          auth: 'oauth',
          oauthOwnerPassword: 'readiness-owner-password-strong',
          oauthStoreFile: storeFile,
        }),
      });
      handle = rig.handle;
      await expect(fs.access(`${storeFile}.process.lock`)).resolves.toBeUndefined();
      const response = await fetch(`${rig.base}/readyz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await handle.close();
      handle = undefined;
      await expect(fs.access(`${storeFile}.process.lock`)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('releases the OAuth lease when HTTP bind fails during startup', async () => {
    const root = join(tmpdir(), `http-bind-failure-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    const blocker = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(0, '127.0.0.1', resolve);
      });
      const port = (blocker.address() as import('node:net').AddressInfo).port;
      const cfg = makeConfig({
        http: makeHttpConfig({
          port,
          auth: 'oauth',
          oauthOwnerPassword: 'bind-failure-owner-password-strong',
          oauthStoreFile: storeFile,
        }),
      });
      const webhookStore = new WebhookStore(cfg.webhook.bufferSize);
      const ctx: ToolContext = {
        client: new AvitoClient(cfg),
        config: cfg,
        pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
        idempotencyStore: new IdempotencyStore(cfg.idempotencyTtlSec * 1000),
        webhookStore,
      };
      await expect(startHttpServer(ctx, cfg)).rejects.toThrow(/EADDRINUSE/);
      await expect(fs.access(`${storeFile}.process.lock`)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('wrong webhook secrets are indistinguishable from accepted deliveries', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const event = JSON.stringify({ payload: { type: 'message', value: {} } });
    const wrongSecret = await fetch(`${rig.base}/avito/webhook/totally-wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: event,
    });
    const acceptedPing = await fetch(`${rig.base}/avito/webhook/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(wrongSecret.status).toBe(200);
    expect(acceptedPing.status).toBe(200);
    expect(await wrongSecret.text()).toBe(await acceptedPing.text());
    expect(rig.webhookStore.stats().total_received).toBe(0);
  });

  it('does not expose the webhook secret through a delayed raw request body', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const [wrong, correct] = await Promise.all([
      rawSlowWebhook(rig.base, 'totally-wrong', { delayMs: 300, complete: true }),
      rawSlowWebhook(rig.base, WEBHOOK_SECRET, { delayMs: 300, complete: true }),
    ]);

    expect(wrong.status).toBe(200);
    expect(correct.status).toBe(200);
    expect(wrong.body).toBe(correct.body);
    expect(wrong.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(correct.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(Math.abs(wrong.elapsedMs - correct.elapsedMs)).toBeLessThan(120);
    expect(rig.webhookStore.stats().total_received).toBe(1);
  });

  it('bounds incomplete webhook bodies without recording or revealing the secret', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const [wrong, correct] = await Promise.all([
      rawSlowWebhook(rig.base, 'totally-wrong', { delayMs: 0, complete: false }),
      rawSlowWebhook(rig.base, WEBHOOK_SECRET, { delayMs: 0, complete: false }),
    ]);

    expect(wrong.status).toBe(200);
    expect(correct.status).toBe(200);
    expect(wrong.body).toBe(correct.body);
    expect(wrong.elapsedMs).toBeLessThan(1_800);
    expect(correct.elapsedMs).toBeLessThan(1_800);
    expect(Math.abs(wrong.elapsedMs - correct.elapsedMs)).toBeLessThan(120);
    expect(wrong.connection).toBe('close');
    expect(correct.connection).toBe('close');
    expect(wrong.socketClosedMs).toBeLessThan(1_800);
    expect(correct.socketClosedMs).toBeLessThan(1_800);
    expect(rig.webhookStore.stats().total_received).toBe(0);
  });

  it('malformed JSON with the CORRECT secret is still answered 200 (Avito contract)', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/avito/webhook/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json at all',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('malformed JSON with a wrong secret is never recorded and gets the same 200', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/avito/webhook/wrong-secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json at all',
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain('at '); // no stack frames
    expect(text).not.toContain('node_modules');
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(rig.webhookStore.stats().total_received).toBe(0);
  });

  it('a valid delivery with the correct secret is recorded', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/avito/webhook/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'evt-h1',
        version: 'v3',
        payload: { type: 'message', value: { chat_id: 'ch1' } },
      }),
    });
    expect(r.status).toBe(200);
    expect(rig.webhookStore.stats().total_received).toBe(1);
    expect(rig.webhookStore.list()[0]!.chat_id).toBe('ch1');
  });

  it('decodes a canonical URL segment containing base64 /+= before secret comparison', async () => {
    const rig = await startRig({
      webhook: makeWebhookConfig({ secret: SPECIAL_WEBHOOK_SECRET }),
    });
    handle = rig.handle;
    const encoded = encodeURIComponent(SPECIAL_WEBHOOK_SECRET);
    expect(encoded).toContain('%2F%2B%3D');

    const response = await fetch(`${rig.base}/avito/webhook/${encoded}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'evt-special-secret',
        payload: { type: 'message', value: { chat_id: 'encoded-secret-chat' } },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(rig.webhookStore.list()[0]!.chat_id).toBe('encoded-secret-chat');
  });
});

describe('environment-backed config semantics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfigWith(env: Record<string, string>): Promise<Config> {
    vi.resetModules();
    vi.stubEnv('AVITO_ENV_FILE', '/dev/null'); // never read the repo's real .env
    // Neutralize anything inherited from the process environment first.
    for (const k of [
      'AVITO_MCP_WEBHOOK_SECRET',
      'AVITO_MCP_WEBHOOK_ENABLED',
      'AVITO_MCP_WEBHOOK_PATH',
      'AVITO_MCP_HTTP_MAX_SESSIONS',
      'AVITO_MCP_HTTP_SESSION_IDLE_SEC',
      'AVITO_TOKEN_FILE',
      'AVITO_MCP_RUNTIME_STATE_DIR',
    ]) {
      vi.stubEnv(k, '');
    }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import('../src/config.js');
    return mod.config;
  }

  it('a secret alone enables the receiver', async () => {
    const cfg = await loadConfigWith({ AVITO_MCP_WEBHOOK_SECRET: WEBHOOK_SECRET });
    expect(cfg.webhook.enabled).toBe(true);
  });

  it('AVITO_MCP_WEBHOOK_ENABLED=0 disables it even when the secret stays set', async () => {
    const cfg = await loadConfigWith({
      AVITO_MCP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      AVITO_MCP_WEBHOOK_ENABLED: '0',
    });
    expect(cfg.webhook.enabled).toBe(false);
  });

  it('AVITO_MCP_WEBHOOK_ENABLED=1 without a secret stays DISABLED (unusable receiver)', async () => {
    const cfg = await loadConfigWith({ AVITO_MCP_WEBHOOK_ENABLED: '1' });
    expect(cfg.webhook.enabled).toBe(false);
  });

  it('normalizes a webhook path without a leading slash', async () => {
    const cfg = await loadConfigWith({
      AVITO_MCP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      AVITO_MCP_WEBHOOK_PATH: 'hooks/avito',
    });
    expect(cfg.webhook.path).toBe('/hooks/avito');
  });

  it('parses the new session-control vars with sane defaults', async () => {
    const def = await loadConfigWith({});
    expect(def.http.maxSessions).toBe(100);
    expect(def.http.sessionIdleSec).toBe(1800);

    const custom = await loadConfigWith({
      AVITO_MCP_HTTP_MAX_SESSIONS: '7',
      AVITO_MCP_HTTP_SESSION_IDLE_SEC: '60',
    });
    expect(custom.http.maxSessions).toBe(7);
    expect(custom.http.sessionIdleSec).toBe(60);
  });

  it('derives runtime state beside the effective AVITO_TOKEN_FILE', async () => {
    const tokenFile = join(tmpdir(), 'custom-avito-state', 'token.json');
    const derived = await loadConfigWith({ AVITO_TOKEN_FILE: tokenFile });
    expect(derived.tokenFile).toBe(tokenFile);
    expect(derived.runtimeStateDir).toBe(join(dirname(tokenFile), 'runtime'));

    const explicit = join(tmpdir(), 'explicit-avito-runtime');
    const overridden = await loadConfigWith({
      AVITO_TOKEN_FILE: tokenFile,
      AVITO_MCP_RUNTIME_STATE_DIR: explicit,
    });
    expect(overridden.runtimeStateDir).toBe(explicit);
  });
});

describe('WebhookStore JSONL durability', () => {
  it('creates the log file parent directory automatically', async () => {
    const root = join(tmpdir(), `wh-log-${randomBytes(6).toString('hex')}`);
    const logFile = join(root, 'nested', 'events.jsonl');
    try {
      const store = new WebhookStore(10, logFile);
      store.record({ id: 'e1', payload: { type: 'message', value: {} } });

      // appendFile is fire-and-forget — give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const written = await fs.readFile(logFile, 'utf8');
      expect(written).toContain('"e1"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('HTTP shutdown waits for a delayed webhook append', async () => {
    const root = join(tmpdir(), `wh-shutdown-${randomBytes(6).toString('hex')}`);
    const logFile = join(root, 'events.jsonl');
    let releaseAppend: (() => void) | undefined;
    try {
      const rig = await startRig({ webhook: makeWebhookConfig({ logFile }) });
      const internals = rig.webhookStore as unknown as {
        persistLine(line: string): Promise<void>;
      };
      const originalPersist = internals.persistLine.bind(rig.webhookStore);
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      internals.persistLine = async (line: string) => {
        markStarted?.();
        await gate;
        await originalPersist(line);
      };

      rig.webhookStore.record({ id: 'shutdown-event', payload: { type: 'message', value: {} } });
      await started;
      let closed = false;
      const closing = rig.handle.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);

      releaseAppend?.();
      await closing;
      expect(await fs.readFile(logFile, 'utf8')).toContain('shutdown-event');
    } finally {
      releaseAppend?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
