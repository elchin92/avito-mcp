/**
 * Tests for the idempotency store (v0.7.0). Isolated unit tests without MCP.
 */
import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  IdempotencyStore,
  IdempotencyConflictError,
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
});
