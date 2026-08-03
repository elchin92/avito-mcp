/**
 * The cancel-after-dispatch race: "the caller hung up while a money mutation was
 * already on the wire — may the same idempotency key run again?"
 *
 * WHY THIS SUITE IS NOT MOCKED. The only assertion that settles the question is
 * a count taken at the RECEIVING end: how many mutations actually arrived. A
 * `vi.stubGlobal('fetch', …)` counts the calls the code intended to make, on a
 * path where no request ever became bytes — and the whole distinction under test
 * ("had it already left?") lives precisely in the part a fetch mock replaces. So
 * the server here is the real `startHttpServer`, the client is a real HTTP
 * client, the upstream is a real `node:http` server on loopback
 * (`test/support/fake-avito.ts`) that counts what reaches it, and the ledger is
 * the DURABLE one that `src/server.ts` builds in production — not the
 * process-local default of the rig, which is a different branch of
 * `runExclusive` altogether.
 *
 * The tool is `items_put_item_vas`: `risk: 'money'`, PUT, "charges money from
 * the balance; irreversible". Confirmation is off (a supported production
 * setting, `AVITO_MCP_CONFIRMATION_MODE=off`) so the money call reaches the
 * upstream on the first request instead of parking as a pending action.
 *
 * api.avito.ru is never contacted.
 *
 * THE RULE BEING TESTED, in one line: fail closed only where the outcome is
 * genuinely unknown. A cancellation that raced a request already on the wire
 * leaves the outcome unknown and must NOT free the key; a cancellation that
 * landed before anything left changed nothing upstream and MUST free it, or
 * every cancelled agent is stranded on a key it can never use again.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { startFakeAvito, type FakeAvito } from './support/fake-avito.js';
import { createSandbox, removeSandbox } from './support/sandbox.js';
import {
  closeRigs,
  initializeMessage,
  legacyPost,
  makeConfig,
  META,
  MODERN_REVISION,
  modernPost,
  openModernStream,
  resultOf,
  startRig,
  type Rig,
} from './support/modern-rig.js';
import { AvitoClient } from '../src/core/client.js';
import {
  IdempotencyStore,
  fingerprintIdempotencyKey,
} from '../src/core/idempotency.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { runtimeNamespace, safeStatePart } from '../src/core/runtime-state.js';
import type { Config } from '../src/config.js';

const TOOL = 'items_put_item_vas';
const ARGS = { item_id: 987654321, vas_id: 'highlight' as const };
/** The rate-limiter bucket `AvitoClient.request` derives for that tool. */
const RATE_KEY = 'core:PUT:/core/v1/accounts/{user_id}/items/{item_id}/vas';

interface Case {
  rig: Rig;
  avito: FakeAvito;
  store: IdempotencyStore;
  stateDir: string;
  namespace: string;
}

const openCases: Array<{ avito: FakeAvito; sandbox: string }> = [];

afterEach(async () => {
  await closeRigs();
  for (const { avito, sandbox } of openCases.splice(0)) {
    await avito.close();
    await removeSandbox(sandbox);
  }
});

async function startCase(
  options: { durable?: boolean; ttlMs?: number; maxEntries?: number } = {},
): Promise<Case> {
  const { durable = true, ttlMs = 3_600_000, maxEntries = 10_000 } = options;
  const avito = await startFakeAvito();
  const stateDir = await createSandbox('idem-cancel');
  openCases.push({ avito, sandbox: stateDir });

  let namespace = '';
  let store!: IdempotencyStore;
  const rig = await startRig(
    'dual',
    (cfg: Config) => {
      (cfg as { baseUrl: string }).baseUrl = avito.baseUrl;
      cfg.confirmationMode = 'off';
      (cfg as { runtimeStateDir?: string }).runtimeStateDir = stateDir;
      (cfg as { tokenFile: string }).tokenFile = join(stateDir, 'token.json');
      namespace = runtimeNamespace(cfg);
    },
    (ctx) => {
      store = durable
        ? new IdempotencyStore(ttlMs, maxEntries, { stateDir, namespace })
        : new IdempotencyStore(ttlMs, maxEntries);
      ctx.idempotencyStore = store;
      ctx.pendingStore = new PendingActionStore(900_000, 1000, { stateDir, namespace });
    },
  );

  return { rig, avito, store, stateDir, namespace };
}

