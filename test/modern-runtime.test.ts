/**
 * M3 block A, points 9–16, asserted on a MODERN connection — plus the
 * `capabilities.listChanged` decision M2 deferred to this stage.
 *
 * The same division of labour as `test/modern-conformance.test.ts` applies, and
 * it is worth stating per point, because most of the value of this file is
 * knowing which half of each requirement is the SDK's:
 *
 *   SDK — asserted here, NOT written here. Re-implementing any of it in `src/`
 *   would be a second implementation free to drift:
 *     • the whole `subscriptions/listen` wire: ack-first, per-stream filtering,
 *       `io.modelcontextprotocol/subscriptionId` stamping, the graceful
 *       `{resultType:'complete'}` on shutdown (`createListenRouter`);
 *     • the `logLevel` gate on `ctx.mcpReq.log` and its delivery on the
 *       request's own stream (`Server.buildContext`);
 *     • `-32602` for an unrecognised log level (the 2026 codec's envelope
 *       validation);
 *     • `-32602` + `data.uri` for an unregistered resource URI.
 *
 *   OURS, because the SDK cannot know it:
 *     • which change events exist at all and which URIs they belong to — the
 *       publisher side moved from the McpServer instance to the handler
 *       (`src/http/mcp-http.ts`), because a modern instance lives for one
 *       request and a listen stream outlives all of them;
 *     • the capability bits the ack is narrowed against (`capabilitiesFor`);
 *     • installing `ctx.mcpReq.log` as the ambient sink for the pino mirror,
 *       and NOT registering a modern instance as a connection-level sink
 *       (`build-server.ts`);
 *     • propagating the request's abort signal into the outgoing Avito call and
 *       giving the rate-limiter slot back (`tool-factory.ts`, `client.ts`,
 *       `rate-limiter.ts`);
 *     • answering `-32602` rather than `-32603` for a missing swagger
 *       (`resources.ts`).
 *
 * Everything is driven with raw `fetch` and raw JSON-RPC through the real HTTP
 * server — see `test/support/modern-rig.ts` for why.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  META,
  closeRigs,
  errorOf,
  initializeMessage,
  legacyPost,
  modernPost,
  openModernStream,
  resultOf,
  startRig,
  type Frame,
  type Rig,
} from './support/modern-rig.js';
import { capabilitiesFor } from '../src/build-server.js';
import { TOOL_JSON_SCHEMA_DIALECT } from '../src/core/wire-compat.js';
import { PENDING_ACTIONS_URI, WEBHOOK_EVENTS_URI } from '../src/resources.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { WebhookStore } from '../src/core/webhook-store.js';
import { createSandbox, removeSandbox } from './support/sandbox.js';

afterEach(closeRigs);

const SRC_ROOT = resolve(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A pending action whose executor is inert — the point is the CHANGE event. */
async function makePending(rig: Rig): Promise<string> {
  const action = await rig.ctx.pendingStore.createPersistent({
    toolName: 'items_update_price',
    risk: 'money',
    summary: 'listen fixture',
    args: {},
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  });
  return action.id;
}

function subscriptionIdOf(frame: Frame): unknown {
  const meta = (frame.params?._meta ?? frame.result?._meta) as Record<string, unknown> | undefined;
  return meta?.[META.subscriptionId];
}

// ───────────────────── 9. subscriptions/listen ──────────────────────────────

