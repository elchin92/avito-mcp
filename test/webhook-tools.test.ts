/**
 * v0.9.0: integration-ish tests for the webhook domain tools (src/domains/webhook.ts).
 *
 * Mounts the webhook domain register against an InMemoryTransport (same approach as
 * test/registry.test.ts) with a ToolContext whose webhookStore already holds a couple of
 * recorded events, then asserts:
 *   - messenger_get_webhook_events returns the recorded events (newest-first), and
 *   - messenger_get_webhook_status reports enabled=true with the secret MASKED (never echoed).
 *
 * The domain register is imported lazily inside makeRig so a missing/renamed export gives a
 * clear failure here rather than a load crash.
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
import { WebhookStore } from '../src/core/webhook-store.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config, HttpConfig, WebhookConfig } from '../src/config.js';
import { configuredWebhookReceiverUrl } from '../src/domains/webhook.js';

const WEBHOOK_SECRET = 'super-secret-token-abcd';
const SPECIAL_WEBHOOK_SECRET = 'base64-secret-0123456789abcdef/+=';

function makeHttpConfig(): HttpConfig {
  return {
    transport: 'stdio',
    host: '127.0.0.1',
    port: 8080,
    publicUrl: 'https://mcp.example.com',
    auth: 'none',
    authTokens: [],
    allowNoAuth: true,
    allowedHosts: [],
    allowedOrigins: [],
    maxSessions: 100,
    sessionIdleSec: 1800,
    oauthTokenTtlSec: 3600,
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

/** A realistic Avito messenger envelope (postWebhookV3 shape). */
function makeEnvelope(chatId: string, id: string): unknown {
  return {
    id,
    version: 'v3',
    timestamp: 1_717_000_000,
    payload: {
      type: 'message',
      value: { chat_id: chatId, author_id: 7, type: 'text', user_id: 12345678 },
    },
  };
}

async function makeRig(
  overrides: Partial<Config> = {},
  seed = true,
  domain: 'webhook' | 'messenger' = 'webhook',
) {
  const cfg = makeConfig(overrides);
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const webhookStore = new WebhookStore(cfg.webhook.bufferSize, cfg.webhook.logFile);
  if (seed) {
    webhookStore.record(makeEnvelope('c1', 'evt-1'));
    webhookStore.record(makeEnvelope('c2', 'evt-2'));
  }
  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore,
    webhookStore,
  };

  const { register } =
    domain === 'webhook'
      ? await import('../src/domains/webhook.js')
      : await import('../src/domains/messenger.js');
  const server = new McpServer({ name: 'webhook-test', version: '0.0.0' });
  register(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(b);
  return { server, client, ctx, cfg, webhookStore };
}

function parseStructured<T = Record<string, unknown>>(result: {
  structuredContent?: unknown;
  content?: unknown;
}): T {
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as T;
}

