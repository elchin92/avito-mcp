/**
 * M3.4–M3.7 / M4.1 acceptance: block A, points 1–8 of the "100% migration"
 * criterion, asserted on a MODERN connection.
 *
 * Read this file together with the gap analysis it encodes, because most of the
 * value here is knowing which half of each requirement is the SDK's and which
 * half is ours:
 *
 *   SDK (`@modelcontextprotocol/server@2.0.0`), asserted here but not written
 *   here — duplicating any of it in `src/` would be a second implementation
 *   free to drift:
 *     • `server/discover` itself (`Server._ondiscover`, installed per request by
 *       `createMcpHandler` via `installModernOnlyHandlers`);
 *     • `resultType` on every result, and `ttlMs`/`cacheScope` on the six
 *       cacheable ones (the 2026 codec's `encodeResult`);
 *     • `_meta` envelope validation (`-32602`), unsupported revision (`-32022`),
 *       `Mcp-Method`/`Mcp-Name` presence and header↔body agreement (`-32020`),
 *       missing client capability (`-32021`), unknown method (`404` + `-32601`),
 *       and `405` for GET/DELETE.
 *
 *   OURS, because the SDK does NOT do it:
 *     • the `Allow` header on the modern `405` — `rejectionResponse` builds a
 *       bare `Response.json(..., { status })`, so the SDK's own 405 carries no
 *       `Allow` at all;
 *     • rejecting a modern request that omits `MCP-Protocol-Version` — the
 *       classifier reads the era from the body envelope and never requires the
 *       header, but the revision says "Every POST request to the MCP endpoint
 *       MUST include an `MCP-Protocol-Version` header";
 *     • routing a body-less GET/DELETE to the right era under `dual`, where the
 *       SDK's body-primary classifier can only answer `legacy / http-method`;
 *     • the cache-hint values themselves (M4.2, see `test/caching-hints.test.ts`).
 *
 * Everything is driven with raw `fetch` and raw JSON-RPC through the real HTTP
 * server — see `test/support/modern-rig.ts` for why.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  SERVER_INFO_META_KEY,
  classifyInboundRequest,
  createMcpHandler,
  inputRequired,
  isLegacyRequest,
  type McpServer,
} from '@modelcontextprotocol/server';

import {
  LEGACY_REVISION,
  META,
  MODERN_REVISION,
  closeRigs,
  errorOf,
  initializeMessage,
  legacyPost,
  makeConfig,
  modernPost,
  rawRequest,
  resultOf,
  startRig,
  type Answer,
  type Rig,
} from './support/modern-rig.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/version.js';
import {
  MODERN_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
  createServerFactory,
} from '../src/build-server.js';
import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { createSandboxSync, removeSandbox } from './support/sandbox.js';
import type { ToolContext } from '../src/core/tool-factory.js';

afterEach(closeRigs);

/** The whole modern surface, as method + params + the `Mcp-Name` the rig derives. */
const MODERN_CALLS: { method: string; params?: Record<string, unknown> }[] = [
  { method: 'server/discover' },
  { method: 'tools/list' },
  { method: 'prompts/list' },
  { method: 'resources/list' },
  { method: 'resources/templates/list' },
  { method: 'resources/read', params: { uri: 'avito://docs/safety' } },
  { method: 'prompts/get', params: { name: 'avito_safety_report', arguments: {} } },
  { method: 'tools/call', params: { name: 'meta_health', arguments: {} } },
  {
    method: 'completion/complete',
    params: {
      ref: { type: 'ref/resource', uri: 'avito://swaggers/{slug}' },
      argument: { name: 'slug', value: '' },
    },
  },
];

// ───────────────────────── 1. server/discover ──────────────────────────────

