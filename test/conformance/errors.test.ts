/**
 * M6.3 — the negative matrix: error codes, mirrored headers, protocol versions,
 * unknown methods and HTTP methods on `/mcp`.
 *
 * WHAT THIS FILE IS FOR. `test/modern-conformance.test.ts` proves the happy
 * cells of each requirement in §1.2.A; this one proves the cells a client only
 * meets when something is wrong. They are separated on purpose: the positive
 * suite answers "does the server implement the revision", this one answers
 * "does it FAIL the way the revision prescribes" — which is the half a
 * middlebox, a retry loop and a version-negotiating client actually branch on.
 *
 * Nothing here duplicates the positive suite. Every cell below is one the rest
 * of the repository does not exercise: the HTTP verbs beyond GET/DELETE, header
 * values that a conforming client cannot even transmit (raw socket), version
 * strings that are well-formed but unknown and version strings that are not
 * well-formed at all, an envelope of the wrong TYPE rather than a missing one,
 * and JSON-RPC batching, which this revision removed.
 *
 * Sources:
 *   `docs/mcp-2026-07-28/spec-transports.md` — J2 (405 on GET/DELETE, ignore
 *   `Mcp-Session-Id` / `Last-Event-ID`), D3/D6 (Accept, 202 for notifications).
 *   `docs/mcp-2026-07-28/transports.md`      — mirrored-header validation.
 *   `docs/mcp-2026-07-28/basic.md`           — the error-code allocation policy
 *   and `-32020` / `-32021` / `-32022`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';

import {
  LEGACY_REVISION,
  META,
  MODERN_REVISION,
  closeRigs,
  errorOf,
  modernPost,
  rawRequest,
  resultOf,
  startRig,
  type Rig,
} from '../support/modern-rig.js';
import { APP_ERROR_CODES, isLegacySubRangeCode } from '../../src/core/rpc-codes.js';

afterEach(closeRigs);

// ───────────────────────── HTTP methods on /mcp ─────────────────────────────

describe('HTTP methods on /mcp', () => {
  /**
   * The revision names GET and DELETE because those are the two the previous
   * revision USED. The rule it states is broader — this endpoint accepts POST
   * and nothing else — and a client that probes with `OPTIONS` or a proxy that
   * pre-flights with `HEAD` must not be answered as though its verb were
   * meaningful. `Allow` is what tells it which verb to use, so a 405 without it
   * is only half an answer.
   */
  it.each(['PUT', 'PATCH', 'OPTIONS', 'HEAD', 'GET', 'DELETE'])(
    'answers %s with 405 and an Allow header on a modern-only endpoint',
    async (method) => {
      const rig = await startRig('modern');
      const res = await fetch(`${rig.base}/mcp`, {
        method,
        headers: {
          host: rig.host,
          accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MODERN_REVISION,
        },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('POST');
      // HEAD carries no body by definition; every other verb must explain itself.
      if (method !== 'HEAD') {
        const body = JSON.parse(await res.text()) as { error?: { code: number } };
        expect(body.error?.code, method).toBe(APP_ERROR_CODES.methodNotAllowed);
        expect(isLegacySubRangeCode(body.error!.code), method).toBe(false);
      }
    },
  );

  it('keeps POST the only verb that reaches a handler', async () => {
    const rig = await startRig('modern');
    const ok = await modernPost(rig, 'tools/list');
    expect(ok.status).toBe(200);
    expect(resultOf(ok)!.tools).toBeInstanceOf(Array);
  });
});

// ────────────────────── mirrored headers: the illegal cells ─────────────────