describe('webhook domain tools', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('registers the two read tools (events + status)', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('messenger_get_webhook_events');
    expect(names).toContain('messenger_get_webhook_status');
  });

  it('messenger_get_webhook_events returns the recorded events, newest-first', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({ name: 'messenger_get_webhook_events', arguments: {} });
    expect(r.isError).not.toBe(true);
    const payload = parseStructured<{
      enabled: boolean;
      events: Array<{ id?: string; chat_id?: string }>;
      count: number;
    }>(r as { structuredContent?: unknown; content?: unknown });
    expect(payload.enabled).toBe(true);
    expect(payload.count).toBe(2);
    // Newest-first: evt-2 then evt-1.
    expect(payload.events.map((e) => e.id)).toEqual(['evt-2', 'evt-1']);
    expect(payload.events.map((e) => e.chat_id)).toEqual(['c2', 'c1']);
  });

  it('messenger_get_webhook_events filters by chat_id', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_get_webhook_events',
      arguments: { chat_id: 'c1' },
    });
    const payload = parseStructured<{
      events: Array<{ id?: string; chat_id?: string }>;
      count: number;
    }>(r as { structuredContent?: unknown; content?: unknown });
    expect(payload.count).toBe(1);
    expect(payload.events[0]!.chat_id).toBe('c1');
    expect(payload.events[0]!.id).toBe('evt-1');
  });

  it('messenger_get_webhook_status reports enabled + a MASKED secret (never the raw secret)', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({ name: 'messenger_get_webhook_status', arguments: {} });
    expect(r.isError).not.toBe(true);
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = parseStructured<{
      enabled: boolean;
      public_url: string | null;
      subscribe_url: string | null;
      stats: { retained: number; total_received: number } | null;
    }>(r as { structuredContent?: unknown; content?: unknown });

    expect(payload.enabled).toBe(true);
    expect(payload.public_url).toBe('https://mcp.example.com');

    // The raw secret must NEVER appear anywhere in the response.
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(payload)).not.toContain(WEBHOOK_SECRET);

    // subscribe_url is present but masked: only the last 4 chars of the secret survive.
    expect(payload.subscribe_url).toBeTruthy();
    expect(payload.subscribe_url).toContain(WEBHOOK_SECRET.slice(-4));
    expect(payload.subscribe_url).toContain('•'); // masking bullet

    // Buffer stats reflect the two seeded events.
    expect(payload.stats).not.toBeNull();
    expect(payload.stats!.retained).toBe(2);
    expect(payload.stats!.total_received).toBe(2);
  });

  it('messenger_get_webhook_events reports disabled cleanly when no webhookStore is wired', async () => {
    const cfg = makeConfig();
    const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
    const ctx: ToolContext = { client: new AvitoClient(cfg), config: cfg, pendingStore };
    const { register } = await import('../src/domains/webhook.js');
    const server = new McpServer({ name: 'webhook-test-nostore', version: '0.0.0' });
    register(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(b);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const r = await client.callTool({ name: 'messenger_get_webhook_events', arguments: {} });
    expect(r.isError).not.toBe(true);
    const payload = parseStructured<{ enabled: boolean; count: number }>(
      r as { structuredContent?: unknown; count?: number },
    );
    expect(payload.enabled).toBe(false);
    expect(payload.count).toBe(0);
  });
});

describe('messenger_register_webhook (v0.9.1 hardening)', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  type Preview = { request_preview: { body: { url?: string } } };

  it('dry-run validates but redacts the configured receiver URL', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true },
    });
    expect(r.isError).not.toBe(true);
    const payload = parseStructured<Preview>(r as { structuredContent?: unknown });
    expect(payload.request_preview.body.url).toBe('[redacted webhook URL]');
    expect(JSON.stringify(r)).not.toContain(WEBHOOK_SECRET);
  });

  it('canonicalizes a base64 /+= secret as one exact path segment and keeps dry-run redacted', async () => {
    const webhook = makeWebhookConfig({ secret: SPECIAL_WEBHOOK_SECRET });
    const expectedUrl = configuredWebhookReceiverUrl(webhook);
    expect(expectedUrl).toBe(
      `https://mcp.example.com/avito/webhook/${encodeURIComponent(SPECIAL_WEBHOOK_SECRET)}`,
    );
    expect(expectedUrl).toContain('%2F%2B%3D');

    const rig = await makeRig({ webhook });
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };
    const accepted = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true, url: expectedUrl },
    });
    expect(accepted.isError).not.toBe(true);
    expect(
      parseStructured<Preview>(accepted as { structuredContent?: unknown; content?: unknown })
        .request_preview.body.url,
    ).toBe('[redacted webhook URL]');
    expect(JSON.stringify(accepted)).not.toContain(SPECIAL_WEBHOOK_SECRET);
    expect(JSON.stringify(accepted)).not.toContain(expectedUrl);

    const legacySplitUrl = `https://mcp.example.com/avito/webhook/${SPECIAL_WEBHOOK_SECRET}`;
    const rejected = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true, url: legacySplitUrl },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain('arbitrary webhook destinations are not allowed');

    const status = await rig.client.callTool({
      name: 'messenger_get_webhook_status',
      arguments: {},
    });
    const subscribeUrl = parseStructured<{ subscribe_url: string }>(
      status as { structuredContent?: unknown; content?: unknown },
    ).subscribe_url;
    expect(subscribeUrl).not.toContain(SPECIAL_WEBHOOK_SECRET);
    expect(new URL(subscribeUrl).pathname.split('/')).toHaveLength(4);
  });

  it('uses public risk so money_public mode requires confirmation', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: {},
    });
    const payload = parseStructured<{ requires_confirmation: boolean; risk: string }>(
      r as { structuredContent?: unknown; content?: unknown },
    );
    expect(payload.requires_confirmation).toBe(true);
    expect(payload.risk).toBe('public');
    expect(JSON.stringify(r)).not.toContain(WEBHOOK_SECRET);
  });

  it('rejects a loopback public URL — Avito could never deliver to it', async () => {
    const rig = await makeRig({
      webhook: makeWebhookConfig({ publicUrl: 'http://127.0.0.1:3000' }),
    });
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true },
    });
    const text = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(text).toContain('not reachable from Avito');
  });

  it('rejects explicit url override when the receiver is NOT configured', async () => {
    const rig = await makeRig({
      webhook: makeWebhookConfig({ enabled: false, secret: undefined }),
    });
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true, url: 'https://hooks.example.com/avito-events' },
    });
    const text = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(text).toContain('not configured');
  });

  it('rejects arbitrary explicit url overrides even when the receiver is configured', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true, url: 'https://hooks.example.com/avito-events' },
    });
    const text = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(text).toContain('arbitrary webhook destinations are not allowed');
  });

  it('accepts an explicit url only when it matches the configured receiver', async () => {
    const rig = await makeRig();
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const expectedUrl = `https://mcp.example.com/avito/webhook/${WEBHOOK_SECRET}`;
    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true, url: expectedUrl },
    });
    expect(r.isError).not.toBe(true);
    const payload = parseStructured<Preview>(r as { structuredContent?: unknown });
    expect(payload.request_preview.body.url).toBe('[redacted webhook URL]');
    expect(JSON.stringify(r)).not.toContain(WEBHOOK_SECRET);
  });

  it('errors clearly when unconfigured and no url is given', async () => {
    const rig = await makeRig({
      webhook: makeWebhookConfig({ enabled: false, secret: undefined }),
    });
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };

    const r = await rig.client.callTool({
      name: 'messenger_register_webhook',
      arguments: { dryRun: true },
    });
    const text = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(text).toContain('not configured');
  });
});

