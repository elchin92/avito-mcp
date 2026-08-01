/**
 * M2 acceptance: prove the move onto `@modelcontextprotocol/*@2` did not move
 * the wire.
 *
 * Stage M2 swaps the SDK and NOTHING else — the server must keep speaking
 * revision `2025-11-25` and must look to a client exactly as 1.3.x did. The
 * point of splitting M2 from M3 (which turns on `2026-07-28`) is that if the
 * wire breaks later, it is unambiguous whether the new SDK or the new revision
 * broke it. That guarantee is only worth something if it is enforced, because
 * three of the drifts v2 introduced are invisible to `tsc`, to the codemod, and
 * to every other test in this suite:
 *
 *  1. `capabilities.{tools,prompts}.listChanged` — v1's McpServer overwrote the
 *     declared value with `true` as soon as a tool/prompt was registered; v2
 *     honours the declaration. The advertised capability set silently narrowed.
 *  2. The JSON Schema dialect of every `inputSchema` — v1 rendered draft-07, v2
 *     hard-codes draft-2020-12. The schema BODIES are byte-identical, but the
 *     `$schema` string feeds `dist/manifest.json`'s `schema_hash`, which is
 *     published to consumers as `meta_capabilities.schemaHash`.
 *  3. `execution: { taskSupport: 'forbidden' }` — v1 stamped it on every tool,
 *     v2 drops it, so the field vanished from all 148 descriptors.
 *
 * `src/core/wire-compat.ts` pins 2 and 3; `src/build-server.ts` pins 1. This
 * file is the backstop that fails if any pin is removed or bypassed — including
 * by a future domain that registers a tool through some path the pin misses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { buildMcpServer } from '../src/build-server.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';
import { makeConfig as makeBaseConfig } from './support/config-fixture.js';

/** The revision M2 must NOT leave. `2026-07-28` is M3's job, not this stage's. */
const LEGACY_PROTOCOL_VERSION = '2025-11-25';

/** The JSON Schema dialect SDK v1 emitted, and which `schema_hash` is computed over. */
const LEGACY_DIALECT = 'http://json-schema.org/draft-07/schema#';

/**
 * `schema_hash` as published by 1.3.3 (`dist/manifest.json`, and
 * `meta_capabilities.schemaHash`). It is a SHA-256 over
 * `{name, risk, environment, inputSchema}` for every tool, so it moves whenever
 * a tool's input contract genuinely changes — that is the point of it. Update
 * this constant DELIBERATELY, in the same commit as the schema change, and note
 * it in the changelog: consumers use it to detect drift.
 */
const PUBLISHED_SCHEMA_HASH = '9c52d4c3f39300d267fba9bdcfb9a7aef9cb9664d325484f2a3967327f5f505f';

/**
 * The shared fixture supplies every field this suite does not care about, and —
 * unlike the literal this used to be — puts `tokenFile` and the runtime state
 * directory in a private sandbox on the repository filesystem instead of
 * os.tmpdir(). Only the two fields that shape the published surface are set here.
 *
 * `confirmationMode` stays at the fixture default 'money_public': mode 'off'
 * would hide meta_confirm_action / meta_cancel_action / meta_list_pending_actions,
 * which the 148-tool baseline includes.
 */
function makeConfig(): Config {
  return makeBaseConfig({
    // The full surface, so the assertions below cover all 148 descriptors and
    // not just the 144 a default deployment exposes.
    exposeAuthTools: true,
    allowedUploadDirs: [tmpdir()],
  });
}

interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: { taskSupport?: string };
  _meta?: Record<string, unknown>;
}

let client: Client;
let tools: ToolDescriptor[];
let serverCapabilities: Record<string, unknown> | undefined;
let serverVersion: Record<string, unknown> | undefined;
let instructions: string | undefined;

beforeAll(async () => {
  const cfg = makeConfig();
  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
  };
  const server = buildMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'wire-conformance', version: '0.0.0' }, { capabilities: {} });
  await client.connect(b);
  serverCapabilities = client.getServerCapabilities() as Record<string, unknown> | undefined;
  serverVersion = client.getServerVersion() as Record<string, unknown> | undefined;
  instructions = client.getInstructions();
  tools = (await client.listTools()).tools as unknown as ToolDescriptor[];
});

afterAll(async () => {
  await client?.close();
});

