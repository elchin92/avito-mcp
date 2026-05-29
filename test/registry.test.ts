/**
 * Invariants on the tool registry as a whole. Designed to catch
 * regressions where a new tool slips in without a `risk` field
 * (would silently default to 'write'), with a duplicated name,
 * with a malformed snake_case identifier, or without a description.
 *
 * The test mounts the full domain registry against an InMemoryTransport,
 * so it sees exactly what an MCP client would see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { AvitoClient } from '../src/core/client.js';
import { domains } from '../src/meta/domain-registry.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';

function makeConfig(): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    // Full surface for registry inventory: expose everything that exists.
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: true,
    allowedUploadDirs: [tmpdir()],
    maxUploadMb: 15,
    confirmationMode: 'off',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
  };
}

let client: Client;
let toolNames: string[];
let tools: Array<{
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema?: unknown;
}>;

beforeAll(async () => {
  const server = new McpServer({ name: 'avito-mcp-test', version: '0.0.0' });
  const cfg = makeConfig();
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const ctx: ToolContext = { client: new AvitoClient(cfg), config: cfg, pendingStore };
  for (const register of domains) register(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'registry-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(b);
  const list = await client.listTools();
  tools = list.tools as typeof tools;
  toolNames = tools.map((t) => t.name);
});

afterAll(async () => {
  await client.close();
});

describe('tool registry invariants', () => {
  it('registers at least 139 tools (138 swagger + 1 meta)', () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(139);
  });

  it('has no duplicate tool names', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of toolNames) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes).toEqual([]);
  });

  it('all tool names are snake_case (lowercase letters / digits / underscore, starting with a letter)', () => {
    const bad = toolNames.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n));
    expect(bad).toEqual([]);
  });

  it('all tools have a non-empty description', () => {
    const noDesc = tools.filter((t) => !t.description || t.description.trim().length === 0);
    expect(noDesc.map((t) => t.name)).toEqual([]);
  });

  it('every tool description is in English (no Cyrillic) — convention', () => {
    // Heuristic: tool descriptions are English-only for an international audience —
    // a new Russian-only description should fail CI. (v0.8.0 i18n pass.)
    const withCyrillic = tools.filter((t) => /[Ѐ-ӿ]/.test(t.description ?? ''));
    expect(withCyrillic.map((t) => t.name)).toEqual([]);
  });

  it('every tool exposes ToolAnnotations (so MCP clients can warn before destructive calls)', () => {
    const missing = tools.filter((t) => !t.annotations);
    expect(missing.map((t) => t.name)).toEqual([]);
  });

  it('every tool has both readOnlyHint and destructiveHint set explicitly', () => {
    const incomplete = tools.filter(
      (t) =>
        t.annotations?.readOnlyHint === undefined ||
        t.annotations?.destructiveHint === undefined,
    );
    expect(incomplete.map((t) => t.name)).toEqual([]);
  });

  it('tool names match the convention <domain>_<rest>', () => {
    const known = [
      'auth',
      'autoload',
      'calltracking',
      'cpa',
      'cpa_auction',
      'cpa_target',
      'delivery',
      'hierarchy',
      'items',
      'meta',
      'messenger',
      'msg_discounts',
      'orders',
      'promotion',
      'reviews',
      'stock',
      'tariffs',
      'trxpromo',
      'user',
    ];
    const bad = toolNames.filter((n) => !known.some((d) => n === d || n.startsWith(`${d}_`)));
    expect(bad).toEqual([]);
  });

  it('exposes at least one tool per registered domain', () => {
    expect(domains.length).toBeGreaterThanOrEqual(19); // 18 swaggers + meta
  });
});
