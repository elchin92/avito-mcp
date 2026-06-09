/**
 * MCP resources tests (v0.6.0). Spin up an in-memory client+server, register
 * domains + resources, and exercise listResources / readResource / subscribe.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { WebhookStore } from '../src/core/webhook-store.js';
import { registerResources, PENDING_ACTIONS_URI } from '../src/resources.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';

// Distinctive values so the leak assertions can grep the raw resource text.
const OWNER_PASSWORD = 'owner-pass-LEAK-CANARY-1';
const BEARER_TOKEN = 'bearer-LEAK-CANARY-2';
const WEBHOOK_SECRET = 'webhook-LEAK-CANARY-3';

function makeConfig(): Config {
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
      authTokens: [BEARER_TOKEN],
      allowNoAuth: false,
      allowedHosts: [],
      allowedOrigins: [],
      maxSessions: 100,
      sessionIdleSec: 1800,
      oauthOwnerPassword: OWNER_PASSWORD,
      oauthTokenTtlSec: 3600,
      oauthStoreFile: '/var/lib/avito-mcp/oauth.json',
    },
    webhook: {
      enabled: true,
      secret: WEBHOOK_SECRET,
      publicUrl: 'http://127.0.0.1:3000',
      path: '/avito/webhook',
      bufferSize: 100,
      logFile: '/var/log/avito-mcp/webhooks.jsonl',
    },
  };
}

async function makeRig() {
  const cfg = makeConfig();
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const webhookStore = new WebhookStore(cfg.webhook.bufferSize);
  const avito = new AvitoClient(cfg);
  const server = new McpServer(
    { name: 'avito-mcp', version: '0.6.0' },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
      },
    },
  );
  const ctx: ToolContext = { client: avito, config: cfg, pendingStore, webhookStore, server };
  registerResources(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(b);
  return { server, client, ctx, cfg };
}

describe('MCP resources — listing & static reads', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('lists at least the 5 static resources + swagger files', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('avito://docs/safety');
    expect(uris).toContain('avito://manifest');
    expect(uris).toContain('avito://state/config');
    expect(uris).toContain('avito://state/rate-limits');
    expect(uris).toContain(PENDING_ACTIONS_URI);
    // Should include swagger entries (template list callback).
    const swaggers = uris.filter((u) => u.startsWith('avito://swaggers/'));
    expect(swaggers.length).toBeGreaterThan(10); // 18 swagger files in the repo
  });

  it('reads avito://state/config without leaking secrets', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const res = await client.readResource({ uri: 'avito://state/config' });
    const text = (res.contents[0] as { text: string }).text;
    const body = JSON.parse(text);
    expect(body.config.clientId).toBe('[redacted]');
    expect(body.config.clientSecret).toBe('[redacted]');
    expect(body.config.tokenFile).toBe('[redacted]');
    expect(body.config.profileId).toBe(12345); // not redacted
    expect(body.config.mode).toBe('full_access');
    // confirmationSecret was undefined → exposed as null, not the value.
    expect(body.config.confirmationSecret).toBeNull();

    // v0.9.1: the nested http/webhook blocks must not leak their secrets either.
    expect(body.config.http.oauthOwnerPassword).toBe('[redacted]');
    expect(body.config.http.authTokens).toBe('[redacted]');
    expect(body.config.http.oauthStoreFile).toBe('[redacted]');
    expect(body.config.webhook.secret).toBe('[redacted]');
    expect(body.config.webhook.logFile).toBe('[redacted]');
    // Non-secret nested fields survive intact.
    expect(body.config.http.publicUrl).toBe('http://127.0.0.1:3000');
    expect(body.config.webhook.path).toBe('/avito/webhook');
    // Belt and braces: no secret VALUE appears anywhere in the serialized resource.
    for (const secret of ['cid', 'sec', OWNER_PASSWORD, BEARER_TOKEN, WEBHOOK_SECRET]) {
      expect(text).not.toContain(`"${secret}"`);
    }
  });

  it('unsubscribes pending/webhook store listeners when the server closes', async () => {
    const { server, client, ctx, cfg } = await makeRig();
    cleanup = async () => {
      await fs.rm(cfg.tokenFile, { force: true });
    };

    // unsubscribe() REPLACES the listeners array, so read it fresh each time.
    const listenerCount = (store: unknown): number =>
      (store as { listeners: unknown[] }).listeners.length;
    expect(listenerCount(ctx.pendingStore)).toBe(1);
    expect(listenerCount(ctx.webhookStore)).toBe(1);

    // Streamable HTTP closes the per-session server exactly like this; the
    // process-wide stores must not retain the session's listeners afterwards.
    await client.close();
    await server.close();
    expect(listenerCount(ctx.pendingStore)).toBe(0);
    expect(listenerCount(ctx.webhookStore)).toBe(0);
  });

  it('reads avito://state/pending-actions reflecting live store', async () => {
    const { client, ctx, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    // Empty first
    const res1 = await client.readResource({ uri: PENDING_ACTIONS_URI });
    const body1 = JSON.parse((res1.contents[0] as { text: string }).text);
    expect(body1.count).toBe(0);

    // Add one
    ctx.pendingStore.create({
      toolName: 'items_update_price',
      risk: 'public',
      summary: 'test',
      args: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });

    const res2 = await client.readResource({ uri: PENDING_ACTIONS_URI });
    const body2 = JSON.parse((res2.contents[0] as { text: string }).text);
    expect(body2.count).toBe(1);
    expect(body2.pending[0].tool).toBe('items_update_price');
    expect(body2.pending[0].risk).toBe('public');
    // args / execute did not leak:
    expect(body2.pending[0].args).toBeUndefined();
  });

  it('emits notifications/resources/updated when pending-actions change', async () => {
    const { client, ctx, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const onUpdated = vi.fn();
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
      onUpdated(notif.params.uri);
    });

    await client.subscribeResource({ uri: PENDING_ACTIONS_URI });
    ctx.pendingStore.create({
      toolName: 'x',
      risk: 'money',
      summary: 's',
      args: {},
      execute: async () => ({ content: [] }),
    });

    // Notifications are asynchronous — give the server a chance to send.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onUpdated).toHaveBeenCalledWith(PENDING_ACTIONS_URI);
  });

  it('reads avito://swaggers/{slug} — happy path + path-traversal rejected', async () => {
    const { client, cfg } = await makeRig();
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };

    const { resources } = await client.listResources();
    const oneSwagger = resources.find((r) => r.uri.startsWith('avito://swaggers/'));
    expect(oneSwagger).toBeDefined();

    const res = await client.readResource({ uri: oneSwagger!.uri });
    expect(res.contents[0]).toMatchObject({ mimeType: 'application/json' });
    expect((res.contents[0] as { text: string }).text.length).toBeGreaterThan(100);

    // Path-traversal attempt:
    await expect(
      client.readResource({ uri: 'avito://swaggers/..%2F..%2Fetc%2Fpasswd' }),
    ).rejects.toThrow();
  });
});
