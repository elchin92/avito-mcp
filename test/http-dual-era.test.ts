/**
 * M3.3 acceptance: the era switch on `/mcp`.
 *
 * The whole point of M3 is that the 2026-07-28 code ships SWITCHED OFF, so the
 * assertions come in two halves:
 *
 *   1. With `AVITO_MCP_PROTOCOL_ERA` unset or `legacy`, `/mcp` behaves exactly
 *      as it did in M2 — the sessionful Streamable HTTP manager and nothing
 *      else. A request carrying the 2026 per-request envelope gets the SAME
 *      answer an unrecognised session-less request always got (400 / -32000),
 *      because the modern leg is not mounted at all. If this test ever starts
 *      seeing a `server/discover` result here, the flag has become advisory.
 *   2. With `dual`, legacy traffic keeps that behaviour byte-for-byte AND the
 *      modern leg answers; with `modern`, only the modern leg exists and 2025
 *      traffic is refused with `-32022` naming the revisions we do serve.
 *
 * The routing predicate is the SDK's own `isLegacyRequest`, so these tests are
 * also the guard that our hand-wired split has not drifted from what
 * `createMcpHandler` itself would decide.
 *
 * Everything is driven with raw `fetch` and raw JSON-RPC rather than through an
 * SDK client: what matters is the bytes a real client sees, and an SDK client
 * would happily paper over a status code or a missing header.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/app.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config, HttpConfig, ProtocolEraMode } from '../src/config.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/version.js';

/** Per-request envelope keys of revision 2026-07-28 (SEP-2575). */
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';

const MODERN_REVISION = SUPPORTED_PROTOCOL_VERSIONS[0];
const LEGACY_REVISION = SUPPORTED_PROTOCOL_VERSIONS[1];

function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
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

function makeConfig(protocolEra?: ProtocolEraMode): Config {
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
    // Deliberately assigned rather than spread from an overrides bag: `undefined`
    // here is the "operator never set the variable" case, which must behave as
    // `legacy`.
    protocolEra,
    http: makeHttpConfig(),
    webhook: { enabled: false, publicUrl: 'https://mcp.example.com', path: '/x', bufferSize: 10 },
  } as Config;
}

interface Rig {
  handle: HttpServerHandle;
  base: string;
  host: string;
}

const rigs: Rig[] = [];

async function startRig(protocolEra?: ProtocolEraMode): Promise<Rig> {
  const cfg = makeConfig(protocolEra);
  // The rebinding allowlists are derived before listen(), so the port has to be
  // known up front for the derived Host entry to match the request we send.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  cfg.http.port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));

  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
    idempotencyStore: new IdempotencyStore(cfg.idempotencyTtlSec * 1000),
  };
  const handle = await startHttpServer(ctx, cfg);
  const rig: Rig = {
    handle,
    base: `http://127.0.0.1:${handle.port}`,
    host: `127.0.0.1:${handle.port}`,
  };
  rigs.push(rig);
  return rig;
}

interface Answer {
  status: number;
  sessionId: string | null;
  body: Record<string, never> | Record<string, unknown> | null;
}

/** Reads either a plain JSON body or the last SSE `data:` frame. */
async function readAnswer(res: Response): Promise<Answer['body']> {
  const text = await res.text();
  if (!text) return null;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    return frames.length
      ? (JSON.parse(frames[frames.length - 1]!) as Record<string, unknown>)
      : null;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** A 2025-era POST: no envelope, no SEP-2243 headers. */
async function legacyPost(rig: Rig, message: unknown, sessionId?: string | null): Promise<Answer> {
  const res = await fetch(`${rig.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: rig.host,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    body: await readAnswer(res),
  };
}

/** A 2026-07-28 POST: per-request envelope in `_meta` plus the SEP-2243 headers. */
async function modernPost(
  rig: Rig,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
): Promise<Answer> {
  const res = await fetch(`${rig.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: rig.host,
      'MCP-Protocol-Version': MODERN_REVISION,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META]: MODERN_REVISION,
          [CLIENT_CAPABILITIES_META]: {},
          [CLIENT_INFO_META]: { name: 'dual-era-test', version: '1.0.0' },
        },
      },
    }),
  });
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    body: await readAnswer(res),
  };
}

function initializeMessage(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LEGACY_REVISION,
      capabilities: {},
      clientInfo: { name: 'dual-era-test', version: '1.0.0' },
    },
  };
}

/** The full legacy opening, returning the initialize result and the session id. */
async function legacyHandshake(rig: Rig): Promise<{ init: Answer; toolCount: number }> {
  const init = await legacyPost(rig, initializeMessage());
  const sid = init.sessionId;
  await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  const list = await legacyPost(
    rig,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    sid,
  );
  const tools = (list.body as { result?: { tools?: unknown[] } })?.result?.tools ?? [];
  return { init, toolCount: tools.length };
}