describe('mirrored headers that a conforming client cannot even send', () => {
  /**
   * `fetch` refuses to transmit a header value containing a control character,
   * so the "invalid characters" cell of the SEP-2243 matrix is unreachable
   * through any normal client and can only be produced by writing bytes onto
   * the socket. It is worth producing: the interesting question is not whether
   * we answer `-32020` (we never see the request) but whether such a value can
   * be smuggled past the validator into the mirror — header injection through a
   * mirrored value is exactly the attack the SEP's security section is about.
   */
  function rawPost(rig: Rig, extraHeaderLine: string): Promise<string> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
      },
    });
    const request =
      'POST /mcp HTTP/1.1\r\n' +
      `Host: ${rig.host}\r\n` +
      'Content-Type: application/json\r\n' +
      'Accept: application/json, text/event-stream\r\n' +
      `MCP-Protocol-Version: ${MODERN_REVISION}\r\n` +
      `${extraHeaderLine}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body;
    return new Promise((resolve) => {
      const socket = connect(rig.handle.port, '127.0.0.1', () => socket.write(request));
      let out = '';
      socket.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      socket.on('close', () => resolve(out));
      socket.on('error', (err: Error) => resolve(`ERROR ${err.message}`));
      setTimeout(() => {
        socket.destroy();
        resolve(out || 'TIMEOUT');
      }, 5_000);
    });
  }

  it('refuses a control character in a mirrored value at the transport, serving nothing', async () => {
    const rig = await startRig('dual');
    const answer = await rawPost(rig, 'Mcp-Method: tools/\u0001list');
    expect(answer).toContain('400 Bad Request');
    // Not merely a 400: the request must not have been SERVED. If the parser
    // ever grew lenient, the tool catalogue would appear in this response.
    expect(answer).not.toContain('"tools"');
  });

  it('refuses a bare LF used to smuggle a second header', async () => {
    const rig = await startRig('dual');
    const answer = await rawPost(rig, 'Mcp-Method: tools/list\nX-Injected: 1');
    expect(answer).toContain('400 Bad Request');
    expect(answer).not.toContain('"tools"');
  });

  it('serves the same frame when the value is clean (the control group)', async () => {
    const rig = await startRig('dual');
    const answer = await rawPost(rig, 'Mcp-Method: tools/list');
    expect(answer).toContain('200 OK');
  });

  it('answers -32020 for an empty mirrored value rather than treating it as absent', async () => {
    // An empty value is PRESENT and disagrees with the body; collapsing it to
    // "header missing" would hand a proxy a way to blank the mirror.
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': '' } });
    expect(answer.status).toBe(400);
    expect(errorOf(answer)!.code).toBe(-32020);
  });

  it('answers -32020 for a non-ASCII value that resembles the body value', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/call',
      { name: 'meta_health', arguments: {} },
      { name: 'méta_health' },
    );
    expect(answer.status).toBe(400);
    expect(errorOf(answer)!.code).toBe(-32020);
  });
});

// ───────────────────────── protocol versions ────────────────────────────────

describe('unknown and malformed protocol versions', () => {
  const cases: Array<[label: string, version: string]> = [
    ['a revision from before MCP existed', '1900-01-01'],
    ['a revision from the future', '2027-01-01'],
    ['a revision one day off the real one', '2026-07-29'],
    ['a string that is not a date at all', 'not-a-version'],
    ['the string "latest"', 'latest'],
  ];

  it.each(cases)('answers -32022 with data.supported and data.requested for %s', async (_l, v) => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { headers: { 'MCP-Protocol-Version': v }, meta: { [META.protocolVersion]: v } },
    );
    expect(answer.status).toBe(400);
    const error = errorOf(answer)!;
    expect(error.code).toBe(-32022);
    expect(error.data).toMatchObject({ supported: [MODERN_REVISION], requested: v });
  });

  it('advertises exactly the revisions the modern leg serves, never the legacy one', async () => {
    // `data.supported` is the only diagnostic a client of an unknown revision
    // gets. Listing 2025-11-25 there would send it into a handshake this leg
    // cannot answer.
    const rig = await startRig('modern');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      {
        headers: { 'MCP-Protocol-Version': '1900-01-01' },
        meta: { [META.protocolVersion]: '1900-01-01' },
      },
    );
    const supported = (errorOf(answer)!.data as { supported: string[] }).supported;
    expect(supported).toEqual([MODERN_REVISION]);
    expect(supported).not.toContain(LEGACY_REVISION);
  });

  it('answers -32602, not -32022, when the envelope carries the wrong TYPE', async () => {
    // A version of the wrong type is a malformed envelope, not an unsupported
    // revision: answering -32022 would tell the client to renegotiate, and it
    // would renegotiate to exactly the same broken frame.
    const rig = await startRig('dual');
    const numeric = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.protocolVersion]: 2026 } },
    );
    expect(numeric.status).toBe(400);
    expect(errorOf(numeric)!.code).toBe(-32602);

    const badCaps = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.clientCapabilities]: 'tools' } },
    );
    expect(badCaps.status).toBe(400);
    expect(errorOf(badCaps)!.code).toBe(-32602);
  });
});

// ───────────────────────── methods and framing ──────────────────────────────

describe('unknown methods and removed framing', () => {
  it.each([
    'tools/does-not-exist',
    'nonsense',
    'logging/setLevel',
    'ping',
    'resources/subscribe',
    'resources/unsubscribe',
    'initialize',
  ])('answers %s with HTTP 404 and -32601 on the modern leg', async (method) => {
    const rig = await startRig('dual');
    const answer = await modernPost(rig, method, {});
    expect(answer.status, method).toBe(404);
    expect(errorOf(answer)!.code, method).toBe(-32601);
  });

  it('accepts an unknown NOTIFICATION with 202 rather than answering an error', async () => {
    // A notification has no id, so there is nothing to answer; the revision's
    // rule for an accepted notification is 202 with no body, and inventing an
    // error frame here would break the "no response to a notification" rule.
    const rig = await startRig('dual');
    const answer = await rawRequest(rig, {
      headers: { 'MCP-Protocol-Version': MODERN_REVISION, 'Mcp-Method': 'notifications/unknown' },
      body: {
        jsonrpc: '2.0',
        method: 'notifications/unknown',
        params: {
          _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
        },
      },
    });
    expect(answer.status).toBe(202);
    expect(answer.body).toBeNull();
  });

  it('refuses a JSON-RPC batch carrying requests', async () => {
    // Batching was removed in this revision; accepting one would mean answering
    // with a batch the revision has no framing rules for.
    const rig = await startRig('dual');
    const answer = await rawRequest(rig, {
      headers: { 'MCP-Protocol-Version': MODERN_REVISION, 'Mcp-Method': 'tools/list' },
      body: [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: { [META.protocolVersion]: MODERN_REVISION, [META.clientCapabilities]: {} },
          },
        },
      ],
    });
    expect(answer.status).toBe(400);
    expect(errorOf(answer)!.code).toBe(-32600);
  });

  it('ignores the two headers the revision retired, on every method', async () => {
    const rig = await startRig('modern');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { headers: { 'Mcp-Session-Id': 'ghost-session', 'Last-Event-ID': '42' } },
    );
    expect(answer.status).toBe(200);
    expect(answer.sessionId).toBeNull();
  });
});

// ───────────────────── the allocation policy, negatively ────────────────────

describe('the codes this server may not emit', () => {
  it('emits no reserved or legacy-sub-range code across the negative matrix', async () => {
    const rig = await startRig('dual');
    const answers = [
      await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': 'prompts/list' } }),
      await modernPost(rig, 'nope', {}),
      await modernPost(rig, 'tools/list', {}, { meta: { [META.protocolVersion]: '1900-01-01' } }),
      await modernPost(rig, 'tools/list', {}, { meta: { [META.protocolVersion]: undefined } }),
      await modernPost(rig, 'resources/read', { uri: 'avito://nope' }),
      await modernPost(rig, 'tools/call', { name: 'not_a_tool', arguments: {} }),
      await modernPost(rig, 'prompts/get', { name: 'not_a_prompt', arguments: {} }),
    ];
    for (const answer of answers) {
      const code = errorOf(answer)?.code;
      if (code === undefined) continue;
      expect(code, `code ${code}`).not.toBe(-32002);
      expect(code, `code ${code}`).not.toBe(-32042);
      expect(isLegacySubRangeCode(code), `code ${code}`).toBe(false);
      const specReserved = code <= -32020 && code >= -32099;
      if (specReserved) {
        expect([-32020, -32021, -32022], `code ${code}`).toContain(code);
      }
    }
  });

  it('allocates every code of its own strictly outside the JSON-RPC reserved range', () => {
    for (const [name, code] of Object.entries(APP_ERROR_CODES)) {
      expect(code, name).toBeGreaterThan(-32000);
      expect(code, name).toBeLessThan(0);
    }
  });
});