/** The durable ledger record for (tool, key) — the lease this suite is about. */
function ledgerPath(c: Case, key: string): string {
  return join(
    c.stateDir,
    c.namespace,
    'idempotency',
    safeStatePart(TOOL),
    `${fingerprintIdempotencyKey(key)}.json`,
  );
}

interface LedgerRecord {
  state?: string;
  expiresAt?: number;
  heldAt?: number;
  heldReason?: string;
}

async function ledgerRecord(c: Case, key: string): Promise<LedgerRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(ledgerPath(c, key), 'utf8')) as LedgerRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ledgerState(c: Case, key: string): Promise<string> {
  return (await ledgerRecord(c, key))?.state ?? 'ABSENT';
}

/** A one-shot tools/call that reads the whole answer. */
async function call(rig: Rig, key: string): Promise<Record<string, unknown>> {
  const answer = await modernPost(
    rig,
    'tools/call',
    { name: TOOL, arguments: { ...ARGS, idempotencyKey: key } },
    { name: TOOL },
  );
  const result = resultOf(answer);
  if (!result) throw new Error(`tools/call answered no result: ${JSON.stringify(answer.body)}`);
  return result;
}

function errorEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return (structured.error ?? {}) as Record<string, unknown>;
}

/**
 * Starts a money call, waits until it has actually reached the upstream, then
 * closes the response stream — the 2026-07-28 cancellation signal.
 *
 * The declared log level is load-bearing FIXTURE, not decoration: with
 * `responseMode: 'auto'` the response headers are not written until the handler
 * emits something, so without a mid-call notification the opening `fetch` would
 * block until the (deliberately hung) upstream call finished, i.e. forever.
 */
async function cancelAfterDispatch(c: Case, key: string): Promise<void> {
  c.avito.setMode('hang');
  const before = c.avito.mutations.length;
  const stream = await openModernStream(
    c.rig,
    'tools/call',
    { name: TOOL, arguments: { ...ARGS, idempotencyKey: key } },
    { name: TOOL, meta: { [META.logLevel]: 'debug' } },
  );
  await vi.waitFor(() => expect(c.avito.mutations.length).toBe(before + 1), { timeout: 15_000 });
  stream.abort();
  await stream.ended();
}

/**
 * Parks a call in the rate limiter: `remaining: 1` with a far-away reset is the
 * "queue behind the shared budget" state, and it is the one place in this
 * codebase where the caller's signal is honoured BEFORE anything is dispatched.
 */
async function parkTheBudget(c: Case): Promise<string> {
  const path = join(c.stateDir, c.namespace, 'rate-limits', `${safeStatePart(RATE_KEY)}.json`);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const nowSec = Math.floor(Date.now() / 1000);
  await fs.writeFile(
    path,
    JSON.stringify({
      domain: RATE_KEY,
      limit: 10,
      remaining: 1,
      resetAt: nowSec + 600,
      observedAt: nowSec,
    }),
    { mode: 0o600 },
  );
  return path;
}

/**
 * A tools/call fired WITHOUT awaiting the response: a call parked in the rate
 * limiter emits nothing, so the headers never arrive and `await fetch(...)`
 * would block for the whole reset window.
 */
function fireAndHangUp(c: Case, key: string): { abort: () => void; settled: Promise<unknown> } {
  const controller = new AbortController();
  const settled = fetch(`${c.rig.base}/mcp`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: c.rig.host,
      'MCP-Protocol-Version': MODERN_REVISION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': TOOL,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: TOOL,
        arguments: { ...ARGS, idempotencyKey: key },
        _meta: {
          [META.protocolVersion]: MODERN_REVISION,
          [META.clientCapabilities]: {},
          [META.clientInfo]: { name: 'cancel-race', version: '1.0.0' },
        },
      },
    }),
  }).catch(() => undefined);
  return { abort: () => controller.abort(), settled };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The ledger size once it has stopped moving.
 *
 * A plain `waitFor(size === 1)` would be satisfied by the RESERVATION that
 * exists while the call is still in flight, and would therefore pass whether or
 * not a hold was ever recorded. What distinguishes the two is what is left
 * AFTER the cancelled call has finished unwinding, so this waits for the count
 * to stand still instead of waiting for a value it was told to expect.
 */
