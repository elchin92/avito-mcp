/**
 * Tests for the cross-process file lock (v0.7.0).
 * We don't actually fork processes — instead we verify serialization
 * via parallel withFileLock calls in the same process plus a stale-lock simulation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { withFileLock, FileLockTimeoutError } from '../src/core/file-lock.js';

describe('file-lock', () => {
  let target: string;

  beforeEach(() => {
    target = join(tmpdir(), `lock-target-${randomBytes(6).toString('hex')}`);
  });

  afterEach(async () => {
    await fs.rm(target, { force: true });
    await fs.rm(`${target}.lock`, { force: true });
  });

  it('serialises concurrent acquirers — only one critical section runs at a time', async () => {
    const inside: string[] = [];
    const work = (id: string) =>
      withFileLock(target, async () => {
        inside.push(`${id}:enter`);
        await new Promise((r) => setTimeout(r, 20));
        inside.push(`${id}:exit`);
      });
    await Promise.all([work('A'), work('B'), work('C')]);
    // Each enter must be immediately followed by its own exit — no interleaving with others.
    // Check in pairs: the i-th enter and the (i+1)-th exit must share the same letter.
    expect(inside).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) {
      const enter = inside[i];
      const exit = inside[i + 1];
      expect(enter!.endsWith(':enter')).toBe(true);
      expect(exit!.endsWith(':exit')).toBe(true);
      expect(enter![0]).toBe(exit![0]);
    }
  });

  it('releases lock even when fn throws', async () => {
    await expect(
      withFileLock(target, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // If the lock isn't released, the next withFileLock would hang; use a short timeout.
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { timeoutMs: 1000 });
    expect(ran).toBe(true);
  });

  it('throws FileLockTimeoutError when lock cannot be acquired within timeout', async () => {
    // Create the lock manually with a live (our own) PID
    await fs.writeFile(`${target}.lock`, `${process.pid}\n${Date.now()}\n`, { mode: 0o600 });
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    await fs.rm(`${target}.lock`, { force: true });
  });

  it('snatches stale lock (dead PID)', async () => {
    // PID 999999 definitely doesn't exist. process.kill(pid, 0) will throw ESRCH → stale.
    await fs.writeFile(`${target}.lock`, `999999\n${Date.now()}\n`, { mode: 0o600 });
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { timeoutMs: 5000 });
    expect(ran).toBe(true);
  });

  it('snatches stale lock by age (timestamp > staleMs)', async () => {
    // Live PID but an ancient timestamp → should be treated as stale.
    const ancient = Date.now() - 120_000; // 2 minutes ago
    await fs.writeFile(`${target}.lock`, `${process.pid}\n${ancient}\n`, { mode: 0o600 });
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { timeoutMs: 5000, staleMs: 60_000 });
    expect(ran).toBe(true);
  });
});
