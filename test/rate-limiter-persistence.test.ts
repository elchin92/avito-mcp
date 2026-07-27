/**
 * Regression tests for the July 2026 order-management outage.
 *
 * RateLimiter.observe() used to persist its snapshot through an unawaited
 * withFileLock(), so every response opened its own lease and a burst kept several
 * mkdir→marker windows open at once. A kill landing in one of those windows left a
 * lease directory that nothing could reclaim, and the domain stopped working.
 *
 * These tests pin the two properties that removed the window: writes are coalesced to
 * one lease at a time per file, and they can be drained before the process exits.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const leases = { started: 0, active: 0, maxActive: 0 };

vi.mock('../src/core/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/file-lock.js')>();
  return {
    ...actual,
    withFileLock: async <T>(
      target: string,
      fn: () => Promise<T>,
      options?: Parameters<typeof actual.withFileLock>[2],
    ): Promise<T> => {
      leases.started += 1;
      leases.active += 1;
      leases.maxActive = Math.max(leases.maxActive, leases.active);
      try {
        return await actual.withFileLock(target, fn, options);
      } finally {
        leases.active -= 1;
      }
    },
  };
});

const { RateLimiter } = await import('../src/core/rate-limiter.js');
const { safeStatePart } = await import('../src/core/runtime-state.js');

const directories: string[] = [];
const NAMESPACE = 'account-a';

async function stateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'avito-mcp-limiter-'));
  directories.push(path);
  return path;
}

function snapshotPath(directory: string, domain: string): string {
  return join(directory, NAMESPACE, 'rate-limits', `${safeStatePart(domain)}.json`);
}

function headers(remaining: number, limit = 100): Headers {
  return new Headers({
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
  });
}

beforeEach(() => {
  leases.started = 0;
  leases.active = 0;
  leases.maxActive = 0;
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('rate-limit snapshot persistence', () => {
  it('keeps at most one lease open per file across a burst and keeps the newest snapshot', async () => {
    const directory = await stateDir();
    const limiter = new RateLimiter({ stateDir: directory, namespace: NAMESPACE });

    for (let remaining = 50; remaining > 0; remaining -= 1) {
      limiter.observe('orders', headers(remaining));
    }
    await limiter.flushPersisted();

    // The whole point: 50 responses can no longer put 50 mkdir→marker windows in the air.
    expect(leases.maxActive).toBe(1);
    expect(leases.started).toBeLessThan(50);
    // Coalescing drops superseded snapshots, never the newest one.
    const persisted = JSON.parse(await fs.readFile(snapshotPath(directory, 'orders'), 'utf8'));
    expect(persisted).toMatchObject({ domain: 'orders', remaining: 1, limit: 100 });
  });

  it('drains queued writes before the process exits', async () => {
    const directory = await stateDir();
    const limiter = new RateLimiter({ stateDir: directory, namespace: NAMESPACE });

    limiter.observe('orders', headers(9));
    await limiter.flushPersisted();

    // No polling: after the flush the write has landed, so a shutdown that awaits it
    // cannot be killed with a lease still open.
    const persisted = JSON.parse(await fs.readFile(snapshotPath(directory, 'orders'), 'utf8'));
    expect(persisted).toMatchObject({ remaining: 9 });
    expect(leases.active).toBe(0);
  });

  it('serialises writes to different domains without blocking either', async () => {
    const directory = await stateDir();
    const limiter = new RateLimiter({ stateDir: directory, namespace: NAMESPACE });

    limiter.observe('orders', headers(4));
    limiter.observe('messenger', headers(5));
    await limiter.flushPersisted();

    expect(
      JSON.parse(await fs.readFile(snapshotPath(directory, 'orders'), 'utf8')),
    ).toMatchObject({ remaining: 4 });
    expect(
      JSON.parse(await fs.readFile(snapshotPath(directory, 'messenger'), 'utf8')),
    ).toMatchObject({ remaining: 5 });
  });

  it('does not take a lease for a response that carries no rate-limit headers', async () => {
    const directory = await stateDir();
    const limiter = new RateLimiter({ stateDir: directory, namespace: NAMESPACE });

    limiter.observe('orders', new Headers({ 'content-type': 'application/json' }));
    await limiter.flushPersisted();

    // Nothing to record means nothing to lock: waitIfNeeded() treats a snapshot without
    // `remaining` exactly like a missing file, so the write bought only a kill window.
    expect(leases.started).toBe(0);
    await expect(fs.lstat(snapshotPath(directory, 'orders'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // It still has to be visible locally for meta_get_rate_limits and meta_health.
    expect(limiter.getStatus('orders')).toMatchObject([{ domain: 'orders' }]);
  });

  it('persists an exhausted budget, which reads as zero rather than as absent', async () => {
    const directory = await stateDir();
    const limiter = new RateLimiter({ stateDir: directory, namespace: NAMESPACE });

    limiter.observe('orders', headers(0));
    await limiter.flushPersisted();

    expect(
      JSON.parse(await fs.readFile(snapshotPath(directory, 'orders'), 'utf8')),
    ).toMatchObject({ remaining: 0, limit: 100 });
  });

  it('survives a wedged lease without losing the next snapshot', async () => {
    const directory = await stateDir();
    const limiter = new RateLimiter({
      stateDir: directory,
      namespace: NAMESPACE,
      lockTimeoutMs: 150,
    });
    const path = snapshotPath(directory, 'orders');
    await fs.mkdir(join(directory, NAMESPACE, 'rate-limits'), { recursive: true, mode: 0o700 });

    // A lease held by this very process can never be declared stale, so this write fails.
    const lockPath = `${path}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      join(lockPath, `owner-${'a'.repeat(32)}.json`),
      `${JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now(), nonce: 'a'.repeat(32) })}\n`,
      { mode: 0o600 },
    );

    limiter.observe('orders', headers(7));
    await limiter.flushPersisted();
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });

    // A failed write must not wedge the queue: once the lease clears, the next
    // observation is persisted normally.
    await fs.rm(lockPath, { recursive: true, force: true });
    limiter.observe('orders', headers(6));
    await limiter.flushPersisted();
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({ remaining: 6 });
  });
});
