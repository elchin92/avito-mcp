/**
 * The gaps an adversarial pass over M3/M4 found, each pinned by a test that
 * fails on the code as it was before this file existed.
 *
 * They have nothing in common except that every one of them is invisible from
 * the happy path:
 *
 *   • the stdio era pin is a decision the SDK makes ONCE per connection, from
 *     the first classifiable message, and never revisits (F1 / M3.10);
 *   • an already-pinned modern stdio connection revalidates nothing, so the
 *     `-32022` that HTTP gets right is unreachable there (F4 / A5);
 *   • `subscriptions/listen` acknowledges whatever filter it is handed, which
 *     turns the ack — the client's only contract for what a stream will carry —
 *     into a promise the server cannot keep, and turns a foreign URI into a
 *     confirmation that the server accepted it (F5 / A9);
 *   • codes from the sub-range the revision closed to new implementations
 *     (F2 / A13);
 *   • `/mcp` lost its only quantitative barrier when sessions went away
 *     (F3 / M3.8);
 *   • text handed to the model may name a method its era removed (F6 / M4.9);
 *   • `-32021` has no reachable producer on this surface (F7 / A7).
 *
 * Whenever the assertion is about bytes on the wire it is made on the raw
 * frame, never through a typed client — see `test/support/modern-rig.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  META,
  MODERN_REVISION,
  closeRigs,
  errorOf,
  initializeMessage,
  legacyPost,
  modernPost,
  openModernStream,
  rawRequest,
  resultOf,
  startRig,
} from './support/modern-rig.js';
import {
  closeStdioConnections,
  legacyMessage,
  modernMessage,
  startStdio,
} from './support/stdio-rig.js';
import { PENDING_ACTIONS_URI, WEBHOOK_EVENTS_URI } from '../src/resources.js';
import { MODERN_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/version.js';
import {
  MODERN_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
  serverInstructionsFor,
} from '../src/build-server.js';
import {
  APP_ERROR_CODES,
  LEGACY_WIRE_ERROR_CODES,
  SPEC_RESERVED_CODES,
  isLegacySubRangeCode,
} from '../src/core/rpc-codes.js';
import { createStdioEraTransport } from '../src/stdio-era.js';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

const REPO_ROOT = resolve(import.meta.dirname, '..');

afterEach(async () => {
  await closeRigs();
  await closeStdioConnections();
});

// ───────────────── F1 / M3.10 — the stdio era pin is diagnosable ─────────────

describe('F1 — a dual stdio connection that pins to legacy says so on stderr', () => {
  it('warns when the first classifiable message carries no modern envelope', async () => {
    // The trap: `serveStdio` classifies the OPENING message and pins the
    // connection for its whole life. A 2026 client whose first frame happens to
    // carry no `_meta` envelope (a `tools/call` written by hand, a proxy that
    // strips `_meta`, a client that probes with `tools/list` first) is legacy
    // FOREVER on that connection — and nothing anywhere says so.
    //
    // The pin itself is the SDK's; see the limitation recorded in the ADR. What
    // must not be missing is the diagnostic: an operator rolling `dual` out has
    // to be able to see, per connection, which era it ended up on.
    const conn = await startStdio('dual');
    conn.send(legacyMessage(1, 'tools/list', {}));
    const line = await conn.waitForStderr(/protocol era pinned/i);
    expect(line).toBeTruthy();
    expect(conn.stderr()).toContain('legacy');
    // The method that did the pinning has to be in the line: "someone pinned
    // legacy" is not actionable, "tools/list pinned legacy" is.
    expect(conn.stderr()).toContain('tools/list');
    await conn.close();
  }, 90_000);

  it('keeps stdout free of the diagnostic (stdout is the protocol)', async () => {
    const conn = await startStdio('dual');
    conn.send(legacyMessage(1, 'tools/list', {}));
    await conn.waitForStderr(/protocol era pinned/i);
    // The first stdout frame must still be the answer to the request, not a log
    // line: on stdio, anything else written to stdout corrupts the stream.
    const frame = await conn.next();
    expect(frame.id).toBe(1);
    await conn.close();
  }, 90_000);

  it('does not warn when the connection pins to the modern era', async () => {
    const conn = await startStdio('dual');
    conn.send(modernMessage(1, 'tools/list'));
    const frame = await conn.next();
    expect(frame.result).toBeDefined();
    expect(conn.stderr()).not.toMatch(/protocol era pinned to legacy/i);
    await conn.close();
  }, 90_000);
});

// ─────── F1 + F4 + F5, in process, through the transport seam ────────────────

describe('createStdioEraTransport (the seam the three stdio fixes hang on)', () => {
  /**
   * A stand-in for the real stdio wire. `createStdioEraTransport` takes it
   * through `options.inner` precisely so the branch matrix can be driven here
   * instead of through a spawned server — the child-process suites above prove
   * the wiring, this proves the logic, and the two fail for different reasons.
   */
  class FakeWire implements Transport {
    sent: JSONRPCMessage[] = [];
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    started = false;
    closed = false;
    async start(): Promise<void> {
      this.started = true;
    }
    async send(message: JSONRPCMessage): Promise<void> {
      this.sent.push(message);
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }

  interface Harness {
    wire: FakeWire;
    warnings: string[];
    forwarded: JSONRPCMessage[];
    errors: Error[];
    deliver(message: unknown): Promise<void>;
  }

  async function harness(era: 'dual' | 'modern'): Promise<Harness> {
    const wire = new FakeWire();
    const warnings: string[] = [];
    const forwarded: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    const transport = createStdioEraTransport({
      era,
      supportedModernVersions: [MODERN_PROTOCOL_VERSION],
      subscribableUris: [PENDING_ACTIONS_URI],
      warn: (line) => warnings.push(line),
      inner: wire,
    });
    transport.onmessage = (message) => forwarded.push(message);
    transport.onerror = (error) => errors.push(error);
    await transport.start();
    return {
      wire,
      warnings,
      forwarded,
      errors,
      deliver: async (message) => {
        wire.onmessage!(message as JSONRPCMessage);
        // handleInbound yields once before doing anything, so the assertions
        // must wait for the same microtask turn.
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it('warns exactly once per connection when dual pins to legacy', async () => {
    const h = await harness('dual');
    await h.deliver(legacyMessage(1, 'tools/list'));
    await h.deliver(legacyMessage(2, 'resources/list'));
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('protocol era pinned to legacy');
    expect(h.warnings[0]).toContain('tools/list');
    // The messages themselves are untouched: the diagnostic never changes what
    // the 2025 leg is handed.
    expect(h.forwarded).toHaveLength(2);
    expect(h.wire.sent).toHaveLength(0);
  });

  it('does not warn on a modern-only deployment (nothing was lost there)', async () => {
    const h = await harness('modern');
    await h.deliver(legacyMessage(1, 'initialize', { protocolVersion: '2025-11-25' }));
    expect(h.warnings).toEqual([]);
  });

  it('leaves the OPENING unsupported-revision answer to the SDK', async () => {
    // The entry's own classifier answers this identically; producing our copy
    // first would make it the one that has to track the entry.
    const h = await harness('modern');
    await h.deliver(modernMessage(1, 'tools/list', {}, { [META.protocolVersion]: '2099-01-01' }));
    expect(h.wire.sent).toHaveLength(0);
    expect(h.forwarded).toHaveLength(1);
  });

  it('answers -32022 itself once the connection is pinned modern', async () => {
    const h = await harness('modern');
    await h.deliver(modernMessage(1, 'tools/list'));
    await h.deliver(modernMessage(2, 'tools/list', {}, { [META.protocolVersion]: '2099-01-01' }));
    expect(h.forwarded).toHaveLength(1);
    const [answer] = h.wire.sent as Array<{ id: number; error: { code: number; data: unknown } }>;
    expect(answer!.id).toBe(2);
    expect(answer!.error.code).toBe(-32022);
    expect(answer!.error.data).toMatchObject({
      requested: '2099-01-01',
      supported: [MODERN_PROTOCOL_VERSION],
    });
  });

  it('drops — never answers — a notification claiming an unsupported revision', async () => {
    // A JSON-RPC notification has no id, so there is nothing to answer; the
    // revision's own rule is accept-and-drop, reported out of band.
    const h = await harness('modern');
    await h.deliver(modernMessage(1, 'tools/list'));
    const notification = modernMessage(0, 'notifications/cancelled', { requestId: 1 }, {
      [META.protocolVersion]: '2099-01-01',
    }) as Record<string, unknown>;
    delete notification.id;
    await h.deliver(notification);
    expect(h.forwarded).toHaveLength(1);
    expect(h.wire.sent).toHaveLength(0);
    expect(h.errors.map((e) => e.message).join()).toContain('2099-01-01');
  });

  it('does not read a stray protocolVersion key on a legacy-pinned connection', async () => {
    // On 2025-11-25 `_meta` is free-form: a client may carry any key there, and
    // reading one of them as an era claim would refuse a legal 2025 message.
    const h = await harness('dual');
    await h.deliver(legacyMessage(1, 'tools/list'));
    await h.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { _meta: { [META.protocolVersion]: '2099-01-01' } },
    });
    expect(h.wire.sent).toHaveLength(0);
    expect(h.forwarded).toHaveLength(2);
  });

  it('narrows a listen filter and leaves every other message by reference', async () => {
    const h = await harness('modern');
    const listen = modernMessage(1, 'subscriptions/listen', {
      notifications: {
        toolsListChanged: true,
        resourceSubscriptions: ['file:///etc/passwd', PENDING_ACTIONS_URI],
      },
    });
    await h.deliver(listen);
    const params = (h.forwarded[0] as unknown as { params: { notifications: Record<string, unknown> } }).params;
    expect(params.notifications.resourceSubscriptions).toEqual([PENDING_ACTIONS_URI]);
    // Fields we do not own are carried through untouched.
    expect(params.notifications.toolsListChanged).toBe(true);

    const plain = modernMessage(2, 'tools/list');
    await h.deliver(plain);
    expect(h.forwarded[1]).toBe(plain);
  });

  it('removes the key entirely when nothing survives the narrowing', async () => {
    const h = await harness('modern');
    await h.deliver(
      modernMessage(1, 'subscriptions/listen', {
        notifications: { resourceSubscriptions: ['file:///etc/passwd'] },
      }),
    );
    const params = (h.forwarded[0] as unknown as { params: { notifications: Record<string, unknown> } }).params;
    expect('resourceSubscriptions' in params.notifications).toBe(false);
  });

  it('passes responses and lifecycle callbacks straight through', async () => {
    const h = await harness('dual');
    const response = { jsonrpc: '2.0', id: 7, result: {} };
    await h.deliver(response);
    expect(h.forwarded[0]).toBe(response);
    let closed = false;
    const transportClose = h.wire.onclose;
    expect(typeof transportClose).toBe('function');
    h.wire.onerror!(new Error('wire blew up'));
    expect(h.errors.at(-1)?.message).toBe('wire blew up');
    h.wire.onclose = () => {
      closed = true;
      transportClose!();
    };
    h.wire.onclose();
    expect(closed).toBe(true);
  });
});