describe('A9 — subscriptions/listen', () => {
  it('answers with the acknowledgement FIRST, carrying the honoured subset', async () => {
    // "First" is the whole contract of the ack: it is what tells the client
    // which of the notification types it asked for it will actually receive, so
    // anything delivered before it would be unattributable.
    const rig = await startRig('dual');
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: {
        toolsListChanged: true,
        promptsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: [PENDING_ACTIONS_URI],
      },
    });

    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');

    const ack = await stream.next();
    expect(stream.received()).toHaveLength(1);
    expect(ack.method).toBe('notifications/subscriptions/acknowledged');
    // The honoured subset is a SUBSET, not an echo: the three list_changed bits
    // were asked for and are not granted, because this server declares
    // `listChanged: false` on the modern era and never emits them. See
    // `capabilitiesFor` — this frame is the client-visible consequence of that
    // decision, and the reason it had to be made before shipping listen.
    expect(ack.params?.notifications).toEqual({ resourceSubscriptions: [PENDING_ACTIONS_URI] });
    expect(subscriptionIdOf(ack)).toBe(1);

    stream.abort();
  });

  it('stamps the subscription id on every notification the stream carries', async () => {
    const rig = await startRig('dual');
    const stream = await openModernStream(
      rig,
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] } },
      { id: 'sub-alpha' },
    );
    await stream.next();

    await makePending(rig);
    const event = await stream.next();
    expect(event.method).toBe('notifications/resources/updated');
    expect(event.params?.uri).toBe(PENDING_ACTIONS_URI);
    expect(subscriptionIdOf(event)).toBe('sub-alpha');

    // Not just the first one: the stamp is per message, and a second event must
    // carry it too.
    await makePending(rig);
    const second = await stream.next();
    expect(subscriptionIdOf(second)).toBe('sub-alpha');

    for (const frame of stream.received()) {
      expect(subscriptionIdOf(frame)).toBe('sub-alpha');
    }
    stream.abort();
  });

  it('never delivers a type the stream did not ask for', async () => {
    // The negative half, which is the one that actually needs a test: a filter
    // is only a filter if something is dropped by it. This stream asked for
    // webhook events only, so a pending-actions change — a real event, really
    // published on the same bus — must not appear on it.
    const rig = await startRig('dual', undefined, (ctx) => {
      ctx.webhookStore = new WebhookStore(10);
    });
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [WEBHOOK_EVENTS_URI] },
    });
    await stream.next();

    await makePending(rig);
    rig.ctx.webhookStore!.record({ id: 'evt-1' });

    const event = await stream.next();
    expect(event.method).toBe('notifications/resources/updated');
    expect(event.params?.uri).toBe(WEBHOOK_EVENTS_URI);

    // Everything that arrived, in order: the ack and exactly one event. A
    // pending-actions notification anywhere in here is the failure.
    const uris = stream
      .received()
      .filter((f) => f.method === 'notifications/resources/updated')
      .map((f) => f.params?.uri);
    expect(uris).toEqual([WEBHOOK_EVENTS_URI]);
    stream.abort();
  });

  it('keeps two concurrent subscriptions independent', async () => {
    const rig = await startRig('dual', undefined, (ctx) => {
      ctx.webhookStore = new WebhookStore(10);
    });
    const pendingStream = await openModernStream(
      rig,
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] } },
      { id: 'pending-sub' },
    );
    const webhookStream = await openModernStream(
      rig,
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [WEBHOOK_EVENTS_URI] } },
      { id: 'webhook-sub' },
    );
    await pendingStream.next();
    await webhookStream.next();

    await makePending(rig);
    const onPending = await pendingStream.next();
    expect(onPending.params?.uri).toBe(PENDING_ACTIONS_URI);
    expect(subscriptionIdOf(onPending)).toBe('pending-sub');

    rig.ctx.webhookStore!.record({ id: 'evt-2' });
    const onWebhook = await webhookStream.next();
    expect(onWebhook.params?.uri).toBe(WEBHOOK_EVENTS_URI);
    expect(subscriptionIdOf(onWebhook)).toBe('webhook-sub');

    expect(pendingStream.received().every((f) => subscriptionIdOf(f) === 'pending-sub')).toBe(true);
    expect(webhookStream.received().every((f) => subscriptionIdOf(f) === 'webhook-sub')).toBe(true);

    pendingStream.abort();
    webhookStream.abort();
  });

  it('closes every open stream gracefully when the server stops', async () => {
    const rig = await startRig('dual');
    const first = await openModernStream(
      rig,
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] } },
      { id: 7 },
    );
    const second = await openModernStream(
      rig,
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [WEBHOOK_EVENTS_URI] } },
      { id: 'eight' },
    );
    await first.next();
    await second.next();

    // `handle.close()` is what SIGTERM runs in `src/server.ts`.
    const closing = rig.handle.close();

    for (const [stream, id] of [
      [first, 7],
      [second, 'eight'],
    ] as const) {
      const closed = await stream.next();
      expect(closed.id).toBe(id);
      expect(closed.result).toMatchObject({ resultType: 'complete' });
      expect(subscriptionIdOf(closed)).toBe(id);
      await stream.ended();
      // The graceful result is the LAST thing on the wire, not merely present:
      // a client that received it and then got more would have no way to know
      // the subscription had ended.
      expect(stream.received().at(-1)).toBe(closed);
    }

    await closing;
  }, 30_000);

  it('does not publish updates for a resource the policy hides', async () => {
    // `AVITO_MCP_CONFIRMATION_MODE=off` removes `avito://state/pending-actions`
    // from `resources/list` entirely. A subscription must not become a side
    // channel that reports the same state changes anyway.
    const rig = await startRig('dual', (cfg) => {
      cfg.confirmationMode = 'off';
    });
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] },
    });
    await stream.next();

    await makePending(rig);
    await expect(stream.next(400)).rejects.toThrow(/no frame/);
    expect(stream.received()).toHaveLength(1);
    stream.abort();
  });

  it('keeps resources/subscribe working on the legacy leg of the same process', async () => {
    // Item 9 replaces the 2025 RPCs on the modern era only. Under `dual` both
    // wires are served by one process, and 2025 clients have not gone anywhere.
    const rig = await startRig('dual');
    const init = await legacyPost(rig, initializeMessage());
    const sessionId = init.sessionId!;
    expect(sessionId).toBeTruthy();
    await legacyPost(
      rig,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      sessionId,
    );

    const subscribed = await legacyPost(
      rig,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: PENDING_ACTIONS_URI },
      },
      sessionId,
    );
    expect(subscribed.status).toBe(200);
    expect(errorOf(subscribed)).toBeUndefined();

    // And the modern leg of the SAME process still refuses it, so the split is
    // per request rather than per deployment.
    const refused = await modernPost(rig, 'resources/subscribe', { uri: PENDING_ACTIONS_URI });
    expect(refused.status).toBe(404);
    expect(errorOf(refused)?.code).toBe(-32601);
  });
});