async function settledLedgerSize(c: Case): Promise<number> {
  const deadline = Date.now() + 15_000;
  let last = -1;
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    const size = c.store.size();
    if (size !== last) {
      last = size;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= 400) {
      return size;
    }
    await sleep(50);
  }
  return last;
}

// ───────────────── 1. cancelled AFTER the request left ─────────────────

describe('a cancellation that raced an already-dispatched money call', () => {
  it('refuses the same idempotency key instead of spending the money twice', async () => {
    const c = await startCase();
    const key = 'cancel-after-dispatch-0001';

    await cancelAfterDispatch(c, key);
    expect(c.avito.mutations.length).toBe(1);

    // The lease is HELD, not released: the outcome of that one mutation is
    // unknown, and the record says so in a form the next call can read.
    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('indeterminate'), {
      timeout: 15_000,
    });

    // The retry a real agent makes: same key, same args — and a healthy upstream,
    // so that anything that DID go out would be counted.
    c.avito.setMode('ok');
    c.avito.releaseHung();
    const retry = await call(c.rig, key);

    expect(c.avito.mutations.length).toBe(1);
    expect(retry.isError).toBe(true);
    expect(errorEnvelope(retry).type).toBe('IDEMPOTENCY_HELD');
  }, 60_000);

  it('tells the agent WHY, rather than reporting an internal error', async () => {
    const c = await startCase();
    const key = 'cancel-after-dispatch-0002';

    await cancelAfterDispatch(c, key);
    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('indeterminate'), {
      timeout: 15_000,
    });

    const retry = await call(c.rig, key);
    const envelope = errorEnvelope(retry);
    expect(envelope.type).toBe('IDEMPOTENCY_HELD');
    expect(envelope.code).toBe('IDEMPOTENCY_HELD/cancelled_after_dispatch');
    expect(envelope.retryable).toBe(false);
    const text = (retry.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('AFTER its request had already been sent');
  }, 60_000);
});

// ───────────────── 2 & 3. cancelled BEFORE the request left ─────────────────

describe('a cancellation that landed before anything was dispatched', () => {
  it('frees the reservation, and the retry with the same key runs normally', async () => {
    const c = await startCase();
    const key = 'cancel-before-dispatch-0001';
    const ratePath = await parkTheBudget(c);

    const inflight = fireAndHangUp(c, key);
    // Parked: the reservation exists, the upstream has seen nothing.
    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('in_flight'), {
      timeout: 15_000,
    });
    expect(c.avito.mutations.length).toBe(0);

    inflight.abort();
    await inflight.settled;

    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('ABSENT'), {
      timeout: 15_000,
    });

    // Let the budget through and retry exactly as an agent would.
    await fs.rm(ratePath, { force: true });
    const retry = await call(c.rig, key);

    expect(c.avito.mutations.length).toBe(1);
    expect(retry.isError).toBeFalsy();
    expect((retry.structuredContent as Record<string, unknown>).idempotent_replay).toBeUndefined();
    expect(await ledgerState(c, key)).toBe('completed');
  }, 60_000);

  it('interrupting the rate-limiter wait leaves no hold and no burnt slot', async () => {
    const c = await startCase();
    const key = 'cancel-in-rate-limiter-0001';
    const ratePath = await parkTheBudget(c);

    const inflight = fireAndHangUp(c, key);
    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('in_flight'), {
      timeout: 15_000,
    });

    inflight.abort();
    await inflight.settled;

    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('ABSENT'), {
      timeout: 15_000,
    });
    // Nothing was held: a wait that never reached the wire is not an unknown outcome.
    expect(c.store.size()).toBe(0);
    // And the slot the call queued for was never taken from the shared budget.
    const snapshot = JSON.parse(await fs.readFile(ratePath, 'utf8')) as { remaining?: number };
    expect(snapshot.remaining).toBe(1);
    expect(c.avito.mutations.length).toBe(0);
  }, 60_000);
});

// ───────────────── 4. the hold is bounded, swept, and liftable ─────────────────