describe('messenger_post_webhook_v3 configured receiver enforcement', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  type Preview = { request_preview: { body: { url?: string } } };

  async function makeMessengerRig() {
    const rig = await makeRig({}, false, 'messenger');
    cleanup = async () => {
      await rig.client.close();
      await fs.rm(rig.cfg.tokenFile, { force: true });
    };
    return rig;
  }

  it('rejects an arbitrary webhook destination', async () => {
    const rig = await makeMessengerRig();
    const r = await rig.client.callTool({
      name: 'messenger_post_webhook_v3',
      arguments: { dryRun: true, url: 'https://attacker.example/collect' },
    });
    const text = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(r.isError).toBe(true);
    expect(text).toContain('arbitrary webhook destinations are not allowed');
    expect(rig.ctx.pendingStore.list()).toEqual([]);
  });

  it('accepts only the configured receiver and redacts its dry-run preview', async () => {
    const rig = await makeMessengerRig();
    const configuredUrl = `https://mcp.example.com/avito/webhook/${WEBHOOK_SECRET}`;
    const r = await rig.client.callTool({
      name: 'messenger_post_webhook_v3',
      arguments: { dryRun: true, url: configuredUrl },
    });
    expect(r.isError).not.toBe(true);
    const payload = parseStructured<Preview>(r as { structuredContent?: unknown });
    expect(payload.request_preview.body.url).toBe('[redacted webhook URL]');
    expect(JSON.stringify(r)).not.toContain(configuredUrl);
    expect(JSON.stringify(r)).not.toContain(WEBHOOK_SECRET);
  });

  it('uses public risk so money_public mode requires confirmation', async () => {
    const rig = await makeMessengerRig();
    const configuredUrl = `https://mcp.example.com/avito/webhook/${WEBHOOK_SECRET}`;
    const r = await rig.client.callTool({
      name: 'messenger_post_webhook_v3',
      arguments: { url: configuredUrl },
    });
    const payload = parseStructured<{ requires_confirmation: boolean; risk: string }>(
      r as { structuredContent?: unknown; content?: unknown },
    );
    expect(payload.requires_confirmation).toBe(true);
    expect(payload.risk).toBe('public');
  });
});