// ───────────────────── 10. notifications/message ────────────────────────────

describe('A10 — request-scoped notifications/message', () => {
  /** A tool call that is guaranteed to produce exactly one server log line. */
  async function callConfirm(
    rig: Rig,
    options: { logLevel?: string } = {},
  ): Promise<ReturnType<typeof openModernStream>> {
    const id = await makePending(rig);
    return openModernStream(
      rig,
      'tools/call',
      { name: 'meta_confirm_action', arguments: { confirmation_id: id } },
      {
        name: 'meta_confirm_action',
        ...(options.logLevel !== undefined ? { meta: { [META.logLevel]: options.logLevel } } : {}),
      },
    );
  }

  it('sends nothing for a request that declared no log level', async () => {
    // The MUST NOT. `meta_confirm_action` logs `pending action confirmed and
    // executing` at info on this exact path — the companion test below proves
    // the line really is produced — so an empty result here is the gate
    // working, not the absence of anything to send.
    const rig = await startRig('dual');
    const stream = await callConfirm(rig);
    await stream.ended();
    const frames = stream.received();
    expect(frames.filter((f) => f.method === 'notifications/message')).toEqual([]);
    expect(frames.at(-1)?.result).toBeDefined();
  });

  it('sends it on the response stream of THAT request when a level is declared', async () => {
    const rig = await startRig('dual');
    const stream = await callConfirm(rig, { logLevel: 'debug' });
    await stream.ended();
    const frames = stream.received();

    const logs = frames.filter((f) => f.method === 'notifications/message');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.params).toMatchObject({ level: 'info', logger: 'avito-mcp' });
    expect((logs[0]!.params!.data as { msg: string }).msg).toBe(
      'pending action confirmed and executing',
    );
    // Ordering matters as much as presence: the notification belongs to the
    // exchange, so it precedes the result on the same stream.
    expect(frames.indexOf(logs[0]!)).toBeLessThan(frames.length - 1);
    expect(frames.at(-1)?.result).toBeDefined();
  });

  it('rejects an unrecognised level with -32602', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(
      rig,
      'tools/list',
      {},
      { meta: { [META.logLevel]: 'very-loud' } },
    );
    expect(answer.status).toBe(400);
    expect(errorOf(answer)?.code).toBe(-32602);
    expect(errorOf(answer)?.message).toContain(META.logLevel);
  });

  it('accepts every level RFC 5424 defines', async () => {
    // The complement of the rejection above: a gate that rejected a legitimate
    // level would be just as wrong, and only the pair pins the boundary.
    const rig = await startRig('dual');
    for (const level of [
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency',
    ]) {
      const answer = await modernPost(rig, 'tools/list', {}, { meta: { [META.logLevel]: level } });
      expect(answer.status, level).toBe(200);
      expect(errorOf(answer), level).toBeUndefined();
    }
  });

  it('never puts a log line on a subscriptions/listen stream', async () => {
    // The second MUST NOT: not merely "scoped to a request", but "not on any
    // other stream". A listen stream is the only long-lived stream this era
    // has, so it is the only place a stray background mirror could surface —
    // and it is where the pre-M3 `background: true` binding would have put it.
    const rig = await startRig('dual');
    const stream = await openModernStream(rig, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] },
    });
    await stream.next();

    // Drive real work, with a log level declared, on a DIFFERENT request.
    const id = await makePending(rig);
    await stream.next();
    const call = await openModernStream(
      rig,
      'tools/call',
      { name: 'meta_confirm_action', arguments: { confirmation_id: id } },
      { name: 'meta_confirm_action', meta: { [META.logLevel]: 'debug' } },
    );
    await call.ended();
    expect(call.received().some((f) => f.method === 'notifications/message')).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(stream.received().some((f) => f.method === 'notifications/message')).toBe(false);
    stream.abort();
  });
});