// ───────────────── F4 / A5 — -32022 on a pinned modern stdio connection ──────

describe('F4 — a pinned modern stdio connection revalidates the protocol version', () => {
  it('answers -32022 for an unsupported revision on a LATER message', async () => {
    // On HTTP every request is classified, so a bad `protocolVersion` is caught
    // per request. On stdio the classification happens once: after the pin,
    // `serveStdio` calls `channel.deliver(message)` with no classification, and
    // the 2026 codec's envelope check only asserts that `protocolVersion` is a
    // STRING (`RequestMetaEnvelopeSchema`: `z.string()`), never that it is one
    // we serve. Result before this test: `2099-01-01` was served normally.
    const conn = await startStdio('modern');
    conn.send(modernMessage(1, 'tools/list'));
    const pinned = await conn.next();
    expect(pinned.result).toBeDefined();

    conn.send(
      modernMessage(2, 'tools/list', {}, { [META.protocolVersion]: '2099-01-01' }),
    );
    const answer = await conn.next();
    expect(answer.result).toBeUndefined();
    expect(answer.error?.code).toBe(-32022);
    const data = answer.error!.data as { supported: string[]; requested: string };
    expect(data.requested).toBe('2099-01-01');
    expect(data.supported).toEqual([MODERN_PROTOCOL_VERSION]);
    await conn.close();
  }, 90_000);

  it('answers -32022 for a pre-2026 revision claimed on a pinned modern connection', async () => {
    const conn = await startStdio('modern');
    conn.send(modernMessage(1, 'tools/list'));
    await conn.next();
    conn.send(
      modernMessage(2, 'resources/list', {}, { [META.protocolVersion]: '1900-01-01' }),
    );
    const answer = await conn.next();
    expect(answer.error?.code).toBe(-32022);
    await conn.close();
  }, 90_000);

  it('still serves a correctly versioned message after a rejected one', async () => {
    // The check must reject the message, not poison the connection.
    const conn = await startStdio('modern');
    conn.send(modernMessage(1, 'tools/list'));
    await conn.next();
    conn.send(modernMessage(2, 'tools/list', {}, { [META.protocolVersion]: '2099-01-01' }));
    expect((await conn.next()).error?.code).toBe(-32022);
    conn.send(modernMessage(3, 'tools/list'));
    const good = await conn.next();
    expect(good.id).toBe(3);
    expect(good.result).toBeDefined();
    await conn.close();
  }, 90_000);
});