describe('M2: the negotiated revision is unchanged', () => {
  it('advertises exactly the 1.3.x capability set', () => {
    // Verbatim from what 1.3.3 put on the wire. `completions` is added by the
    // SDK itself (a completable prompt argument is registered), which is why
    // this asserts the ADVERTISED set rather than the literal in build-server.
    expect(serverCapabilities).toEqual({
      logging: {},
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      tools: { listChanged: true },
      completions: {},
    });
  });

  it('keeps serverInfo identical, including title/description/websiteUrl', () => {
    expect(serverVersion).toMatchObject({
      name: 'avito-mcp',
      title: 'Avito MCP',
      websiteUrl: 'https://github.com/elchin92/avito-mcp',
    });
    expect(typeof (serverVersion as { description?: unknown }).description).toBe('string');
  });

  it('keeps the instructions block', () => {
    expect(instructions).toContain('Avito MCP');
    expect(instructions).toContain('meta_confirm_action');
    expect(instructions).toContain('avito://manifest');
  });
});

describe('M2: tool descriptors are shaped as SDK v1 shaped them', () => {
  it('exposes the full 148-tool surface', () => {
    expect(tools).toHaveLength(148);
  });

  it('renders every inputSchema in the draft-07 dialect', () => {
    const wrongDialect = tools
      .filter((t) => t.inputSchema?.$schema !== LEGACY_DIALECT)
      .map((t) => `${t.name}: ${String(t.inputSchema?.$schema)}`);
    expect(wrongDialect).toEqual([]);
  });

  it('renders every outputSchema in the draft-07 dialect', () => {
    const withOutput = tools.filter((t) => t.outputSchema);
    // meta_health / meta_auth_status / meta_capabilities are the only tools
    // with a declared outputSchema; a new one must be pinned too.
    expect(withOutput.length).toBeGreaterThanOrEqual(3);
    const wrongDialect = withOutput
      .filter((t) => t.outputSchema?.$schema !== LEGACY_DIALECT)
      .map((t) => `${t.name}: ${String(t.outputSchema?.$schema)}`);
    expect(wrongDialect).toEqual([]);
  });

  it("carries execution.taskSupport = 'forbidden' on every tool", () => {
    const missing = tools
      .filter((t) => t.execution?.taskSupport !== 'forbidden')
      .map((t) => `${t.name}: ${JSON.stringify(t.execution)}`);
    expect(missing).toEqual([]);
  });

  it('keeps every inputSchema an object schema with the same root keywords', () => {
    const bad = tools
      .filter((t) => t.inputSchema?.type !== 'object')
      .map((t) => `${t.name}: ${String(t.inputSchema?.type)}`);
    expect(bad).toEqual([]);
  });
});

describe('M2: the published schema_hash has not moved', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const MANIFEST = resolve(here, '..', 'dist', 'manifest.json');

  it('recomputes to the hash 1.3.3 published', () => {
    // Same projection and serialisation as scripts/generate-manifest.ts, but
    // computed from the LIVE server rather than the generated file — so a pin
    // that only works in the generator (or only at runtime) still fails here.
    const projected = tools
      .map((t) => ({
        name: t.name,
        risk: String((t._meta ?? {}).risk ?? 'unknown'),
        environment: String((t._meta ?? {}).environment ?? 'prod'),
        inputSchema: t.inputSchema,
      }))
      .sort((x, y) => (x.name < y.name ? -1 : 1));
    const hash = createHash('sha256').update(JSON.stringify(projected)).digest('hex');
    expect(hash).toBe(PUBLISHED_SCHEMA_HASH);
  });

  it('matches the hash written into dist/manifest.json', () => {
    if (!existsSync(MANIFEST)) {
      throw new Error('dist/manifest.json missing — run "npm run generate:manifest" first.');
    }
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { schema_hash: string };
    expect(manifest.schema_hash).toBe(PUBLISHED_SCHEMA_HASH);
  });
});

describe('M2: the server stays in the legacy protocol era', () => {
  it('answers initialize with 2025-11-25 even when a client offers 2026-07-28', async () => {
    // Driven over the raw transport rather than through Client, because the v2
    // Client only ever offers its own LATEST_PROTOCOL_VERSION. A server that had
    // drifted into the modern era would answer 2026-07-28 here, which is exactly
    // the M3 change M2 must not make by accident.
    const cfg = makeConfig();
    const ctx: ToolContext = {
      client: new AvitoClient(cfg),
      config: cfg,
      pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
    };
    const server = buildMcpServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);

    const reply = new Promise<Record<string, unknown>>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('initialize timed out')), 15_000);
      b.onmessage = (msg: unknown) => {
        clearTimeout(timer);
        res(msg as Record<string, unknown>);
      };
    });
    await b.start();
    await b.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'era-probe', version: '0.0.0' },
      },
    } as never);

    const msg = await reply;
    const result = msg.result as { protocolVersion?: string } | undefined;
    expect(result?.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
    await b.close();
    await server.close();
  });
});