// ───────────────────── 11. stream close is a cancellation ───────────────────

describe('A11 — closing the response stream cancels the work', () => {
  it('aborts the outgoing Avito call and frees the idempotency lease', async () => {
    // The fixture is a real HTTP exchange with a hung upstream: the token call
    // succeeds, the API call never answers. Nothing about the cancellation is
    // simulated — the client end of a real SSE response is closed, and the
    // assertions are on the signal the outgoing `fetch` actually saw.
    const realFetch = globalThis.fetch;
    let apiSignal: AbortSignal | undefined;
    let apiCalls = 0;
    const started: Array<() => void> = [];
    const firstCall = new Promise<void>((resolveStarted) => started.push(resolveStarted));

    const fetchMock = vi.fn(
      async (input: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1:')) {
          return realFetch(input as Parameters<typeof realFetch>[0], init as RequestInit);
        }
        if (url.includes('/token')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        apiCalls += 1;
        apiSignal = init?.signal;
        started.shift()?.();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rig = await startRig('dual', (cfg) => {
        // Confirmation off so the call reaches Avito on the first request
        // instead of parking as a pending action.
        cfg.confirmationMode = 'off';
      });
      const stream = await openModernStream(
        rig,
        'tools/call',
        {
          name: 'messenger_chat_read',
          arguments: { chat_id: 'c1', idempotencyKey: 'cancel-me-please' },
        },
        // The log level is load-bearing FIXTURE, not decoration: with
        // `responseMode: 'auto'` the response headers are not written until the
        // handler emits something, so without a mid-call notification the
        // opening `fetch` here would block until the (deliberately hung) Avito
        // call finished — i.e. forever. The token refresh logs one line, which
        // upgrades the exchange to SSE and hands us the open stream to close.
        { name: 'messenger_chat_read', meta: { [META.logLevel]: 'debug' } },
      );
      await firstCall;
      expect(apiCalls).toBe(1);
      expect(apiSignal?.aborted).toBe(false);
      // The lease is held while the call is in flight — otherwise the release
      // assertion below would prove nothing.
      expect(rig.ctx.idempotencyStore!.size()).toBe(1);

      stream.abort();

      await vi.waitFor(() => expect(apiSignal?.aborted).toBe(true), { timeout: 5_000 });
      // Freed, not merely finished: a retry with the same key must be able to
      // run rather than meet a wedged reservation.
      await vi.waitFor(() => expect(rig.ctx.idempotencyStore!.size()).toBe(0), { timeout: 5_000 });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('gives the reserved rate-limiter slot back', async () => {
    // Asserted directly on the limiter, because the shared budget only exists
    // when a durable state directory is configured — the rig runs process-local
    // by design, so a wire-level assertion here would be vacuously true.
    const sandbox = await createSandbox('rate-slot');
    try {
      const limiter = new RateLimiter({ stateDir: sandbox, namespace: 'ns' });
      const headers = new Headers({
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '5',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
      });
      limiter.observe('domain', headers);
      await limiter.flushPersisted();

      const before = (await limiter.getSharedStatus('domain'))[0]!.remaining;
      const slot = await limiter.waitIfNeeded('domain');
      const reserved = (await limiter.getSharedStatus('domain'))[0]!.remaining;
      expect(reserved).toBe(before! - 1);

      await slot.release();
      expect((await limiter.getSharedStatus('domain'))[0]!.remaining).toBe(before);

      // Idempotent: a double release would invent budget out of nothing.
      await slot.release();
      expect((await limiter.getSharedStatus('domain'))[0]!.remaining).toBe(before);
    } finally {
      await removeSandbox(sandbox);
    }
  }, 30_000);

  it('stops waiting for a rate-limit slot once the caller is cancelled', async () => {
    const sandbox = await createSandbox('rate-wait');
    try {
      const limiter = new RateLimiter({ stateDir: sandbox, namespace: 'ns' });
      // remaining: 1 with a far-away reset is the "queue behind the budget"
      // state: waitIfNeeded loops and sleeps instead of reserving.
      limiter.observe(
        'domain',
        new Headers({
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '1',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        }),
      );
      await limiter.flushPersisted();

      const controller = new AbortController();
      const waiting = limiter.waitIfNeeded('domain', controller.signal);
      setTimeout(() => controller.abort(), 50);
      await expect(waiting).rejects.toThrow(/cancelled/);
    } finally {
      await removeSandbox(sandbox);
    }
  }, 30_000);
});

// ───────────────────── 12. no server-initiated requests ─────────────────────

describe('A12 — the server never initiates a JSON-RPC request', () => {
  it('emits no frame carrying both an id and a method, on any stream', async () => {
    // "id AND method" is the JSON-RPC definition of a request, and this era has
    // no server→client request channel at all (SEP-2575). The invariant holds
    // by construction today; the test is what keeps it holding, and it covers
    // both stream kinds because they are produced by different code paths.
    const rig = await startRig('dual');
    const listen = await openModernStream(
      rig,
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [PENDING_ACTIONS_URI] } },
      { id: 'inv' },
    );
    await listen.next();

    const id = await makePending(rig);
    await listen.next();

    const call = await openModernStream(
      rig,
      'tools/call',
      { name: 'meta_confirm_action', arguments: { confirmation_id: id } },
      { name: 'meta_confirm_action', meta: { [META.logLevel]: 'debug' } },
    );
    await call.ended();

    const closing = rig.handle.close();
    await listen.ended();
    await closing;

    const everything = [...listen.received(), ...call.received()];
    expect(everything.length).toBeGreaterThan(3);
    for (const frame of everything) {
      const isRequest = frame.id !== undefined && frame.id !== null && frame.method !== undefined;
      expect(isRequest, JSON.stringify(frame)).toBe(false);
    }
    // The one notification the revision lets a server send for stream teardown
    // is `notifications/cancelled`, and only for that. We tear streams down
    // with the graceful result instead, so it must not appear at all.
    expect(everything.some((f) => f.method === 'notifications/cancelled')).toBe(false);
  }, 30_000);
});

// ───────────────────── 13. error-code allocation ────────────────────────────

describe('A13 — error codes stay inside the allocation policy', () => {
  /** The three codes revision 2026-07-28 defines in the reserved sub-range. */
  const SPEC_RESERVED = new Set([-32020, -32021, -32022]);

  it('emits no forbidden or unallocated code across the whole negative matrix', async () => {
    const rig = await startRig('dual');
    const codes = new Set<number>();
    const collect = (code: number | undefined): void => {
      if (code !== undefined) codes.add(code);
    };

    collect(errorOf(await modernPost(rig, 'no/such/method'))?.code);
    collect(errorOf(await modernPost(rig, 'resources/subscribe', { uri: PENDING_ACTIONS_URI }))?.code);
    collect(errorOf(await modernPost(rig, 'tools/list', {}, { meta: { [META.protocolVersion]: undefined } }))?.code);
    // `-32022` needs a modern-ONLY endpoint: under `dual` a request claiming an
    // unknown revision classifies as legacy and is answered by the 2025
    // session manager instead of ever reaching the version check.
    const modernOnly = await startRig('modern');
    collect(errorOf(await modernPost(modernOnly, 'tools/list', {}, { meta: { [META.protocolVersion]: '1900-01-01' } }))?.code);
    collect(errorOf(await legacyPost(modernOnly, initializeMessage()))?.code);
    collect(errorOf(await modernPost(rig, 'tools/list', {}, { headers: { 'Mcp-Method': null } }))?.code);
    collect(errorOf(await modernPost(rig, 'tools/list', {}, { headers: { 'MCP-Protocol-Version': null } }))?.code);
    collect(errorOf(await modernPost(rig, 'resources/read', { uri: 'avito://nope' }))?.code);
    collect(errorOf(await modernPost(rig, 'resources/read', { uri: 'avito://swaggers/nope' }))?.code);
    collect(errorOf(await modernPost(rig, 'tools/call', { name: 'no_such_tool', arguments: {} }, { name: 'no_such_tool' }))?.code);
    collect(errorOf(await modernPost(rig, 'prompts/get', { name: 'no_such_prompt' }, { name: 'no_such_prompt' }))?.code);

    // The matrix has to actually produce the interesting codes, or the loop
    // below would pass over an empty set.
    expect([...codes].sort((a, b) => a - b)).toEqual(
      expect.arrayContaining([-32602, -32601, -32020, -32022]),
    );
    for (const code of codes) {
      expect(code, `code ${code}`).not.toBe(-32002);
      expect(code, `code ${code}`).not.toBe(-32042);
      if (code <= -32020 && code >= -32099) {
        expect(SPEC_RESERVED.has(code), `code ${code} is in the spec-reserved range`).toBe(true);
      }
    }
  }, 30_000);

  it('allocates no code of its own inside -32768…-32000', () => {
    // The static half. Application errors in this codebase are in-band
    // `isError` content, not JSON-RPC codes — the only numeric codes in `src/`
    // are protocol answers, and every one of them must either be a code the
    // spec defines or a re-use of one the SDK itself already emits.
    //
    // The allowances are named explicitly rather than by range, so a NEW code
    // cannot slip in under a range check. Only base JSON-RPC and the three the
    // revision defines are allowed:
    //   • -32603 / -32602 / -32601 / -32700 — base JSON-RPC.
    //   • -32020 / -32021 / -32022 — defined by revision 2026-07-28.
    //
    // -32000 and -32001 are NOT listed here, and the two places that still
    // answer them are not exempt from this scan — they read the numbers from
    // `LEGACY_WIRE_ERROR_CODES` in `src/core/rpc-codes.ts`, the one module
    // skipped below because it is the module that DEFINES the boundaries and
    // therefore has to name them. That is deliberate: those two answers belong
    // to the frozen 2025 wire (no 2026 client can reach a session error), and
    // keeping them behind a named constant means a THIRD use of the sub-range
    // cannot appear without editing the file this scan skips.
    const ALLOWED = new Set([-32020, -32021, -32022, -32601, -32602, -32603, -32700]);
    const POLICY_MODULE = join(SRC_ROOT, 'core', 'rpc-codes.ts');
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      if (file === POLICY_MODULE) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const match of code.matchAll(/-3(?:2|3)\d{3}/g)) {
        const value = Number(match[0]);
        if (value > -32768 && value <= -32000 && !ALLOWED.has(value)) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ───────────────────── 14. resources/read ───────────────────────────────────

describe('A14 — resources/read', () => {
  it('answers an unknown URI with -32602 and data.uri', async () => {
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'resources/read', { uri: 'avito://does-not-exist' });
    const error = errorOf(answer)!;
    expect(error.code).toBe(-32602);
    expect(error.data).toMatchObject({ uri: 'avito://does-not-exist' });
  });

  it('answers a missing swagger with -32602 and data.uri, not -32603', async () => {
    // The regression this closes: the template read callback used to `throw new
    // Error(...)`, which the protocol turns into `-32603 Internal error` — a
    // client cannot tell "you asked for something that does not exist" from
    // "the server is broken", and the revision reassigned this case to -32602.
    const rig = await startRig('dual');
    const answer = await modernPost(rig, 'resources/read', { uri: 'avito://swaggers/nope' });
    const error = errorOf(answer)!;
    expect(error.code).toBe(-32602);
    expect(error.data).toMatchObject({ uri: 'avito://swaggers/nope' });
  });

  it('leaves the legacy answer for a missing swagger exactly where 1.3.x had it', async () => {
    // The other side of the era split. `-32603` for a client asking after a
    // resource that does not exist is a defect, and item 14 fixes it — on the
    // modern connection, which is where the requirement is scoped. Moving it on
    // the 2025 wire would be a client-visible change this stage promises not to
    // make, so it stays, and this test is what stops the fix from leaking.
    const rig = await startRig('dual');
    const init = await legacyPost(rig, initializeMessage());
    const sessionId = init.sessionId!;
    await legacyPost(
      rig,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      sessionId,
    );
    const answer = await legacyPost(
      rig,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'avito://swaggers/nope' },
      },
      sessionId,
    );
    const error = errorOf(answer)!;
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("Swagger 'nope' not found");
    expect(error.data).toBeUndefined();
  });

  it('answers a traversal attempt exactly like a plain miss', async () => {
    // No oracle: a distinct error would confirm which candidate paths the guard
    // found interesting.
    const rig = await startRig('dual');
    const miss = errorOf(await modernPost(rig, 'resources/read', { uri: 'avito://swaggers/zzz' }))!;
    const traversal = errorOf(
      await modernPost(rig, 'resources/read', { uri: 'avito://swaggers/..%2F..%2Fetc%2Fpasswd' }),
    )!;
    expect(traversal.code).toBe(miss.code);
    expect(Object.keys(traversal.data as object)).toEqual(Object.keys(miss.data as object));
  });

  it('returns non-empty contents for every resource it lists', async () => {
    const rig = await startRig('dual');
    const listed = resultOf(await modernPost(rig, 'resources/list'))!;
    const uris = (listed.resources as Array<{ uri: string }>).map((r) => r.uri);
    expect(uris.length).toBeGreaterThan(0);

    for (const uri of uris) {
      const read = resultOf(await modernPost(rig, 'resources/read', { uri }))!;
      const contents = read.contents as Array<{ text?: string; blob?: string }>;
      expect(contents, uri).toBeInstanceOf(Array);
      expect(contents.length, uri).toBeGreaterThan(0);
      for (const item of contents) {
        expect((item.text ?? item.blob ?? '').length, uri).toBeGreaterThan(0);
      }
    }
  }, 30_000);
});

// ───────────────────── 15. tool schemas ─────────────────────────────────────

describe('A15 — tool schemas are bounded and their dialect is documented', () => {
  interface SchemaStats {
    depth: number;
    subschemas: number;
    refs: string[];
  }

  function walk(node: unknown, depth = 1): SchemaStats {
    if (node === null || typeof node !== 'object') return { depth: 0, subschemas: 0, refs: [] };
    const stats: SchemaStats = { depth, subschemas: 1, refs: [] };
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string') stats.refs.push(record.$ref);
    for (const value of Object.values(record)) {
      if (value === null || typeof value !== 'object') continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        const sub = walk(child, depth + 1);
        stats.depth = Math.max(stats.depth, sub.depth);
        stats.subschemas += sub.subschemas;
        stats.refs.push(...sub.refs);
      }
    }
    return stats;
  }

  it('declares exactly the documented dialect, contains no network $ref, and stays bounded', async () => {
    const rig = await startRig('dual');
    const listed = resultOf(await modernPost(rig, 'tools/list'))!;
    const tools = listed.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>;
    expect(tools.length).toBeGreaterThan(100);

    // Bounds asserted as CONCRETE numbers rather than "some limit exists": a
    // self-adjusting bound would assert nothing. Both are pinned just above the
    // observed worst case (`delivery_create_parcel`, the deepest nested Avito
    // body in the catalogue: depth 17, 241 subschemas as of this commit), so
    // the numbers are a ratchet — a schema that grows materially deeper trips
    // this and gets looked at, rather than quietly shipping something a client
    // has to recurse through.
    const MAX_DEPTH = 20;
    const MAX_SUBSCHEMAS = 400;

    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (schema === undefined) continue;
        expect(schema.$schema, tool.name).toBe(TOOL_JSON_SCHEMA_DIALECT);
        const stats = walk(schema);
        expect(stats.depth, `${tool.name} depth`).toBeLessThanOrEqual(MAX_DEPTH);
        expect(stats.subschemas, `${tool.name} subschemas`).toBeLessThanOrEqual(MAX_SUBSCHEMAS);
        for (const ref of stats.refs) {
          // A network `$ref` would make schema resolution an outbound request
          // from the CLIENT to a host we named — an SSRF primitive handed out
          // in a tool descriptor.
          expect(/^[a-z][a-z0-9+.-]*:\/\//i.test(ref), `${tool.name} $ref ${ref}`).toBe(false);
        }
      }
    }
  }, 30_000);
});

// ───────────────────── 16. determinism ──────────────────────────────────────

describe('A16 — the primitive surface is deterministic', () => {
  it('serves the same order and the same set on every connection', async () => {
    // Two independent modern exchanges: the modern era builds a FRESH
    // 148-tool instance per request, so this is genuinely two constructions of
    // the registry, not one cached answer read twice.
    const rig = await startRig('dual');
    const names = async (): Promise<string[]> =>
      ((resultOf(await modernPost(rig, 'tools/list'))!.tools as Array<{ name: string }>) ?? []).map(
        (t) => t.name,
      );

    const first = await names();
    const second = await names();
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);

    for (const method of ['prompts/list', 'resources/list', 'resources/templates/list']) {
      const a = resultOf(await modernPost(rig, method))!;
      const b = resultOf(await modernPost(rig, method))!;
      expect(b, method).toEqual(a);
    }
  }, 30_000);

  it('exposes the same tool order on the legacy leg as on the modern one', async () => {
    // The set and the ORDER are a property of the registry, not of the era. A
    // divergence would mean one of the two wires is being built differently —
    // the same class of defect as the two construction sites.
    const rig = await startRig('dual');
    const modernNames = (
      resultOf(await modernPost(rig, 'tools/list'))!.tools as Array<{ name: string }>
    ).map((t) => t.name);

    const init = await legacyPost(rig, initializeMessage());
    const sessionId = init.sessionId!;
    await legacyPost(
      rig,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      sessionId,
    );
    const legacyNames = (
      (
        resultOf(
          await legacyPost(rig, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId),
        )!.tools as Array<{ name: string }>
      ) ?? []
    ).map((t) => t.name);

    expect(legacyNames).toEqual(modernNames);
  }, 30_000);
});