describe('a held reservation', () => {
  it('expires on its own, and the ledger quota it occupied comes back', async () => {
    // Process-local ledger: `maxEntries` is enforced on this branch, so the
    // quota claim is testable rather than asserted by inspection.
    const c = await startCase({ durable: false, ttlMs: 1_500, maxEntries: 1 });
    const heldKey = 'hold-expiry-held-0001';
    const otherKey = 'hold-expiry-other-0001';

    await cancelAfterDispatch(c, heldKey);
    // One slot, and it belongs to the hold: the cancelled call is long gone.
    expect(await settledLedgerSize(c)).toBe(1);

    c.avito.setMode('ok');
    c.avito.releaseHung();

    // Honest accounting: while it is in force, the hold occupies its slot.
    const squeezed = await call(c.rig, otherKey);
    expect(squeezed.isError).toBe(true);
    expect((squeezed.content as Array<{ text?: string }>)[0]?.text).toContain('capacity reached');
    expect(c.avito.mutations.length).toBe(1);

    // …but only until it expires. This is the difference between a hold and the
    // permanent `in_flight` reservation a hard process stop leaves behind.
    await sleep(1_800);
    expect(c.store.size()).toBe(0);

    const afterExpiry = await call(c.rig, otherKey);
    expect(afterExpiry.isError).toBeFalsy();
    expect(c.avito.mutations.length).toBe(2);
  }, 60_000);

  it('is swept from the durable ledger once expired, freeing the key', async () => {
    const c = await startCase({ durable: true, ttlMs: 1_500 });
    const key = 'durable-hold-expiry-0001';

    await cancelAfterDispatch(c, key);
    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('indeterminate'), {
      timeout: 15_000,
    });
    const record = await ledgerRecord(c, key);
    expect(typeof record?.expiresAt).toBe('number');
    expect(typeof record?.heldReason).toBe('string');

    c.avito.setMode('ok');
    c.avito.releaseHung();
    await sleep(1_800);

    const afterExpiry = await call(c.rig, key);
    expect(afterExpiry.isError).toBeFalsy();
    expect(c.avito.mutations.length).toBe(2);
    expect(await ledgerState(c, key)).toBe('completed');
  }, 60_000);

  it('can be lifted by an operator once the operation has been reconciled', async () => {
    const c = await startCase();
    const key = 'operator-release-0001';

    await cancelAfterDispatch(c, key);
    await vi.waitFor(async () => expect(await ledgerState(c, key)).toBe('indeterminate'), {
      timeout: 15_000,
    });
    expect(c.store.size()).toBe(1);

    expect(await c.store.releaseHold(key, TOOL)).toBe(true);
    expect(await ledgerState(c, key)).toBe('ABSENT');
    expect(c.store.size()).toBe(0);
    // Lifting a hold that is not there is a no-op, not an error.
    expect(await c.store.releaseHold(key, TOOL)).toBe(false);

    c.avito.setMode('ok');
    c.avito.releaseHung();
    const afterRelease = await call(c.rig, key);
    expect(afterRelease.isError).toBeFalsy();
    expect(c.avito.mutations.length).toBe(2);
  }, 60_000);
});

// ───────────────── the latch itself ─────────────────