// ───────────────── F5 / A9 — subscriptions/listen narrows its filter ─────────

describe('F5 — the listen ack carries the subset the server can actually deliver', () => {
  it('drops URIs this server never publishes for', async () => {
    // The SDK's `honoredSubset` narrows the three list-changed bits against the
    // declared capabilities but copies `resourceSubscriptions` verbatim
    // (`honored.resourceSubscriptions = [...requested.resourceSubscriptions]`).
    // So the ack promised updates for `avito://manifest` — a static file — and
    // for URIs this server has no publisher for at all.
    const rig = await startRig('dual');
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: {
        resourceSubscriptions: [
          PENDING_ACTIONS_URI,
          'avito://manifest',
          'avito://docs/safety',
          WEBHOOK_EVENTS_URI,
        ],
      },
    });
    const ack = await stream.next();
    expect(ack.method).toBe('notifications/subscriptions/acknowledged');
    const honored = (ack.params as { notifications: { resourceSubscriptions?: string[] } })
      .notifications;
    // Exactly the two URIs `subscribableResourceUris` yields under this policy,
    // in the caller's own order. `avito://manifest` and `avito://docs/safety`
    // are real resources with no publisher, which is precisely the case the ack
    // must not confirm.
    expect(honored.resourceSubscriptions).toEqual([PENDING_ACTIONS_URI, WEBHOOK_EVENTS_URI]);
    stream.abort();
  }, 30_000);

  it('does not confirm a subscription to a foreign URI scheme', async () => {
    // Acknowledging `file:///etc/passwd` is two problems at once: a promise the
    // server cannot keep, and a signal to the caller that the server accepted a
    // `file://` URI at all.
    const rig = await startRig('dual');
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: ['file:///etc/passwd'] },
    });
    const ack = await stream.next();
    const honored = (ack.params as { notifications: { resourceSubscriptions?: string[] } })
      .notifications;
    expect(honored.resourceSubscriptions).toBeUndefined();
    expect(JSON.stringify(ack)).not.toContain('/etc/passwd');
    stream.abort();
  }, 30_000);

  it('still delivers updates for a URI that survived the narrowing', async () => {
    // Narrowing must not break the feature it narrows.
    const rig = await startRig('dual');
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: {
        resourceSubscriptions: ['file:///etc/passwd', PENDING_ACTIONS_URI],
      },
    });
    const ack = await stream.next();
    expect(
      (ack.params as { notifications: { resourceSubscriptions?: string[] } }).notifications
        .resourceSubscriptions,
    ).toEqual([PENDING_ACTIONS_URI]);
    await rig.ctx.pendingStore.createPersistent({
      toolName: 'items_update_price',
      risk: 'money',
      summary: 'narrowing probe',
      args: {},
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    });
    const update = await stream.next();
    expect(update.method).toBe('notifications/resources/updated');
    expect((update.params as { uri: string }).uri).toBe(PENDING_ACTIONS_URI);
    stream.abort();
  }, 30_000);

  it('narrows on stdio as well as on HTTP', async () => {
    const conn = await startStdio('modern');
    conn.send(
      modernMessage(1, 'subscriptions/listen', {
        notifications: {
          resourceSubscriptions: ['file:///etc/passwd', 'avito://manifest', PENDING_ACTIONS_URI],
        },
      }),
    );
    const ack = await conn.next();
    expect(ack.method).toBe('notifications/subscriptions/acknowledged');
    const honored = (ack.params as { notifications: { resourceSubscriptions?: string[] } })
      .notifications;
    expect(honored.resourceSubscriptions).toEqual([PENDING_ACTIONS_URI]);
    await conn.close();
  }, 90_000);
});

