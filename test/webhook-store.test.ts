/**
 * v0.9.0: unit tests for the in-memory webhook ring buffer (src/core/webhook-store.ts).
 *
 * Covers:
 *   - record() returns a normalised event (recv_id + received_at always present),
 *   - summarise() pulls chat_id/author_id/message_type/payload_type out of a realistic
 *     Avito envelope,
 *   - the ring buffer caps at bufferSize (newest kept, oldest dropped),
 *   - list({ since, chatId, limit }) filters correctly and returns newest-first,
 *   - stats() counts total_received vs retained,
 *   - onChange() fires once per record and unsubscribe stops it.
 *
 * The module is imported lazily inside a beforeAll so a missing/renamed export gives a
 * clear failure here rather than crashing the whole suite at load time.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Loaded lazily in beforeAll (see file header).
type WebhookStoreCtor = typeof import('../src/core/webhook-store.js').WebhookStore;
type WebhookEvent = import('../src/core/webhook-store.js').WebhookEvent;

let WebhookStore: WebhookStoreCtor;

beforeAll(async () => {
  const mod = await import('../src/core/webhook-store.js');
  WebhookStore = mod.WebhookStore;
  expect(typeof WebhookStore).toBe('function');
});

/** A realistic Avito messenger webhook envelope (postWebhookV3 shape). */
function makeEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'evt-123',
    version: 'v3',
    timestamp: 1_717_000_000,
    payload: {
      type: 'message',
      value: {
        chat_id: 'c1',
        author_id: 7,
        type: 'text',
        user_id: 12345678,
        item_id: 999,
        ...((overrides.value as Record<string, unknown>) ?? {}),
      },
    },
    ...overrides,
  };
}

describe('WebhookStore.record / summarise', () => {
  it('returns a normalised event with recv_id + received_at and the parsed envelope fields', () => {
    const store = new WebhookStore(100);
    const before = Date.now();
    const event = store.record(makeEnvelope());
    const after = Date.now();

    // Server-side handle is always present, stable, and 16 hex chars (8 bytes).
    expect(event.recv_id).toMatch(/^[0-9a-f]{16}$/);
    expect(event.received_at).toBeGreaterThanOrEqual(before);
    expect(event.received_at).toBeLessThanOrEqual(after);

    // Envelope-level fields.
    expect(event.id).toBe('evt-123');
    expect(event.version).toBe('v3');
    expect(event.timestamp).toBe(1_717_000_000);
    expect(event.payload_type).toBe('message');

    // payload.value fields.
    expect(event.chat_id).toBe('c1');
    expect(event.author_id).toBe(7);
    expect(event.message_type).toBe('text');
    expect(event.user_id).toBe(12345678);
    expect(event.item_id).toBe(999);

    // Raw is preserved verbatim.
    expect(event.raw).toEqual(makeEnvelope());
  });

  it('tolerates an empty / shapeless payload without throwing (defensive summarise)', () => {
    const store = new WebhookStore(10);
    const e1 = store.record({});
    expect(e1.recv_id).toMatch(/^[0-9a-f]{16}$/);
    expect(e1.chat_id).toBeUndefined();
    expect(e1.payload_type).toBeUndefined();

    // Null / non-object raw must not crash either.
    const e2 = store.record(null);
    expect(e2.recv_id).toMatch(/^[0-9a-f]{16}$/);
    expect(e2.chat_id).toBeUndefined();
  });

  it('ignores wrong-typed envelope fields (string author_id stays undefined)', () => {
    const store = new WebhookStore(10);
    const e = store.record({
      id: 12345, // number, not string → dropped
      payload: { type: 'message', value: { chat_id: 'c1', author_id: '7' } },
    });
    expect(e.id).toBeUndefined(); // numeric id is not coerced to string
    expect(e.chat_id).toBe('c1');
    expect(e.author_id).toBeUndefined(); // string author_id rejected
  });
});

