/**
 * Tests for the idempotency store (v0.7.0). Isolated unit tests without MCP.
 */
import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  IdempotencyStore,
  IdempotencyConflictError,
  IdempotencyLimitError,
  hashArgs,
} from '../src/core/idempotency.js';

function resultOf(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('idempotency', () => {
  it('hashArgs is stable regardless of key order', () => {
    const a = hashArgs({ x: 1, y: 'a', z: [1, 2, 3] });
    const b = hashArgs({ z: [1, 2, 3], y: 'a', x: 1 });
    expect(a).toBe(b);
  });

  it('hashArgs differs for different values', () => {
    const a = hashArgs({ x: 1 });
    const b = hashArgs({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('store: first lookup misses, remember caches', () => {
    const store = new IdempotencyStore(60_000);
    const h = hashArgs({ a: 1 });
    expect(store.lookup('key1', 'tool', h)).toBeUndefined();
    store.remember('key1', 'tool', h, resultOf('done'));
    const cached = store.lookup('key1', 'tool', h);
    expect(cached).toBeDefined();
    expect((cached!.result.content[0] as { text: string }).text).toBe('done');
  });

  it('store: same key with different args throws IdempotencyConflictError', () => {
    const store = new IdempotencyStore(60_000);
    store.remember('key1', 'tool', hashArgs({ a: 1 }), resultOf('a=1'));
    expect(() => store.lookup('key1', 'tool', hashArgs({ a: 2 }))).toThrow(
      IdempotencyConflictError,
    );
  });

  it('store: same key on different tool — independent slot', () => {
    const store = new IdempotencyStore(60_000);
    store.remember('key1', 'toolA', hashArgs({ a: 1 }), resultOf('A'));
    // toolB never used this key — must NOT inherit toolA's record.
    expect(store.lookup('key1', 'toolB', hashArgs({ a: 1 }))).toBeUndefined();
  });

  it('fingerprints long keys instead of retaining them in the ledger or errors', () => {
    const store = new IdempotencyStore(60_000);
    const longKey = 'long-key-'.repeat(1024);
    const hash = hashArgs({ a: 1 });
    store.remember(longKey, 'tool', hash, resultOf('done'));
    expect(store.lookup(longKey, 'tool', hash)).toBeDefined();
    expect(store.list()[0]?.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => store.lookup(longKey, 'tool', hashArgs({ a: 2 }))).toThrow(
      IdempotencyConflictError,
    );
    try {
      store.lookup(longKey, 'tool', hashArgs({ a: 2 }));
    } catch (error) {
      expect(String(error)).not.toContain(longKey);
    }
  });

  it('store: expires entries by TTL', async () => {
    const store = new IdempotencyStore(50); // 50ms
    const h = hashArgs({ a: 1 });
    store.remember('k', 't', h, resultOf('x'));
    expect(store.lookup('k', 't', h)).toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(store.lookup('k', 't', h)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('list() returns shallow info without result', () => {
    const store = new IdempotencyStore(60_000);
    store.remember('k', 't', hashArgs({ a: 1 }), resultOf('x'));
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'k', toolName: 't' });
    expect((list[0] as unknown as { result?: unknown }).result).toBeUndefined();
  });

  it('runExclusive coalesces concurrent calls with the same key and args', async () => {
    const store = new IdempotencyStore(60_000);
    const h = hashArgs({ a: 1 });
    let executions = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.runExclusive('k', 't', h, async () => {
      executions += 1;
      await barrier;
      return resultOf('done');
    });
    const second = store.runExclusive('k', 't', h, async () => {
      executions += 1;
      return resultOf('duplicate');
    });

    expect(executions).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(executions).toBe(1);
    expect(a.replay).toBe(false);
    expect(b.replay).toBe(true);
    expect((a.entry.result.content[0] as { text: string }).text).toBe('done');
    expect((b.entry.result.content[0] as { text: string }).text).toBe('done');
  });

  it('does not expire an active reservation even when execution exceeds the TTL', async () => {
    const store = new IdempotencyStore(5);
    const h = hashArgs({ a: 1 });
    let executions = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.runExclusive('slow', 'tool', h, async () => {
      executions += 1;
      await barrier;
      return resultOf('first');
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = store.runExclusive('slow', 'tool', h, async () => {
      executions += 1;
      return resultOf('duplicate');
    });
    expect(executions).toBe(1);
    expect(store.size()).toBe(1);

    release();
    const [a, b] = await Promise.all([first, second]);
    expect(executions).toBe(1);
    expect(a.replay).toBe(false);
    expect(b.replay).toBe(true);
  });

  it('retains an expired entry while its external lifecycle remains active', async () => {
    const store = new IdempotencyStore(5);
    const h = hashArgs({ a: 1 });
    let active = true;
    store.remember('pending', 'tool', h, resultOf('pending'), {
      retainExpired: () => active,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.lookup('pending', 'tool', h)).toBeDefined();
    active = false;
    expect(store.lookup('pending', 'tool', h)).toBeUndefined();
  });

  it('checks completed-entry capacity before invoking a new mutation', async () => {
    const store = new IdempotencyStore(60_000, 1);
    const firstHash = hashArgs({ a: 1 });
    store.remember('first', 'tool', firstHash, resultOf('preserved'));
    let executed = false;

    await expect(
      store.runExclusive('second', 'tool', hashArgs({ a: 2 }), async () => {
        executed = true;
        return resultOf('must-not-run');
      }),
    ).rejects.toBeInstanceOf(IdempotencyLimitError);
    expect(executed).toBe(false);
    expect(store.lookup('first', 'tool', firstHash)).toBeDefined();
    expect(store.size()).toBe(1);
  });

  it('counts active reservations toward the hard capacity bound', async () => {
    const store = new IdempotencyStore(60_000, 1);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.runExclusive('first', 'tool', hashArgs({ a: 1 }), async () => {
      await barrier;
      return resultOf('done');
    });
    let secondExecuted = false;

    await expect(
      store.runExclusive('second', 'tool', hashArgs({ a: 2 }), async () => {
        secondExecuted = true;
        return resultOf('must-not-run');
      }),
    ).rejects.toBeInstanceOf(IdempotencyLimitError);
    expect(secondExecuted).toBe(false);
    expect(store.size()).toBe(1);
    release();
    await first;
  });
});
