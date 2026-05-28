/**
 * v0.7.4: introspection-without-credentials.
 *
 * The server must start and answer tools/list / resources / prompts even when
 * Client_id / Client_secret / Profile_id are absent (needed by registry indexers
 * like Glama and for `npx avito-mcp` previews). Credentials are enforced lazily —
 * the first tool call that hits Avito returns a structured CONFIG_ERROR.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import { defineTool, type ToolContext } from '../src/core/tool-factory.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { domains } from '../src/meta/domain-registry.js';
import type { Config } from '../src/config.js';

/** Config with NO credentials — clientId/clientSecret empty, profileId undefined. */
function makeUnconfiguredConfig(): Config {
  return {
    clientId: '',
    clientSecret: '',
    profileId: undefined,
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
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
  };
}

async function makeRig(cfg: Config) {
  const server = new McpServer({ name: 'avito-mcp', version: '0.7.4' });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000);
  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore,
    idempotencyStore,
    server,
  };
  // Register a read tool that needs auth but NO path params, so a call without
  // credentials fails purely at the token step (MissingCredentialsError -> CONFIG_ERROR),
  // not at URL building.
  defineTool(server, ctx, {
    name: 'user_get_user_info_self',
    risk: 'read',
    description: 'profile',
    method: 'GET',
    path: '/core/v1/accounts/self',
    domain: 'core',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return { client, ctx };
}

describe('introspection without credentials', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup?.();
    cleanup = undefined;
  });

  it('tools/list works with no credentials configured', async () => {
    const cfg = makeUnconfiguredConfig();
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name === 'user_get_user_info_self')).toBe(true);
  });

  it('calling a tool without credentials returns structured CONFIG_ERROR (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cfg = makeUnconfiguredConfig();
    const { client } = await makeRig(cfg);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const res = await client.callTool({ name: 'user_get_user_info_self', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      error: { type: 'CONFIG_ERROR', retryable: false },
    });
    // Must NOT have attempted any network call (not even /token).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('full domain registry loads without credentials (no startup crash)', async () => {
    const cfg = makeUnconfiguredConfig();
    const server = new McpServer({ name: 'avito-mcp', version: '0.7.4' });
    const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
    const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000);
    const ctx: ToolContext = {
      client: new AvitoClient(cfg),
      config: cfg,
      pendingStore,
      idempotencyStore,
      server,
    };
    expect(() => {
      for (const register of domains) register(server, ctx);
    }).not.toThrow();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(b);
    cleanup = async () => {
      await client.close();
      await fs.rm(cfg.tokenFile, { force: true });
    };
    const { tools } = await client.listTools();
    // Full catalogue minus sensitive auth tools (hidden by default).
    expect(tools.length).toBeGreaterThan(100);
  });
});