describe('the dispatch latch', () => {
  it('fires when the request reaches the upstream, and only then', async () => {
    const avito = await startFakeAvito();
    const sandbox = await createSandbox('dispatch-latch');
    openCases.push({ avito, sandbox });
    const cfg = makeConfig('dual');
    (cfg as { baseUrl: string }).baseUrl = avito.baseUrl;
    (cfg as { runtimeStateDir?: string }).runtimeStateDir = sandbox;
    (cfg as { tokenFile: string }).tokenFile = join(sandbox, 'token.json');
    const client = new AvitoClient(cfg);

    let dispatched = false;
    const response = await client.request({
      method: 'PUT',
      path: '/core/v1/accounts/{user_id}/items/{item_id}/vas',
      pathParams: { user_id: 12345678, item_id: 987654321 },
      body: { vas_id: 'highlight' },
      domain: 'core',
      onDispatch: () => {
        dispatched = true;
      },
    });

    expect(response.status).toBe(200);
    expect(dispatched).toBe(true);
    expect(avito.mutations.length).toBe(1);
  }, 30_000);

  it('never fires for a call cancelled while it was queued behind the rate limiter', async () => {
    const avito = await startFakeAvito();
    const sandbox = await createSandbox('dispatch-latch-parked');
    openCases.push({ avito, sandbox });
    const cfg = makeConfig('dual');
    (cfg as { baseUrl: string }).baseUrl = avito.baseUrl;
    (cfg as { runtimeStateDir?: string }).runtimeStateDir = sandbox;
    (cfg as { tokenFile: string }).tokenFile = join(sandbox, 'token.json');
    const namespace = runtimeNamespace(cfg);

    const ratePath = join(sandbox, namespace, 'rate-limits', `${safeStatePart(RATE_KEY)}.json`);
    await fs.mkdir(dirname(ratePath), { recursive: true, mode: 0o700 });
    const nowSec = Math.floor(Date.now() / 1000);
    await fs.writeFile(
      ratePath,
      JSON.stringify({
        domain: RATE_KEY,
        limit: 10,
        remaining: 1,
        resetAt: nowSec + 600,
        observedAt: nowSec,
      }),
      { mode: 0o600 },
    );

    const client = new AvitoClient(cfg);
    const controller = new AbortController();
    let dispatched = false;
    const inflight = client
      .request({
        method: 'PUT',
        path: '/core/v1/accounts/{user_id}/items/{item_id}/vas',
        pathParams: { user_id: 12345678, item_id: 987654321 },
        body: { vas_id: 'highlight' },
        domain: 'core',
        signal: controller.signal,
        onDispatch: () => {
          dispatched = true;
        },
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );

    await sleep(300);
    expect(dispatched).toBe(false);
    controller.abort();
    expect(await inflight).toBe('rejected');
    expect(dispatched).toBe(false);
    expect(avito.mutations.length).toBe(0);
  }, 30_000);
});

// ───────────── the same race on the 2025-11-25 wire ─────────────

/**
 * The blind spot this block exists to close.
 *
 * Everything above drives revision 2026-07-28, where a cancellation is the peer
 * closing the response stream. That framing made it easy to read the hold as a
 * property of the new revision — the changelog, `docs/safety.md`, both READMEs
 * and ADR 0008 all did, and all of them were wrong.
 *
 * `notifications/cancelled` is defined on revision 2025-11-25 too, the handler
 * that turns it into `abort()` is registered in the SDK's base `Protocol`
 * constructor before any era is known, and `src/core/tool-factory.ts` reads
 * `extra.mcpReq.signal` for every tool call without consulting
 * `ToolContext.era`. So the whole race — abort, dispatched mutation, held key —
 * reaches a 2025 client on the DEFAULT posture.
 *
 * Nothing else in the suite can see that. The legacy wire baseline
 * (`test/support/legacy-wire-bench.ts`) replays recorded request/response
 * PAIRS; a cancellation is an unsolicited notification that is never answered,
 * so it has no pair to record and the baseline stays green whatever this code
 * does. The assertion has to be a live one, which is what follows.
 */

/** Opens a real 2025-11-25 session and returns its id. */
async function legacySession(c: Case): Promise<string> {
  const init = await legacyPost(c.rig, initializeMessage());
  const sessionId = init.sessionId;
  if (!sessionId) throw new Error(`initialize returned no session id: ${JSON.stringify(init.body)}`);
  await legacyPost(c.rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  return sessionId;
}

/** A one-shot 2025-11-25 `tools/call` that reads the whole answer. */
async function legacyCall(
  c: Case,
  sessionId: string,
  key: string,
  id: number,
): Promise<Record<string, unknown>> {
  const answer = await legacyPost(
    c.rig,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: TOOL, arguments: { ...ARGS, idempotencyKey: key } },
    },
    sessionId,
  );
  const result = resultOf(answer);
  if (!result) throw new Error(`tools/call answered no result: ${JSON.stringify(answer.body)}`);
  return result;
}

/**
 * Fires a money `tools/call` on the 2025-11-25 wire without awaiting it, waits
 * until the mutation has actually reached the upstream, then cancels it with
 * `notifications/cancelled` — the only cancellation channel that revision has.
 *
 * The call is not awaited because the upstream is deliberately hung and a
 * cancelled request is never answered: awaiting either half would block for the
 * whole request deadline. What is awaited instead is the observable the test is
 * about — the mutation counter at the receiving end.
 */
