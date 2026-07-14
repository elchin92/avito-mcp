import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdempotencyStore } from '../src/core/idempotency.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { normalizeBbipResult } from '../src/domains/promotion.js';

const directories: string[] = [];

async function stateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'avito-mcp-1.3-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
  it('replays a completed destructive result in a second process store', async () => {
    const directory = await stateDir();
    const options = { stateDir: directory, namespace: 'account-a' };
    const first = new IdempotencyStore(60_000, 100, options);
    const second = new IdempotencyStore(60_000, 100, options);
    let executions = 0;

    const initial = await first.runExclusive('business-key', 'money_tool', 'same-args', async () => {
      executions += 1;
      return { content: [{ type: 'text', text: 'charged once' }] };
    });
    const replay = await second.runExclusive('business-key', 'money_tool', 'same-args', async () => {
      executions += 1;
      return { content: [{ type: 'text', text: 'must not run' }] };
    });

    expect(initial.replay).toBe(false);
    expect(replay.replay).toBe(true);
    expect(replay.entry.result.content[0]).toMatchObject({ text: 'charged once' });
    expect(executions).toBe(1);
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

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const shared = await second.getSharedStatus('stats');
      if (shared.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await second.getSharedStatus('stats')).toMatchObject([
      { domain: 'stats', limit: 10, remaining: 7 },
    ]);
  });
});