// ───────────────── F2 / A13 — error codes out of the closed sub-range ────────

describe('F2 — no answer allocates a code from the legacy sub-range', () => {
  it('the modern 405 does not answer -32000', async () => {
    const rig = await startRig('modern');
    const answer = await rawRequest(rig, {
      method: 'GET',
      headers: { 'MCP-Protocol-Version': MODERN_REVISION },
    });
    expect(answer.status).toBe(405);
    expect(answer.allow).toBe('POST');
    const code = errorOf(answer)!.code;
    expect(code).toBe(APP_ERROR_CODES.methodNotAllowed);
    expect(code).toBeGreaterThan(-32000);
  });

  // The two session answers below are the SCOPE of this heading, stated as
  // tests: the sub-range is closed to what a 2026 client can receive, and these
  // two are structurally unreachable from that era (2026-07-28 has no
  // sessions). They therefore keep 1.3.3's numbers — which is also what the v2
  // SDK's own legacy transport answers — and the guard below still holds for
  // every modern answer. See LEGACY_WIRE_ERROR_CODES in src/core/rpc-codes.ts.
  it('the legacy leg still answers a missing session id with 1.3.3 -32000', async () => {
    const rig = await startRig('legacy');
    const answer = await legacyPost(rig, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(answer.status).toBe(400);
    expect(errorOf(answer)!.code).toBe(LEGACY_WIRE_ERROR_CODES.missingSessionId);
  });

  it('the legacy leg still answers an unknown session id with 1.3.3 -32001', async () => {
    const rig = await startRig('legacy');
    const answer = await legacyPost(
      rig,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      '00000000-0000-4000-8000-000000000000',
    );
    // The status is the contract clients react to (re-initialize); the number
    // beside it is the one 1.3.3 shipped.
    expect(answer.status).toBe(404);
    expect(errorOf(answer)!.code).toBe(LEGACY_WIRE_ERROR_CODES.sessionNotFound);
  });

  it('never answers a modern request with a code in -32000…-32019', async () => {
    // The guard. Every code this era can produce is either base JSON-RPC, one
    // of the three the revision defines, or ours from outside the reserved
    // range — nothing from the sub-range new implementations may not use.
    const rig = await startRig('dual');
    const modernOnly = await startRig('modern');
    const codes = new Set<number>();
    const collect = (code: number | undefined): void => {
      if (code !== undefined) codes.add(code);
    };
    collect(errorOf(await modernPost(rig, 'no/such/method'))?.code);
    collect(errorOf(await modernPost(rig, 'resources/subscribe', { uri: PENDING_ACTIONS_URI }))?.code);
    collect(
      errorOf(await modernPost(rig, 'tools/list', {}, { meta: { [META.protocolVersion]: undefined } }))
        ?.code,
    );
    collect(errorOf(await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': null } }))?.code);
    collect(
      errorOf(await modernPost(rig, 'tools/list', {}, { headers: { 'MCP-Protocol-Version': null } }))
        ?.code,
    );
    collect(errorOf(await modernPost(rig, 'resources/read', { uri: 'avito://nope' }))?.code);
    collect(
      errorOf(await modernPost(modernOnly, 'tools/list', {}, { meta: { [META.protocolVersion]: '1900-01-01' } }))
        ?.code,
    );
    collect(errorOf(await legacyPost(modernOnly, initializeMessage()))?.code);
    collect(
      errorOf(await rawRequest(modernOnly, { method: 'DELETE', headers: { 'MCP-Protocol-Version': MODERN_REVISION } }))
        ?.code,
    );
    collect(errorOf(await rawRequest(modernOnly, { method: 'GET', headers: { 'MCP-Protocol-Version': MODERN_REVISION } }))?.code);

    expect([...codes].sort((a, b) => a - b)).toEqual(
      expect.arrayContaining([-32602, -32601, -32020, -32022]),
    );
    // The predicate comes from the policy module, not from a literal repeated
    // here: one definition of "the closed sub-range", used by the code that
    // must avoid it and by the test that proves it did.
    for (const code of codes) {
      expect(isLegacySubRangeCode(code), `code ${code} is in the closed legacy sub-range`).toBe(
        false,
      );
      if (code <= -32020 && code >= -32099) {
        expect(SPEC_RESERVED_CODES, `code ${code}`).toContain(code);
      }
    }
    // And the block we allocate from is itself outside the reserved range.
    for (const [name, code] of Object.entries(APP_ERROR_CODES)) {
      expect(isLegacySubRangeCode(code), name).toBe(false);
      expect(code, name).toBeGreaterThan(-32000);
    }
  }, 60_000);
});

// ───────────────── F3 / M3.8 — a quantitative limit on /mcp ──────────────────

describe('F3 — /mcp keeps a quantitative barrier after sessions went away', () => {
  it('refuses a subscription stream past AVITO_MCP_HTTP_MAX_STREAMS', async () => {
    const rig = await startRig('dual', (config) => {
      config.http.maxStreams = 1;
    });
    const first = await openModernStream(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] },
    });
    expect((await first.next()).method).toBe('notifications/subscriptions/acknowledged');

    const refused = await modernPost(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] },
    });
    expect(refused.status).toBe(503);
    expect(errorOf(refused)!.code).toBe(APP_ERROR_CODES.streamLimitReached);
    first.abort();
  }, 30_000);

  it('refuses a plain request past AVITO_MCP_HTTP_MAX_INFLIGHT', async () => {
    const rig = await startRig('dual', (config) => {
      config.http.maxInflight = 1;
    });
    const held = await openModernStream(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] },
    });
    expect((await held.next()).method).toBe('notifications/subscriptions/acknowledged');

    const refused = await modernPost(rig, 'tools/list');
    expect(refused.status).toBe(503);
    expect(errorOf(refused)!.code).toBe(APP_ERROR_CODES.inflightLimitReached);
    // A refusal, not a crash: the endpoint keeps serving once the slot frees.
    held.abort();
    await held.ended();
    const recovered = await modernPost(rig, 'tools/list');
    expect(recovered.status).toBe(200);
    expect(resultOf(recovered)).toBeDefined();
  }, 30_000);

  it('names the limits in the help text and .env.example', () => {
    // The README stability contract covers env-variable NAMES and defaults, so
    // a new one has to appear where operators look for it.
    const help = readFileSync(resolve(REPO_ROOT, 'src', 'server.ts'), 'utf8');
    expect(help).toContain('AVITO_MCP_HTTP_MAX_INFLIGHT');
    expect(help).toContain('AVITO_MCP_HTTP_MAX_STREAMS');
    const envExample = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
    expect(envExample).toContain('AVITO_MCP_HTTP_MAX_INFLIGHT');
    expect(envExample).toContain('AVITO_MCP_HTTP_MAX_STREAMS');
    for (const readme of ['README.md', 'README.ru.md']) {
      const text = readFileSync(resolve(REPO_ROOT, readme), 'utf8');
      expect(text, readme).toContain('AVITO_MCP_HTTP_MAX_INFLIGHT');
      expect(text, readme).toContain('AVITO_MCP_HTTP_MAX_STREAMS');
    }
  });
});

