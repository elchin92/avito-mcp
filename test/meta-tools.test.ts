/**
 * Tests for meta-tools (v0.7.0): meta_health, meta_auth_status, meta_capabilities.
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
import { IdempotencyStore } from '../src/core/idempotency.js';
import { register as registerMeta } from '../src/domains/meta.js';
import type { ToolContext } from '../src/core/tool-factory.js';
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

async function makeRig(cfg: Config) {
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000);
  const avito = new AvitoClient(cfg);
  const server = new McpServer({ name: 'avito-mcp', version: '0.7.0' });
  const ctx: ToolContext = { client: avito, config: cfg, pendingStore, idempotencyStore };
  registerMeta(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return { client };
}

describe('meta_health', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('returns structured snapshot with capabilities/safety/counters', async () => {
    const cfg = makeConfig({ dryRunDefault: true });
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'meta_health', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.ok).toBe(true);
    expect(sc.name).toBe('avito-mcp');
    expect(sc.version).toBeDefined();
    expect((sc.safety as Record<string, unknown>).mode).toBe('full_access');
    expect((sc.safety as Record<string, unknown>).dryRunDefault).toBe(true);
    expect((sc.counters as Record<string, unknown>).pendingActions).toBe(0);
    expect((sc.counters as Record<string, unknown>).idempotencyEntries).toBe(0);
  });
});

describe('meta_capabilities', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('reflects current config (mode, features, lists)', async () => {
    // allowTools includes meta_capabilities so the tool itself is still visible
    // (allowlist is literal — anything not in it is hidden).
    const cfg = makeConfig({
      mode: 'guarded',
      allowTools: ['x', 'y', 'meta_capabilities'],
      denyTools: ['z'],
      confirmationMode: 'all_destructive',
    });
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'meta_capabilities', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.mode).toBe('guarded');
    expect(sc.allowToolsCount).toBe(3); // x, y, meta_capabilities
    expect(sc.denyToolsCount).toBe(1);
    expect(sc.confirmationMode).toBe('all_destructive');
    const features = sc.features as Record<string, unknown>;
    expect(features.dryRun).toBe(true);
    expect(features.idempotency).toBe(true);
    expect(features.confirmation).toBe(true);
  });
});

describe('meta_auth_status', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('reports tokenPresent=false when token file does not exist', async () => {
    const cfg = makeConfig();
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'meta_auth_status', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.configured).toBe(true);
    expect(sc.tokenPresent).toBe(false);
    expect(sc.expiresInSec).toBeNull();
    // probe defaulted to false → no refresh attempted, probeOk null
    expect(sc.probeOk).toBeNull();
  });

  it('reports tokenPresent=true with expiresInSec when token file exists', async () => {
    const cfg = makeConfig();
    // Write a fake token file directly
    await fs.writeFile(
      cfg.tokenFile,
      JSON.stringify({ accessToken: 'never-shown', expiresAt: Date.now() + 600_000 }),
    );
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'meta_auth_status', arguments: {} });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.tokenPresent).toBe(true);
    expect(typeof sc.expiresInSec).toBe('number');
    expect(sc.expiresInSec as number).toBeGreaterThan(0);
    // CRITICAL: actual token value MUST NOT appear in the output
    const json = JSON.stringify(sc);
    expect(json).not.toContain('never-shown');
  });
});