describe('A1 — server/discover', () => {
  it('answers as the very first request of a connection, before anything else', async () => {
    // "Before any other request" is the point: the modern era has no
    // handshake, so a client's first byte on the wire is this call. If the
    // endpoint needed any priming, every 2026 client would fail on contact.
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'server/discover');
    expect(answer.status).toBe(200);
    expect(resultOf(answer)).toBeDefined();
  });

  it('carries resultType, supportedVersions, capabilities, instructions, ttlMs, cacheScope', async () => {
    const rig = await startRig('dual');
    const result = resultOf(await modernPost(rig, 'server/discover'))!;

    expect(result.resultType).toBe('complete');
    expect(Array.isArray(result.supportedVersions)).toBe(true);
    expect((result.supportedVersions as string[]).length).toBeGreaterThan(0);
    for (const version of result.supportedVersions as string[]) {
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(version);
    }
    expect(result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect(typeof result.instructions).toBe('string');
    expect(Number.isSafeInteger(result.ttlMs)).toBe(true);
    expect(result.ttlMs as number).toBeGreaterThanOrEqual(0);
    expect(['public', 'private']).toContain(result.cacheScope);
  });

  it('identifies itself in _meta and NOT in a top-level serverInfo field', async () => {
    // Spec PR #3002 moved serverInfo off the result and into result `_meta`.
    // A top-level field here would be a 2025 habit surviving into 2026.
    const rig = await startRig('dual');
    const result = resultOf(await modernPost(rig, 'server/discover'))!;
    expect(result.serverInfo).toBeUndefined();
    const meta = result._meta as Record<string, unknown>;
    expect(meta[SERVER_INFO_META_KEY]).toMatchObject({ name: 'avito-mcp' });
    expect((meta[SERVER_INFO_META_KEY] as { version: string }).version).toBeTruthy();
  });

  it('is the ONLY carrier left for the safety instructions, and carries them intact', async () => {
    // The load-bearing assertion of this whole stage. On a 2025 connection the
    // safety brief rides in the `initialize` result. The modern era deleted
    // `initialize` (SEP-2575) — proven in the same test rather than assumed —
    // so if `instructions` did not reach `server/discover`, an agent driving
    // the LIVE Avito account would never be told that write/money/public
    // operations go through a human confirmation, nor where to read the rules.
    // There is no sandbox account to catch that mistake in.
    const rig = await startRig('dual');

    const legacyInit = await legacyPost(rig, initializeMessage());
    const legacyInstructions = (resultOf(legacyInit) as { instructions?: string }).instructions;
    expect(legacyInstructions).toBe(SERVER_INSTRUCTIONS);

    const modernInit = await modernPost(rig, 'initialize', {
      protocolVersion: MODERN_REVISION,
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    });
    expect(modernInit.status).toBe(404);
    expect(errorOf(modernInit)?.code).toBe(-32601);

    const discovered = resultOf(await modernPost(rig, 'server/discover'))!;
    // M3: the brief is era-SPLIT. The safety half must survive verbatim; the
    // half that tells the model how to watch for changes must name a method
    // that exists on the era being served — see MODERN_SERVER_INSTRUCTIONS.
    expect(discovered.instructions).toBe(MODERN_SERVER_INSTRUCTIONS);
    // Not just "a string": the parts an agent must not lose.
    expect(discovered.instructions).toContain('confirmation_id');
    expect(discovered.instructions).toContain('meta_confirm_action');
    expect(discovered.instructions).toContain('avito://docs/safety');
  });

  it('answers server/discover over stdio too, as the first line of the connection', async () => {
    // The second transport. `serveStdio` owns the era decision for a stdio
    // connection, so this also proves `AVITO_MCP_PROTOCOL_ERA` reaches it: the
    // default `legacy` posture would answer -32601 here.
    const sandbox = createSandboxSync('stdio-discover');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AVITO_ENV_FILE: '/dev/null',
        CLIENT_ID: 'cid',
        CLIENT_SECRET: 'sec',
        PROFILE_ID: '12345678',
        AVITO_TOKEN_FILE: `${sandbox}/token.json`,
        AVITO_MCP_RUNTIME_STATE_DIR: sandbox,
        AVITO_MCP_TRANSPORT: 'stdio',
        AVITO_MCP_PROTOCOL_ERA: 'modern',
        LOG_LEVEL: 'fatal',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const lines = createInterface({ input: child.stdout });
      const firstLine = once(lines, 'line') as Promise<[string]>;
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              [META.protocolVersion]: MODERN_REVISION,
              [META.clientCapabilities]: {},
            },
          },
        })}\n`,
      );
      const [line] = await firstLine;
      const frame = JSON.parse(line) as { result?: Record<string, unknown> };
      const result = frame.result!;
      expect(result.resultType).toBe('complete');
      expect(result.supportedVersions).toContain(MODERN_REVISION);
      expect(result.instructions).toBe(MODERN_SERVER_INSTRUCTIONS);
      expect(result.serverInfo).toBeUndefined();
      expect((result._meta as Record<string, unknown>)[SERVER_INFO_META_KEY]).toBeDefined();
      lines.close();
    } finally {
      child.kill('SIGKILL');
      await once(child, 'exit');
      await removeSandbox(sandbox);
    }
  }, 60_000);
});

// ───────────────────────── 2. resultType everywhere ─────────────────────────

describe('A2 — resultType on every result', () => {
  it('stamps resultType:"complete" on every modern result', async () => {
    // Asserted on the RAW frame, never through a typed client: v2 removed
    // `resultType` from the public result types while keeping it mandatory on
    // the wire, so a type-level check here would prove nothing.
    const rig = await startRig('dual');
    for (const call of MODERN_CALLS) {
      const answer = await modernPost(rig, call.method, call.params ?? {});
      const result = resultOf(answer);
      expect(
        result,
        `${call.method} returned no result: ${JSON.stringify(answer.body)}`,
      ).toBeDefined();
      expect(result!.resultType, call.method).toBe('complete');
    }
  });

  it('does not leak resultType onto the legacy wire', async () => {
    const rig = await startRig('dual');
    const init = await legacyPost(rig, initializeMessage());
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
    const list = await legacyPost(
      rig,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.sessionId,
    );
    expect(resultOf(init)!.resultType).toBeUndefined();
    expect(resultOf(list)!.resultType).toBeUndefined();
  });
});

// ─────────────────── 4. per-request `_meta` envelope ────────────────────────

describe('A4 — per-request _meta envelope', () => {
  it('rejects a missing protocolVersion key with -32602 + HTTP 400', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.protocolVersion]: undefined } },
    );
    expect(answer.status).toBe(400);
    expect(errorOf(answer)?.code).toBe(-32602);
  });

  it('rejects a missing clientCapabilities key with -32602 + HTTP 400', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.clientCapabilities]: undefined } },
    );
    expect(answer.status).toBe(400);
    expect(errorOf(answer)?.code).toBe(-32602);
    expect(JSON.stringify(errorOf(answer)?.data)).toContain(META.clientCapabilities);
  });

  it('does NOT reject a missing clientInfo — it was demoted to SHOULD', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.clientInfo]: undefined } },
    );
    expect(answer.status).toBe(200);
    expect(resultOf(answer)).toBeDefined();
  });

  it('ignores unknown _meta keys', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { 'com.example/nothing-here': { anything: true } } },
    );
    expect(answer.status).toBe(200);
  });

  it('reads capabilities per request, never from a previous one', async () => {
    // Stateless means stateless: two consecutive requests declaring different
    // capabilities must each be answered on their own declaration. A cached
    // per-connection view is exactly the 2025 habit this era removed.
    const rig = await startRig('dual');
    const rich = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.clientCapabilities]: { elicitation: {}, sampling: {} } } },
    );
    const bare = await modernPost(rig, 'tools/list');
    expect(rich.status).toBe(200);
    expect(bare.status).toBe(200);
    expect(resultOf(bare)!.tools).toEqual(resultOf(rich)!.tools);
  });
});

// ─────────────────────── 5. unknown protocol version ────────────────────────

describe('A5 — unknown protocol version', () => {
  it('answers -32022 with data.supported and data.requested + HTTP 400', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      {
        headers: { 'MCP-Protocol-Version': '1900-01-01' },
        meta: { [META.protocolVersion]: '1900-01-01' },
      },
    );
    expect(answer.status).toBe(400);
    const error = errorOf(answer)!;
    expect(error.code).toBe(-32022);
    const data = error.data as { supported: string[]; requested: string };
    expect(data.requested).toBe('1900-01-01');
    expect(data.supported.length).toBeGreaterThan(0);
    // Never advertise a revision we do not actually claim to speak.
    for (const version of data.supported) expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(version);
  });

  it('answers a 2025 handshake on a modern-only endpoint with -32022, not a 404', async () => {
    const rig = await startRig('modern');
    const answer = await legacyPost(rig, initializeMessage());
    expect(answer.status).toBe(400);
    const data = errorOf(answer)!.data as { supported: string[] };
    expect(errorOf(answer)!.code).toBe(-32022);
    expect(data.supported).toEqual([MODERN_REVISION]);
  });
});

// ──────────────────── 6. SEP-2243 standard headers ──────────────────────────

describe('A6 — standard headers (SEP-2243)', () => {
  /** Every -32020 cell answers 400 with the same code; assert both every time. */
  function expectHeaderMismatch(answer: Answer, label: string): void {
    expect(answer.status, label).toBe(400);
    expect(errorOf(answer)?.code, label).toBe(-32020);
  }

  it('rejects a request with no MCP-Protocol-Version header', async () => {
    // OUR rule, not the SDK's: the classifier takes the era from the body
    // envelope and stops caring about the header, so without this the MUST
    // "Every POST request ... MUST include an MCP-Protocol-Version header"
    // would be unenforced. Mutating `missingProtocolVersionHeader` away turns
    // this into a 200.
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { headers: { 'MCP-Protocol-Version': null } },
    );
    expectHeaderMismatch(answer, 'missing MCP-Protocol-Version');
    expect(errorOf(answer)?.message).toContain('MCP-Protocol-Version');
  });

  it('uses the same error code for our missing-version cell as the SDK does for its own', async () => {
    // Pins our hand-written -32020 to the SDK's: if the SDK ever renumbers the
    // header-mismatch code, this fails instead of leaving us emitting a stale
    // number next to a fresh one.
    const rig = await startRig('dual');
    const ours = await modernPost(
      rig,
      'tools/list',
      {},
      { headers: { 'MCP-Protocol-Version': null } },
    );
    const theirs = await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': null } });
    expect(errorOf(ours)!.code).toBe(errorOf(theirs)!.code);
    expect(ours.status).toBe(theirs.status);
    // ...and the same shape, so a client cannot tell which header it forgot by structure.
    expect(Object.keys(errorOf(ours)!.data as object)).toEqual(
      Object.keys(errorOf(theirs)!.data as object),
    );
  });

  it('rejects a missing Mcp-Method header', async () => {
    const rig = await startRig('dual');
    expectHeaderMismatch(
      await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': null } }),
      'missing Mcp-Method',
    );
  });

  it('rejects a missing Mcp-Name on tools/call, prompts/get and resources/read', async () => {
    const rig = await startRig('dual');
    expectHeaderMismatch(
      await modernPost(
        rig,
        'tools/call',
        { name: 'meta_health', arguments: {} },
        { headers: { 'Mcp-Name': null } },
      ),
      'tools/call',
    );
    expectHeaderMismatch(
      await modernPost(
        rig,
        'prompts/get',
        { name: 'avito_safety_report', arguments: {} },
        { headers: { 'Mcp-Name': null } },
      ),
      'prompts/get',
    );
    expectHeaderMismatch(
      await modernPost(
        rig,
        'resources/read',
        { uri: 'avito://docs/safety' },
        { headers: { 'Mcp-Name': null } },
      ),
      'resources/read',
    );
  });

  it('rejects a value whose CASE differs from the body', async () => {
    // The cheap wrong implementation lowercases both sides before comparing.
    const rig = await startRig('dual');
    expectHeaderMismatch(
      await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': 'TOOLS/LIST' } }),
      'Mcp-Method case',
    );
    expectHeaderMismatch(
      await modernPost(
        rig,
        'tools/call',
        { name: 'meta_health', arguments: {} },
        { name: 'META_HEALTH' },
      ),
      'Mcp-Name case',
    );
  });

  it('rejects a value that disagrees with the body', async () => {
    const rig = await startRig('dual');
    expectHeaderMismatch(
      await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': 'prompts/list' } }),
      'Mcp-Method mismatch',
    );
    expectHeaderMismatch(
      await modernPost(
        rig,
        'tools/call',
        { name: 'meta_health', arguments: {} },
        { name: 'meta_capabilities' },
      ),
      'Mcp-Name mismatch',
    );
    expectHeaderMismatch(
      await modernPost(
        rig,
        'tools/list',
        {},
        { headers: { 'MCP-Protocol-Version': LEGACY_REVISION } },
      ),
      'version header vs envelope',
    );
  });

  it('treats header NAMES case-insensitively', async () => {
    // Field names are case-insensitive per RFC 9110; only the VALUES are not.
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { headers: { 'Mcp-Method': null, 'mCp-MeThOd': 'tools/list' } },
    );
    expect(answer.status).toBe(200);
  });

  it('strips RFC 9110 optional whitespace before comparing', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/call',
      { name: 'meta_health', arguments: {} },
      { headers: { 'Mcp-Method': ' tools/call ' }, name: '  meta_health  ' },
    );
    expect(answer.status).toBe(200);
  });

  it('decodes the =?base64?…?= sentinel form before comparing', async () => {
    const rig = await startRig('dual');
    const encoded = `=?base64?${Buffer.from('meta_health', 'utf8').toString('base64')}?=`;
    const ok = await modernPost(
      rig,
      'tools/call',
      { name: 'meta_health', arguments: {} },
      { name: encoded },
    );
    expect(ok.status).toBe(200);

    // Uppercase marker: the sentinel markers are strictly lower-case, so this
    // is a literal value that cannot equal the body's `meta_health`.
    expectHeaderMismatch(
      await modernPost(
        rig,
        'tools/call',
        { name: 'meta_health', arguments: {} },
        { name: `=?BASE64?${Buffer.from('meta_health', 'utf8').toString('base64')}?=` },
      ),
      'uppercase sentinel marker',
    );

    // Invalid characters inside the sentinel: not decodable, so not comparable.
    expectHeaderMismatch(
      await modernPost(
        rig,
        'tools/call',
        { name: 'meta_health', arguments: {} },
        { name: '=?base64?!!!not-base64!!!?=' },
      ),
      'invalid sentinel payload',
    );
  });

  it('does not enforce the headers on a modern notification POST', async () => {
    // Deliberate boundary, not an oversight: the revision states that "header
    // requirements for notification POSTs are not defined by this revision",
    // and the SDK's `validateStandardRequestHeaders` returns early for
    // notifications. Our own version-header rule matches that, so this test is
    // what stops someone "fixing" the asymmetry.
    const rig = await startRig('dual');
    const answer = await rawRequest(rig, {
      body: {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: {
          requestId: 1,
          _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
        },
      },
    });
    expect(answer.status).toBe(202);
  });
});

// ─────────────────── 7. required-but-undeclared capability ──────────────────

describe('A7 — required client capability (-32021)', () => {
  function makeCtx(): ToolContext {
    const config = makeConfig('modern');
    return {
      client: new AvitoClient(config),
      config,
      pendingStore: new PendingActionStore(config.confirmationTtlSec * 1000),
      idempotencyStore: new IdempotencyStore(config.idempotencyTtlSec * 1000),
    };
  }

  it('serves every production request method without requiring a client capability', async () => {
    // The state of the world, asserted so it stays a decision rather than an
    // accident. The SDK's static table (`REQUIRED_CLIENT_CAPABILITIES_BY_METHOD`)
    // is empty, and this server adopts no elicitation/sampling: the migration
    // ADR keeps the `confirmation_id` + `meta_confirm_action` handshake instead
    // of MRTR elicitation. So a client declaring NOTHING must be served.
    const rig = await startRig('dual');
    for (const call of MODERN_CALLS) {
      const answer = await modernPost(rig, call.method, call.params ?? {}, {
        meta: { [META.clientCapabilities]: {} },
      });
      expect(errorOf(answer)?.code, call.method).not.toBe(-32021);
      expect(answer.status, call.method).toBe(200);
    }
  });

  it('answers -32021 + HTTP 400 with data.requiredCapabilities when a handler needs one', async () => {
    // The plumbing test. Since no production handler requires a capability
    // today, the requirement is exercised by adding ONE probe tool to a server
    // built by OUR factory and mounted with OUR entry options — the same
    // `createServerFactory` and the same `createMcpHandler(..., {legacy:'reject'})`
    // that `src/http/mcp-http.ts` uses. What is under test is that a `-32021`
    // raised AFTER dispatch still reaches the client as HTTP 400 with the
    // capability list attached, which is the part that is easy to lose (the
    // SDK special-cases this one in-band code to 400).
    const ctx = makeCtx();
    const base = createServerFactory(ctx, { background: false });
    const handler = createMcpHandler(
      async (options) => {
        const server = (await base(options)) as McpServer;
        server.registerTool(
          'probe_needs_elicitation',
          { description: 'test-only probe', inputSchema: {} },
          () =>
            inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: 'confirm?',
                  requestedSchema: {
                    type: 'object',
                    properties: { confirm: { type: 'boolean' } },
                    required: ['confirm'],
                  },
                }),
              },
            }),
        );
        return server;
      },
      { legacy: 'reject' },
    );
    try {
      const response = await handler.fetch(
        new Request('http://rig.invalid/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'MCP-Protocol-Version': MODERN_REVISION,
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'probe_needs_elicitation',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'probe_needs_elicitation',
              arguments: {},
              // The client declares NOTHING — elicitation is required and absent.
              _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
            },
          }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: number; data: unknown } };
      expect(body.error.code).toBe(-32021);
      expect(body.error.data).toMatchObject({ requiredCapabilities: { elicitation: {} } });
    } finally {
      await handler.close();
    }
  });
});

// ──────────── 8. methods, statuses and deliberately ignored headers ─────────

describe('A8 — methods, statuses, ignored headers', () => {
  it('answers an unknown RPC method with HTTP 404 + -32601', async () => {
    const rig = await startRig('dual');
    const answer = await rawRequest(rig, {
      headers: { 'MCP-Protocol-Version': MODERN_REVISION, 'Mcp-Method': 'nope/nope' },
      body: {
        jsonrpc: '2.0',
        id: 7,
        method: 'nope/nope',
        params: {
          _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
        },
      },
    });
    expect(answer.status).toBe(404);
    expect(errorOf(answer)?.code).toBe(-32601);
  });

  it('treats the methods this revision deleted as unknown', async () => {
    const rig = await startRig('dual');
    for (const method of ['initialize', 'resources/subscribe', 'logging/setLevel']) {
      const answer = await modernPost(rig, method, {});
      expect(answer.status, method).toBe(404);
      expect(errorOf(answer)?.code, method).toBe(-32601);
    }
  });

  it('answers GET and DELETE with 405 + Allow on a modern-only endpoint', async () => {
    const rig = await startRig('modern');
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const answer = await rawRequest(rig, { method });
      expect(answer.status, method).toBe(405);
      // The SDK's own 405 carries no Allow at all — this header is ours.
      expect(answer.allow, method).toBe('POST');
      expect(errorOf(answer)?.message, method).toContain('Method not allowed');
    }
  });

  it('under dual, routes GET/DELETE by era: modern gets 405, legacy keeps its session ops', async () => {
    const rig = await startRig('dual');

    // A 2026 client naming its revision: 405 + Allow, not the legacy manager's
    // "Mcp-Session-Id header is required".
    for (const method of ['GET', 'DELETE']) {
      const modern = await rawRequest(rig, {
        method,
        headers: { 'MCP-Protocol-Version': MODERN_REVISION },
      });
      expect(modern.status, method).toBe(405);
      expect(modern.allow, method).toBe('POST');
    }

    // A 2025 client with a live session still gets the legacy answer: the
    // DELETE terminates its session, exactly as it did before this stage.
    const init = await legacyPost(rig, initializeMessage());
    expect(init.sessionId).toBeTruthy();
    const del = await rawRequest(rig, {
      method: 'DELETE',
      headers: { 'mcp-session-id': init.sessionId! },
    });
    expect(del.status).not.toBe(405);
    expect(del.status).toBeLessThan(300);

    // And a stale/unknown session id still gets the 404 that tells a 2025
    // client to re-initialize — turning that into a 405 would wedge it.
    const stale = await rawRequest(rig, {
      method: 'GET',
      headers: { 'mcp-session-id': 'does-not-exist' },
    });
    expect(stale.status).toBe(404);
  });

  it('ignores an incoming Mcp-Session-Id instead of rejecting it, and mints none', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { headers: { 'Mcp-Session-Id': 'a-2025-client-habit' } },
    );
    expect(answer.status).toBe(200);
    expect(answer.sessionId).toBeNull();
    expect(resultOf(answer)).toBeDefined();
  });

  it('ignores Last-Event-ID instead of rejecting it', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'tools/list', {}, { headers: { 'Last-Event-ID': '42' } });
    expect(answer.status).toBe(200);
    expect(resultOf(answer)).toBeDefined();
  });
});

// ─────────────────── routing: our split vs the SDK's own ────────────────────

describe('era routing agrees with the SDK', () => {
  /** The matrix the dispatcher has to get right, described the way it sees it. */
  const CASES: {
    label: string;
    httpMethod: string;
    headers: Record<string, string>;
    body?: unknown;
  }[] = [
    { label: 'legacy initialize', httpMethod: 'POST', headers: {}, body: initializeMessage() },
    {
      label: 'legacy tools/list',
      httpMethod: 'POST',
      headers: { 'MCP-Protocol-Version': LEGACY_REVISION },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    },
    {
      label: 'modern tools/list',
      httpMethod: 'POST',
      headers: { 'MCP-Protocol-Version': MODERN_REVISION, 'Mcp-Method': 'tools/list' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
        },
      },
    },
    {
      label: 'modern claim with a broken envelope',
      httpMethod: 'POST',
      headers: { 'MCP-Protocol-Version': MODERN_REVISION, 'Mcp-Method': 'tools/list' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { [META.protocolVersion]: MODERN_REVISION } },
      },
    },
    {
      label: 'modern header without an envelope',
      httpMethod: 'POST',
      headers: { 'MCP-Protocol-Version': MODERN_REVISION, 'Mcp-Method': 'tools/list' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    },
    {
      label: 'posted JSON-RPC response',
      httpMethod: 'POST',
      headers: {},
      body: { jsonrpc: '2.0', id: 1, result: {} },
    },
    { label: 'GET', httpMethod: 'GET', headers: {} },
    { label: 'DELETE', httpMethod: 'DELETE', headers: {} },
  ];

  it('classifyInboundRequest and isLegacyRequest never disagree', async () => {
    // `src/http/mcp-http.ts` used to route on `isLegacyRequest` and now routes
    // on `classifyInboundRequest`. The SDK documents them as the same code
    // ("this is the entry's own classification step exported as a predicate"),
    // and this pins that: if a future SDK release ever splits them, the
    // dispatcher's routing would silently stop matching what the entry does.
    for (const testCase of CASES) {
      const outcome = classifyInboundRequest({
        httpMethod: testCase.httpMethod,
        ...(testCase.headers['MCP-Protocol-Version'] !== undefined
          ? { protocolVersionHeader: testCase.headers['MCP-Protocol-Version'] }
          : {}),
        ...(testCase.headers['Mcp-Method'] !== undefined
          ? { mcpMethodHeader: testCase.headers['Mcp-Method'] }
          : {}),
        ...(testCase.body !== undefined ? { body: testCase.body } : {}),
      });
      const predicate = await isLegacyRequest(
        new Request('http://rig.invalid/mcp', {
          method: testCase.httpMethod,
          headers: { 'content-type': 'application/json', ...testCase.headers },
          ...(testCase.body !== undefined && testCase.httpMethod === 'POST'
            ? { body: JSON.stringify(testCase.body) }
            : {}),
        }),
        testCase.body,
      );
      expect(outcome.kind === 'legacy', testCase.label).toBe(predicate);
    }
  });
});

// ─────────────── B — the legacy wire is untouched by all of this ────────────

describe('B — legacy compatibility after the modern work', () => {
  async function legacyOpening(rig: Rig): Promise<{ init: Answer; toolNames: string[] }> {
    const init = await legacyPost(rig, initializeMessage());
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
    const list = await legacyPost(
      rig,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.sessionId,
    );
    const tools = (resultOf(list)?.tools ?? []) as { name: string }[];
    return { init, toolNames: tools.map((t) => t.name).sort() };
  }

  it('serves a byte-identical 2025 handshake at era=legacy and era=dual', async () => {
    // The same comparison the M3.3 suite makes, re-run after the cache hints
    // and the header gate landed: `cacheHints` attaches its value on a
    // symbol-keyed property that JSON never serializes, so this must still hold
    // exactly. If it does not, a 2025 client is seeing 2026 fields.
    const legacyRig = await startRig('legacy');
    const dualRig = await startRig('dual');
    const a = await legacyPost(legacyRig, initializeMessage());
    const b = await legacyPost(dualRig, initializeMessage());
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('carries no ttlMs, cacheScope or resultType on any 2025 result', async () => {
    const rig = await startRig('dual');
    const init = await legacyPost(rig, initializeMessage());
    const sid = init.sessionId;
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    for (const [id, method, params] of [
      [2, 'tools/list', {}],
      [3, 'prompts/list', {}],
      [4, 'resources/list', {}],
      [5, 'resources/templates/list', {}],
      [6, 'resources/read', { uri: 'avito://docs/safety' }],
    ] as [number, string, Record<string, unknown>][]) {
      const answer = await legacyPost(rig, { jsonrpc: '2.0', id, method, params }, sid);
      const result = resultOf(answer)!;
      expect(result.ttlMs, method).toBeUndefined();
      expect(result.cacheScope, method).toBeUndefined();
      expect(result.resultType, method).toBeUndefined();
      expect(result._meta, method).toBeUndefined();
    }
  });

  it('exposes the same tool set on both eras', async () => {
    const rig = await startRig('dual');
    const { toolNames } = await legacyOpening(rig);
    const modern = (
      (resultOf(await modernPost(rig, 'tools/list'))?.tools ?? []) as { name: string }[]
    )
      .map((t) => t.name)
      .sort();
    expect(modern).toEqual(toolNames);
    expect(modern.length).toBeGreaterThan(100);
  });
});