// ───────────────── malformed JSON reaches the MCP layer ──────────────────────

describe('a malformed JSON body is answered as a JSON-RPC parse error', () => {
  it('answers -32700, not express.json()"s {"error":"bad_request"}', async () => {
    const rig = await startRig('dual');
    const res = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: rig.host,
        'MCP-Protocol-Version': MODERN_REVISION,
        'Mcp-Method': 'tools/list',
      },
      body: '{"jsonrpc":"2.0","id":1,',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code: number };
      id?: unknown;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it('does NOT answer that way under the default (legacy) posture', async () => {
    // This assertion used to read "answers the same way on the legacy leg",
    // and that was the defect. `-32700` is the right answer on revision
    // 2026-07-28 — which is why the case above exists — but it is not the
    // answer a real 1.3.3 gives. That is `{"error":"bad_request"}`, and it is
    // not a JSON-RPC frame at all: measured, in
    // `test/baselines/legacy-1.3.3-wire.json`, steps 38–40. Applying the
    // conformance fix to both legs improved a wire that 2025 clients were
    // already shipped, which is the one thing the legacy leg may not do.
    //
    // The split is argued in `src/http/app.ts` and asserted from both sides in
    // `test/wire-error-shapes.test.ts`. What is pinned HERE is the negative, so
    // that restoring the one-handler-for-both-legs shortcut means deleting a
    // test that says why it was wrong.
    const rig = await startRig('legacy');
    const res = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: rig.host,
      },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });
});