describe('WebhookStore ring buffer', () => {
  it('caps retained events at bufferSize, keeping the newest', () => {
    const buffer = 3;
    const store = new WebhookStore(buffer);
    for (let i = 0; i < 10; i++) {
      store.record(makeEnvelope({ id: `evt-${i}`, value: { chat_id: `c${i}` } }));
    }
    const retained = store.list();
    expect(retained.length).toBe(buffer);
    expect(store.stats().retained).toBe(buffer);
    // Newest-first: the last three recorded ids in descending order.
    expect(retained.map((e) => e.id)).toEqual(['evt-9', 'evt-8', 'evt-7']);
  });
});

describe('WebhookStore.list filters', () => {
  it('returns events newest-first', () => {
    const store = new WebhookStore(100);
    const a = store.record(makeEnvelope({ id: 'a' }));
    const b = store.record(makeEnvelope({ id: 'b' }));
    const c = store.record(makeEnvelope({ id: 'c' }));
    const ids = store.list().map((e) => e.id);
    expect(ids).toEqual(['c', 'b', 'a']);
    // recv_ids are all distinct.
    expect(new Set([a.recv_id, b.recv_id, c.recv_id]).size).toBe(3);
  });

  it('filters by chatId', () => {
    const store = new WebhookStore(100);
    store.record(makeEnvelope({ id: 'a', value: { chat_id: 'c1' } }));
    store.record(makeEnvelope({ id: 'b', value: { chat_id: 'c2' } }));
    store.record(makeEnvelope({ id: 'c', value: { chat_id: 'c1' } }));
    const out = store.list({ chatId: 'c1' });
    expect(out.map((e) => e.id)).toEqual(['c', 'a']); // newest-first, only c1
    expect(out.every((e) => e.chat_id === 'c1')).toBe(true);
  });

  it('filters by since (ms epoch, inclusive)', () => {
    const now = 1_000_000_000_000;
    const spy = vi.spyOn(Date, 'now');
    try {
      const store = new WebhookStore(100);
      spy.mockReturnValue(now);
      store.record(makeEnvelope({ id: 'old' }));
      spy.mockReturnValue(now + 5000);
      const mid = store.record(makeEnvelope({ id: 'mid' }));
      spy.mockReturnValue(now + 10_000);
      store.record(makeEnvelope({ id: 'new' }));

      // since == mid.received_at → inclusive lower bound keeps mid + new.
      const out = store.list({ since: mid.received_at });
      expect(out.map((e) => e.id)).toEqual(['new', 'mid']);
    } finally {
      spy.mockRestore();
    }
  });

  it('caps with limit while staying newest-first', () => {
    const store = new WebhookStore(100);
    for (let i = 0; i < 6; i++) store.record(makeEnvelope({ id: `e${i}` }));
    const out = store.list({ limit: 2 });
    expect(out.map((e) => e.id)).toEqual(['e5', 'e4']);
  });

  it('combines since + chatId + limit', () => {
    const now = 2_000_000_000_000;
    const spy = vi.spyOn(Date, 'now');
    try {
      const store = new WebhookStore(100);
      spy.mockReturnValue(now);
      store.record(makeEnvelope({ id: 'a', value: { chat_id: 'c1' } }));
      spy.mockReturnValue(now + 1000);
      store.record(makeEnvelope({ id: 'b', value: { chat_id: 'c2' } }));
      spy.mockReturnValue(now + 2000);
      const cutoff = now + 2000;
      store.record(makeEnvelope({ id: 'c', value: { chat_id: 'c1' } }));
      spy.mockReturnValue(now + 3000);
      store.record(makeEnvelope({ id: 'd', value: { chat_id: 'c1' } }));

      const out = store.list({ since: cutoff, chatId: 'c1', limit: 1 });
      // c1 events at/after cutoff, newest-first, capped at 1 → just 'd'.
      expect(out.map((e) => e.id)).toEqual(['d']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('WebhookStore.stats', () => {
  it('counts total_received independently of retained (buffer overflow)', () => {
    const store = new WebhookStore(2);
    expect(store.stats()).toMatchObject({
      retained: 0,
      total_received: 0,
      last_received_at: null,
      buffer_size: 2,
    });
    for (let i = 0; i < 5; i++) store.record(makeEnvelope({ id: `e${i}` }));
    const s = store.stats();
    expect(s.total_received).toBe(5); // every record counted
    expect(s.retained).toBe(2); // buffer caps retention
    expect(s.buffer_size).toBe(2);
    expect(s.last_received_at).not.toBeNull();
    // last_received_at is an ISO-8601 timestamp.
    expect(() => new Date(s.last_received_at as string).toISOString()).not.toThrow();
  });
});

describe('WebhookStore.onChange', () => {
  it('fires the listener once per record with the recorded event', () => {
    const store = new WebhookStore(10);
    const seen: WebhookEvent[] = [];
    const unsub = store.onChange((e) => seen.push(e));

    const a = store.record(makeEnvelope({ id: 'a' }));
    const b = store.record(makeEnvelope({ id: 'b' }));
    expect(seen.length).toBe(2);
    expect(seen[0]!.recv_id).toBe(a.recv_id);
    expect(seen[1]!.recv_id).toBe(b.recv_id);

    // Unsubscribe stops further notifications.
    unsub();
    store.record(makeEnvelope({ id: 'c' }));
    expect(seen.length).toBe(2);
  });

  it('a throwing listener does not break the receiver or other listeners', () => {
    const store = new WebhookStore(10);
    const good = vi.fn();
    store.onChange(() => {
      throw new Error('subscriber blew up');
    });
    store.onChange(good);
    expect(() => store.record(makeEnvelope())).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});

describe('WebhookStore durability log', () => {
  it('writes a minimized 0600 JSONL record without raw message content', async () => {
    const dir = join(tmpdir(), `webhook-log-${randomBytes(6).toString('hex')}`);
    const file = join(dir, 'events.jsonl');
    try {
      const store = new WebhookStore(10, file);
      store.record({
        id: 'event-with-secret',
        payload: {
          type: 'message',
          value: { chat_id: 'chat-1', type: 'text', text: 'PRIVATE-MESSAGE-CANARY' },
        },
      });
      await store.flush();
      expect(store.isReady()).toBe(true);
      const text = await fs.readFile(file, 'utf8');
      expect(text).not.toContain('PRIVATE-MESSAGE-CANARY');
      expect(JSON.parse(text).raw).toBeUndefined();
      expect(JSON.parse(text).chat_id).toBe('chat-1');
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes appends and retains only the configured rotated files', async () => {
    const dir = join(tmpdir(), `webhook-rotate-${randomBytes(6).toString('hex')}`);
    const file = join(dir, 'events.jsonl');
    try {
      const store = new WebhookStore(20, file, { maxLogBytes: 180, retainedFiles: 2 });
      for (let i = 0; i < 8; i += 1) {
        store.record(makeEnvelope({ id: `rotation-${i}` }));
      }
      await store.flush();
      expect(await fs.readFile(file, 'utf8')).toContain('rotation-7');
      expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('rotation-6');
      await expect(fs.stat(`${file}.2`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink at the configured log path', async () => {
    const dir = join(tmpdir(), `webhook-symlink-${randomBytes(6).toString('hex')}`);
    const target = join(dir, 'target.txt');
    const link = join(dir, 'events.jsonl');
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, 'DO-NOT-TOUCH', { mode: 0o644 });
      await fs.symlink(target, link);
      const store = new WebhookStore(10, link);
      store.record(makeEnvelope({ id: 'symlink-attempt' }));
      await store.flush();
      expect(store.isReady()).toBe(false);
      expect(await fs.readFile(target, 'utf8')).toBe('DO-NOT-TOUCH');
      expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('starts unready when the configured log parent cannot be created', async () => {
    const parent = join(tmpdir(), `webhook-invalid-parent-${randomBytes(6).toString('hex')}`);
    try {
      await fs.writeFile(parent, 'not-a-directory');
      const store = new WebhookStore(10, join(parent, 'events.jsonl'));
      expect(store.isReady()).toBe(false);
    } finally {
      await fs.rm(parent, { force: true });
    }
  });
});