async function legacyCancelAfterDispatch(
  c: Case,
  sessionId: string,
  key: string,
  requestId: number,
): Promise<() => void> {
  c.avito.setMode('hang');
  const before = c.avito.mutations.length;
  const controller = new AbortController();
  void fetch(`${c.rig.base}/mcp`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: c.rig.host,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: TOOL, arguments: { ...ARGS, idempotencyKey: key } },
    }),
  }).then(
    (res) => res.text().catch(() => undefined),
    () => undefined,
  );

  await vi.waitFor(() => expect(c.avito.mutations.length).toBe(before + 1), { timeout: 15_000 });

  // The 2025-11-25 cancellation: a notification naming the open request id.
  // Per the specification a cancelled request is never answered, so the SSE
  // stream it was opened on is not expected to carry anything and is not waited
  // on — the returned handle closes it once the assertions are done.
  const ack = await legacyPost(
    c.rig,
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId, reason: 'the caller hung up' },
    },
    sessionId,
  );
  expect(ack.status).toBe(202);
  return () => controller.abort();
}

describe('a cancellation on the LEGACY 2025-11-25 wire', () => {
  it('holds the key when it raced a dispatched money call, and the retry is refused', async () => {
    const c = await startCase();
    const sessionId = await legacySession(c);
    const idem = 'legacy-cancel-after-dispatch-0001';

    const hangUp = await legacyCancelAfterDispatch(c, sessionId, idem, 4242);
    expect(c.avito.mutations.length).toBe(1);

    // The cancellation reached the tool layer on a wire that, in 1.3.3, ignored
    // it entirely: the key is HELD rather than freed.
    await vi.waitFor(async () => expect(await ledgerState(c, idem)).toBe('indeterminate'), {
      timeout: 15_000,
    });

    // The retry a real 2025 agent makes: same session, same key, same args, and
    // a healthy upstream so that anything that DID go out would be counted.
    c.avito.setMode('ok');
    c.avito.releaseHung();
    hangUp();

    const retry = await legacyCall(c, sessionId, idem, 7);

    // The money was spent exactly once.
    expect(c.avito.mutations.length).toBe(1);
    expect(retry.isError).toBe(true);
    const envelope = errorEnvelope(retry);
    expect(envelope.type).toBe('IDEMPOTENCY_HELD');
    expect(envelope.code).toBe('IDEMPOTENCY_HELD/cancelled_after_dispatch');
    expect(envelope.retryable).toBe(false);
    const text = (retry.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('AFTER its request had already been sent');
  }, 60_000);

  it('interrupts the outgoing call at all, which 1.3.3 did not', async () => {
    // The premise of the test above, isolated: on the 2025-11-25 wire the
    // notification actually aborts the request. If it did not, the call would
    // run to completion and the key would end up `completed`, not held — the
    // whole race would be unreachable and the doc claim would have been right.
    const c = await startCase();
    const sessionId = await legacySession(c);
    const idem = 'legacy-cancel-aborts-0001';

    const hangUp = await legacyCancelAfterDispatch(c, sessionId, idem, 909);

    await vi.waitFor(async () => expect(await ledgerState(c, idem)).toBe('indeterminate'), {
      timeout: 15_000,
    });
    const record = await ledgerRecord(c, idem);
    // `heldReason` is the diagnosis the process recorded, and on this path it can
    // only have come from the abort: an unknown outcome, produced by a cancelled
    // transport call rather than by any answer Avito gave.
    expect(record?.heldReason).toContain('Upstream outcome unknown');
    expect(record?.heldReason).toContain('Request cancelled');
    expect(typeof record?.expiresAt).toBe('number');

    c.avito.setMode('ok');
    c.avito.releaseHung();
    hangUp();

    // And it is the same bounded hold as on the modern wire: an operator can
    // lift it, after which the key works again.
    expect(await c.store.releaseHold(idem, TOOL)).toBe(true);
    const afterRelease = await legacyCall(c, sessionId, idem, 11);
    expect(afterRelease.isError).toBeFalsy();
    expect(c.avito.mutations.length).toBe(2);
  }, 60_000);
});