// ───────────────── F6 / M4.9 — no era advertises its own removed methods ─────

describe('F6 — model-facing text never names a method the era removed', () => {
  /** Methods that do not exist on the given era and would answer -32601 there. */
  const REMOVED = {
    modern: [
      'resources/subscribe',
      'resources/unsubscribe',
      'logging/setLevel',
      'notifications/initialized',
    ],
    legacy: ['subscriptions/listen', 'server/discover'],
  } as const;

  function assertClean(era: keyof typeof REMOVED, label: string, blob: string): void {
    for (const method of REMOVED[era]) {
      expect(blob, `${label} (era=${era}) names the removed method ${method}`).not.toContain(
        method,
      );
    }
  }

  it('holds for the instruction brief of each era', () => {
    assertClean('modern', 'MODERN_SERVER_INSTRUCTIONS', serverInstructionsFor('modern'));
    assertClean('legacy', 'SERVER_INSTRUCTIONS', SERVER_INSTRUCTIONS);
    // The safety half is the reason this text exists at all; it must survive
    // every rewrite of the subscription half.
    for (const anchor of ['confirmation_id', 'meta_confirm_action', 'avito://docs/safety']) {
      expect(MODERN_SERVER_INSTRUCTIONS).toContain(anchor);
      expect(SERVER_INSTRUCTIONS).toContain(anchor);
    }
  });

  it('holds for every string the modern era puts in front of the model', async () => {
    const rig = await startRig('dual');
    const discover = resultOf(await modernPost(rig, 'server/discover'))!;
    assertClean('modern', 'server/discover', JSON.stringify(discover));
    for (const method of [
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'prompts/list',
    ]) {
      const result = resultOf(await modernPost(rig, method));
      assertClean('modern', method, JSON.stringify(result));
    }
    const resources = (
      resultOf(await modernPost(rig, 'resources/list'))! as { resources: Array<{ uri: string }> }
    ).resources;
    for (const resource of resources) {
      const read = resultOf(await modernPost(rig, 'resources/read', { uri: resource.uri }));
      assertClean('modern', `resources/read ${resource.uri}`, JSON.stringify(read));
    }
  }, 60_000);

  it('holds for every string the legacy era puts in front of the model', async () => {
    const rig = await startRig('dual');
    const init = await legacyPost(rig, initializeMessage());
    assertClean('legacy', 'initialize', JSON.stringify(resultOf(init)));
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
    for (const method of ['tools/list', 'resources/list', 'prompts/list']) {
      const answer = await legacyPost(
        rig,
        { jsonrpc: '2.0', id: 2, method, params: {} },
        init.sessionId,
      );
      assertClean('legacy', method, JSON.stringify(resultOf(answer)));
    }
  }, 60_000);
});