// ───────────────────── the listChanged decision ─────────────────────────────

describe('capabilities.listChanged — the decision M2 deferred to M3', () => {
  it('advertises false on the modern era and true on the legacy one', async () => {
    const rig = await startRig('dual');

    const discovered = resultOf(await modernPost(rig, 'server/discover'))!;
    expect(discovered.capabilities).toMatchObject({
      logging: {},
      resources: { subscribe: true, listChanged: false },
      prompts: { listChanged: false },
      tools: { listChanged: false },
    });

    // The 1.3.3 wire, untouched. `completions` is the SDK's own addition (a
    // completable prompt argument is registered), which is why this asserts the
    // advertised set rather than the literal.
    const init = resultOf(await legacyPost(rig, initializeMessage()))!;
    expect(init.capabilities).toEqual({
      logging: {},
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      tools: { listChanged: true },
      completions: {},
    });
  });

  it('keeps the declaration honest: nothing in src/ ever sends a list_changed', () => {
    // The justification for `false` is "we never emit these", and this is the
    // guard that makes it stay a fact. If a future feature starts emitting one,
    // this fails and forces the capability back to `true` in the same change —
    // rather than leaving a client that asked for the notification, was told
    // no, and now silently misses it.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const match of code.matchAll(
        /send(?:Tool|Prompt|Resource)ListChanged|notify\.(?:tools|prompts|resources)Changed/g,
      )) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('narrows a listen filter to exactly what is advertised', () => {
    // The unit half of the first test: the capability block is the INPUT to the
    // ack, so the two must be read together.
    expect(capabilitiesFor('modern')).toMatchObject({
      resources: { subscribe: true, listChanged: false },
      prompts: { listChanged: false },
      tools: { listChanged: false },
    });
    expect(capabilitiesFor('legacy')).toMatchObject({
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      tools: { listChanged: true },
    });
  });
});
