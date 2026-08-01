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
 * The routing decision is the SDK's own `classifyInboundRequest`, so these tests
 * are also the guard that our hand-wired split has not drifted from what
 * `createMcpHandler` itself would decide — `test/modern-conformance.test.ts`
 * pins the classifier against the `isLegacyRequest` predicate as well.
 *
 * Everything is driven with raw `fetch` and raw JSON-RPC rather than through an
 * SDK client — see `test/support/modern-rig.ts`, which owns the fixture this
 * suite and the M3.4-M3.7 / M4.1-M4.2 suites share.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  LEGACY_REVISION,
  MODERN_REVISION,
  closeRigs,
  initializeMessage,
  legacyPost,
  modernPost,
  rawRequest,
  resultOf,
  startRig,
  type Answer,
  type Rig,
} from './support/modern-rig.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/version.js';

/** The full legacy opening, returning the initialize result and the tool count. */
async function legacyHandshake(rig: Rig): Promise<{ init: Answer; toolCount: number }> {
  const init = await legacyPost(rig, initializeMessage());
  const sid = init.sessionId;
  await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  const list = await legacyPost(
    rig,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    sid,
  );
  const tools = (resultOf(list)?.tools ?? []) as unknown[];
  return { init, toolCount: tools.length };
}

afterEach(closeRigs);

describe('era=legacy (default): the modern leg does not exist', () => {
  it('serves the 2025 handshake exactly as before', async () => {
    const rig = await startRig('legacy');
    const { init, toolCount } = await legacyHandshake(rig);
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(resultOf(init)!.protocolVersion).toBe(LEGACY_REVISION);
    expect(toolCount).toBeGreaterThan(100);
  });

  it('answers a 2026-era request with the unchanged session-less refusal', async () => {
    const rig = await startRig('legacy');
    const answer = await modernPost(rig, 'server/discover');
    // NOT a modern error: the modern path is not mounted, so the request never
    // reaches a 2026 handler. It falls through the legacy manager's "no session
    // id on a non-initialize POST" branch — precisely what M2 answered.
    //
    // The CODE moved from -32000 to -32602 (a required field is absent) when
    // the 2026-07-28 allocation policy closed -32000…-32019 to new
    // implementations; the STATUS, which is what a client branches on, did not.
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32602 },
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
    expect(resultOf(init)!.protocolVersion).toBe(LEGACY_REVISION);
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
    const result = resultOf(answer)!;
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual([MODERN_REVISION]);
    expect(result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect(result.instructions).toContain('Avito MCP');
  });

  it('serves tools/list and a read-only tools/call on the modern leg', async () => {
    const rig = await startRig('dual');
    const list = await modernPost(rig, 'tools/list');
    expect(list.status).toBe(200);
    const tools = resultOf(list)!.tools as { name: string }[];
    expect(tools.length).toBeGreaterThan(100);
    expect(tools.map((t) => t.name)).toContain('meta_health');

    const call = await modernPost(rig, 'tools/call', { name: 'meta_health', arguments: {} });
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
      ((resultOf(a)?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
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

    // 2025 session operations do not exist in the modern era.
    const get = await rawRequest(rig, { method: 'GET' });
    expect(get.status).toBe(405);
  });
});