// ───────────────── F7 / A7 — -32021 is an explicit decision ──────────────────

describe('F7 — the -32021 decision is recorded and guarded', () => {
  it('has an ADR that states the decision', () => {
    const adr = readFileSync(
      resolve(REPO_ROOT, 'docs', 'adr', '0001-protocol-era-limitations.md'),
      'utf8',
    );
    expect(adr).toContain('-32021');
    expect(adr).toContain('MissingRequiredClientCapability');
    // The ADR must also carry the stdio-pin limitation, which is the other
    // thing this branch cannot fix in our own code.
    expect(adr).toContain('serveStdio');
  });

  it('no primitive on this surface requires a client capability', async () => {
    // The claim the ADR rests on, checked rather than asserted in prose: the
    // SDK's static requirement table is empty, so no spec METHOD requires a
    // capability, and `-32021` becomes reachable only when a handler returns an
    // `inputRequired` result (MRTR). Nothing in `src/` does — deliberately, see
    // MIGRATION_PLAN §1.3.
    const { specTypeSchemas } = await import('@modelcontextprotocol/server');
    expect(typeof specTypeSchemas).toBe('object');
    const sources = ['src/core/tool-factory.ts', 'src/build-server.ts', 'src/resources.ts'];
    for (const relative of sources) {
      const code = readFileSync(resolve(REPO_ROOT, relative), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, relative).not.toContain('inputRequired');
      expect(code, relative).not.toContain("resultType: 'input_required'");
    }
  });

  it('advertises only revisions we actually serve', () => {
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toContain(MODERN_PROTOCOL_VERSION);
  });
});
