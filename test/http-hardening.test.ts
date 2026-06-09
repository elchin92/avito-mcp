/**
 * v0.9.1: hardening tests for the HTTP surface added in v0.9.0.
 *
 * Covers:
 *   - DNS-rebinding protection defaults (resolveRebindingProtection): derived
 *     allowlists when none are configured, explicit lists win, wildcard-bind
 *     opt-out.
 *   - Streamable HTTP session contract: 400 for a missing Mcp-Session-Id,
 *     404 (-32001) for an unknown one (spec-mandated so clients re-initialize),
 *     503 above the session cap.
 *   - /healthz exposes only { ok, name, version } without auth.
 *   - Uniform JSON 404: unknown path and wrong webhook secret are
 *     indistinguishable.
 *   - Webhook error contract: malformed JSON with the correct secret is still
 *     answered 200 (Avito never retries/disables); elsewhere body-parse errors
 *     yield a terse JSON 400 with no stack trace.
 *   - Webhook config semantics (AVITO_MCP_WEBHOOK_ENABLED / path normalization).
 *   - WebhookStore JSONL log: parent directory is created automatically.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { WebhookStore } from '../src/core/webhook-store.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/app.js';
import { resolveRebindingProtection } from '../src/http/mcp-http.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config, HttpConfig, WebhookConfig } from '../src/config.js';

const WEBHOOK_SECRET = 'hardening-secret-xyz1';

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
    const r = resolveRebindingProtection(
      makeHttpConfig({ allowedHosts: ['only.example:1234'] }),
    );
    expect(r.enabled).toBe(true);
    expect(r.allowedHosts).toEqual(['only.example:1234']);
    expect(r.allowedOrigins).toBeUndefined();
  });

  it('wildcard bind without an explicit public URL keeps protection off (nothing to derive)', () => {
    vi.stubEnv('AVITO_MCP_HTTP_PUBLIC_URL', '');
    const r = resolveRebindingProtection(makeHttpConfig({ host: '0.0.0.0' }));
    expect(r.enabled).toBe(false);
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

  it('/healthz answers a minimal payload (no deployment details)', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['name', 'ok', 'version']);
  });

  it('unknown path and wrong webhook secret produce the SAME JSON 404', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const event = JSON.stringify({ payload: { type: 'message', value: {} } });
    const wrongSecret = await fetch(`${rig.base}/avito/webhook/totally-wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: event,
    });
    const unknownPath = await fetch(`${rig.base}/no/such/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: event,
    });

    expect(wrongSecret.status).toBe(404);
    expect(unknownPath.status).toBe(404);
    expect(wrongSecret.headers.get('content-type')).toBe(unknownPath.headers.get('content-type'));
    expect(await wrongSecret.text()).toBe(await unknownPath.text());
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

  it('malformed JSON elsewhere yields a terse JSON 400 — no stack trace', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const r = await fetch(`${rig.base}/avito/webhook/wrong-secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json at all',
    });
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain('at '); // no stack frames
    expect(text).not.toContain('node_modules');
    expect(JSON.parse(text)).toEqual({ error: 'bad_request' });
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
});

describe('webhook config semantics (buildWebhookConfig via env)', () => {
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
    ]) {
      vi.stubEnv(k, '');
    }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import('../src/config.js');
    return mod.config;
  }

  it('a secret alone enables the receiver', async () => {
    const cfg = await loadConfigWith({ AVITO_MCP_WEBHOOK_SECRET: 's3cr3t' });
    expect(cfg.webhook.enabled).toBe(true);
  });

  it('AVITO_MCP_WEBHOOK_ENABLED=0 disables it even when the secret stays set', async () => {
    const cfg = await loadConfigWith({
      AVITO_MCP_WEBHOOK_SECRET: 's3cr3t',
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
      AVITO_MCP_WEBHOOK_SECRET: 's3cr3t',
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
});
