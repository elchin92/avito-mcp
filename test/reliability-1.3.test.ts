import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdempotencyStore } from '../src/core/idempotency.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { syncDirectory } from '../src/core/runtime-state.js';
import { normalizeBbipResult } from '../src/domains/promotion.js';
import { createSandbox, removeSandbox } from './support/sandbox.js';

const directories: string[] = [];

/**
 * Every store below publishes its lease with mkdir and then has to recognise that
 * directory again. os.tmpdir() is tmpfs on most hosts and never hands a freed inode
 * back, so those ownership checks are untestable there; the repo filesystem is the one
 * a deployment actually keeps its state on. Same reasoning as test/file-lock.test.ts.
 */
async function stateDir(): Promise<string> {
  const path = await createSandbox('reliability-1.3');
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => removeSandbox(path)));
});

describe('BBIP item-level outcome', () => {
  it('does not report success when a processed order contains an item error', () => {
    const result = normalizeBbipResult({
      orderId: 'order-1',
      status: 'processed',
      totalPrice: 5000,
      items: [
        { itemId: '1', status: 'processed', price: 5000 },
        { itemId: '2', status: 'error', errorReason: 'Есть конфликтующая услуга' },
      ],
    });

    expect(result.outcome).toBe('partial');
    expect(result.accepted_item_ids).toEqual(['1']);
    expect(result.failed_item_ids).toEqual(['2']);
    expect(result.items).toMatchObject([
      { error_code: null },
      { error_code: 'PROMOTION_CONFLICT' },
    ]);
  });
});

describe('1.3 durable reliability state', () => {
  it('tolerates platforms that do not support directory fsync', async () => {
    const open = vi.spyOn(fs, 'open');
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR']) {
      open.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(syncDirectory('/unused')).resolves.toBeUndefined();
    }

    open.mockRejectedValueOnce(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
    await expect(syncDirectory('/unused')).rejects.toMatchObject({ code: 'EIO' });
  });

  it('replays a completed destructive result in a second process store', async () => {
    const directory = await stateDir();
    const options = { stateDir: directory, namespace: 'account-a' };
    const first = new IdempotencyStore(60_000, 100, options);
    const second = new IdempotencyStore(60_000, 100, options);
    let executions = 0;

    const initial = await first.runExclusive(
      'business-key',
      'money_tool',
      'same-args',
      async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'charged once' }] };
      },
    );
    const replay = await second.runExclusive(
      'business-key',
      'money_tool',
      'same-args',
      async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'must not run' }] };
      },
    );

    expect(initial.replay).toBe(false);
    expect(replay.replay).toBe(true);
    expect(replay.entry.result.content[0]).toMatchObject({ text: 'charged once' });
    expect(executions).toBe(1);
  });

  it('retains an expired final result while its durable claim is unreconciled', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const directory = await stateDir();
    const options = { stateDir: directory, namespace: 'account-a' };
    const pendingCreator = new PendingActionStore(60_000, 100, options);
    const pending = await pendingCreator.createPersistent({
      toolName: 'money_tool',
      risk: 'money',
      summary: 'test',
      args: {},
      idempotencyKey: 'business-key',
      argsHash: 'same-args',
      execute: async () => ({ content: [] }),
    });
    const claimingStore = new PendingActionStore(60_000, 100, options);
    claimingStore.registerExecutor('money_tool', async () => ({ content: [] }));
    expect(await claimingStore.takePersistent(pending.id)).toBeDefined();

    const first = new IdempotencyStore(10, 100, options);
    await first.rememberPersistent('business-key', 'money_tool', 'same-args', {
      content: [{ type: 'text', text: 'charged once' }],
      structuredContent: { ok: true },
    });
    now = 1_011;
    const second = new IdempotencyStore(10, 100, options);
    let executions = 0;
    const replay = await second.runExclusive(
      'business-key',
      'money_tool',
      'same-args',
      async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'must not run' }] };
      },
      {
        retainExpiredPersistent: () =>
          pendingCreator.hasClaimedPersistent('money_tool', 'business-key', 'same-args'),
      },
    );

    expect(replay.replay).toBe(true);
    expect(replay.entry.result.content[0]).toMatchObject({ text: 'charged once' });
    expect(executions).toBe(0);
  });

  it('rehydrates and atomically claims a pending action in another store', async () => {
    const directory = await stateDir();
    const options = { stateDir: directory, namespace: 'account-a' };
    const first = new PendingActionStore(60_000, 100, options);
    const second = new PendingActionStore(60_000, 100, options);
    second.registerExecutor('money_tool', async (args) => ({
      content: [{ type: 'text', text: `executed:${String(args.itemId)}` }],
    }));

    const created = await first.createPersistent({
      toolName: 'money_tool',
      risk: 'money',
      summary: 'test',
      args: { itemId: '8028191653' },
      initiator: 'oauth:initiator',
      execute: async () => ({ content: [{ type: 'text', text: 'local' }] }),
    });
    const recovered = await second.getPersistent(created.id);
    const claimed = await second.takePersistent(created.id);

    expect(recovered?.initiator).toBe('oauth:initiator');
    expect(await claimed?.execute()).toMatchObject({
      content: [{ type: 'text', text: 'executed:8028191653' }],
    });
    expect(await first.takePersistent(created.id)).toBeUndefined();
  });

  it('shares observed rate-limit state by account namespace', async () => {
    const directory = await stateDir();
    const options = { stateDir: directory, namespace: 'account-a' };
    const first = new RateLimiter(options);
    const second = new RateLimiter(options);
    const headers = new Headers({
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '7',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    });
    first.observe('stats', headers);
    // observe() is synchronous and only queues the write, so polling until the file
    // appears proves nothing beyond the rename — the lease around it is still held, and
    // releasing it renames the lease to a `<file>.lock.transitioned-<id>` sibling inside
    // this very directory. A teardown rm() racing that sibling dies on ENOTEMPTY.
    // flushPersisted() is the drain the server runs on shutdown: it returns once the
    // snapshot is durable and the lease is gone, which is what the assertion needs.
    await first.flushPersisted();

    expect(await second.getSharedStatus('stats')).toMatchObject([
      { domain: 'stats', limit: 10, remaining: 7 },
    ]);
  });
});