afterEach(async () => {
  await Promise.allSettled(rigs.splice(0).map((rig) => rig.handle.close()));
});

describe('era=legacy (default): the modern leg does not exist', () => {
  it('serves the 2025 handshake exactly as before', async () => {
    const rig = await startRig('legacy');
    const { init, toolCount } = await legacyHandshake(rig);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    const result = (init.body as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).toBe(LEGACY_REVISION);
    expect(toolCount).toBeGreaterThan(100);
  });

  it('answers a 2026-era request with the unchanged session-less refusal', async () => {
    const rig = await startRig('legacy');
    const answer = await modernPost(rig, 'server/discover');
    // NOT a modern error: the modern path is not mounted, so the request never
    // reaches a 2026 handler. It falls through the legacy manager's "no session
    // id on a non-initialize POST" branch — precisely what M2 answered.
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: null,
    });
    expect(JSON.stringify(answer.body)).not.toContain('supportedVersions');
  });

  it('an absent AVITO_MCP_PROTOCOL_ERA behaves identically to an explicit legacy', async () => {
    const unset = await startRig(undefined);
    const explicit = await startRig('legacy');
    const a = await modernPost(unset, 'server/discover');
    const b = await modernPost(explicit, 'server/discover');
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});

describe('era=dual: both legs, routed per request', () => {
  it('keeps the 2025 handshake working', async () => {
    const rig = await startRig('dual');
    const { init, toolCount } = await legacyHandshake(rig);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect((init.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      LEGACY_REVISION,
    );
    expect(toolCount).toBeGreaterThan(100);
  });

  it('produces a byte-identical 2025 handshake to era=legacy', async () => {
    const legacyRig = await startRig('legacy');
    const dualRig = await startRig('dual');
    const a = await legacyPost(legacyRig, initializeMessage());
    const b = await legacyPost(dualRig, initializeMessage());
    expect(a.status).toBe(b.status);
    // Session ids are random per session — everything else must match.
    expect(a.body).toEqual(b.body);
  });

  it('answers server/discover on the modern leg', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'server/discover');
    expect(answer.status).toBe(200);
    const result = (answer.body as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual([MODERN_REVISION]);
    expect(result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect(result.instructions).toContain('Avito MCP');
  });

  it('serves tools/list and a read-only tools/call on the modern leg', async () => {
    const rig = await startRig('dual');
    const list = await modernPost(rig, 'tools/list');
    expect(list.status).toBe(200);
    const tools = (list.body as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.length).toBeGreaterThan(100);
    expect(tools.map((t) => t.name)).toContain('meta_health');

    const call = await modernPost(
      rig,
      'tools/call',
      { name: 'meta_health', arguments: {} },
      'meta_health',
    );
    expect(call.status).toBe(200);
    expect((call.body as { result?: unknown }).result).toBeDefined();
  });

  it('mints no session id on the modern leg (SEP-2567 removed protocol sessions)', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'tools/list');
    expect(answer.sessionId).toBeNull();
  });

  it('exposes the same tool set on both legs', async () => {
    const rig = await startRig('dual');
    const init = await legacyPost(rig, initializeMessage());
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
    const legacyList = await legacyPost(
      rig,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.sessionId,
    );
    const modernList = await modernPost(rig, 'tools/list');
    const names = (a: Answer): string[] =>
      ((a.body as { result: { tools: { name: string }[] } }).result.tools ?? [])
        .map((t) => t.name)
        .sort();
    expect(names(modernList)).toEqual(names(legacyList));
  });
});

describe('era=modern: only the 2026 leg', () => {
  it('refuses the 2025 handshake with -32022 naming the revisions it serves', async () => {
    const rig = await startRig('modern');
    const answer = await legacyPost(rig, initializeMessage());
    expect(answer.status).toBe(400);
    const error = (answer.body as { error: { code: number; data: { supported: string[] } } }).error;
    expect(error.code).toBe(-32022);
    expect(error.data.supported).toEqual([MODERN_REVISION]);
    // Every revision the endpoint names must be one we actually claim to speak.
    for (const version of error.data.supported) {
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(version);
    }
  });

  it('serves the modern leg and answers GET /mcp with 405', async () => {
    const rig = await startRig('modern');
    const discover = await modernPost(rig, 'server/discover');
    expect(discover.status).toBe(200);

    const get = await fetch(`${rig.base}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', host: rig.host },
    });
    // 2025 session operations do not exist in the modern era.
    expect(get.status).toBe(405);
    await get.text();
  });
});
