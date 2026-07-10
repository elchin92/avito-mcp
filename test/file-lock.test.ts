/**
 * Tests for the cross-process token lease. We do not fork processes here; the
 * deterministic transition test injects the exact successor-replacement race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { FileLockTimeoutError, withFileLock } from '../src/core/file-lock.js';

function lockRecord(pid: number, nonce: string, createdAt = Date.now()): string {
  return `${JSON.stringify({ version: 1, pid, createdAt, nonce })}\n`;
}

async function createDirectoryLease(
  target: string,
  pid: number,
  nonce: string,
  createdAt = Date.now(),
): Promise<string> {
  const lockPath = `${target}.lock`;
  const markerName = `owner-${nonce}.json`;
  const raw = lockRecord(pid, nonce, createdAt);
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(join(lockPath, markerName), raw, { mode: 0o600 });
  return raw;
}

describe('file-lock', () => {
  let target: string;

  beforeEach(() => {
    target = join(tmpdir(), `lock-target-${randomBytes(6).toString('hex')}`);
  });

  afterEach(async () => {
    await fs.rm(target, { force: true });
    const parent = dirname(target);
    const prefix = `${basename(target)}.lock`;
    const entries = await fs.readdir(parent).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => fs.rm(join(parent, entry), { recursive: true, force: true })),
    );
    vi.restoreAllMocks();
  });

  it('serialises concurrent acquirers - only one critical section runs at a time', async () => {
    const inside: string[] = [];
    const work = (id: string) =>
      withFileLock(target, async () => {
        inside.push(`${id}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inside.push(`${id}:exit`);
      });
    await Promise.all([work('A'), work('B'), work('C')]);

    expect(inside).toHaveLength(6);
    for (let index = 0; index < 6; index += 2) {
      const enter = inside[index];
      const exit = inside[index + 1];
      expect(enter!.endsWith(':enter')).toBe(true);
      expect(exit!.endsWith(':exit')).toBe(true);
      expect(enter![0]).toBe(exit![0]);
    }
  });

  it('releases the lease even when fn throws', async () => {
    await expect(
      withFileLock(target, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    let ran = false;
    await withFileLock(
      target,
      async () => {
        ran = true;
      },
      { timeoutMs: 1000 },
    );
    expect(ran).toBe(true);
  });

  it('throws FileLockTimeoutError while a live owner holds the lease', async () => {
    await createDirectoryLease(target, process.pid, '1'.repeat(32));
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it('reclaims a directory lease owned by a dead PID', async () => {
    await createDirectoryLease(target, 999999, '2'.repeat(32));
    let ran = false;
    await withFileLock(
      target,
      async () => {
        ran = true;
      },
      { timeoutMs: 5000 },
    );
    expect(ran).toBe(true);
  });

  it('never steals an old lease while its PID is still alive', async () => {
    await createDirectoryLease(target, process.pid, '3'.repeat(32), Date.now() - 120_000);
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 150, staleMs: 1 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it('does not remove a replacement generation when the old owner releases', async () => {
    let entered!: () => void;
    const enteredCriticalSection = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = withFileLock(target, async () => {
      entered();
      await hold;
    });
    await enteredCriticalSection;

    const lockPath = `${target}.lock`;
    const parkedPath = `${lockPath}.parked`;
    await fs.rename(lockPath, parkedPath);
    const replacement = await createDirectoryLease(target, process.pid, 'f'.repeat(32));

    release();
    await owner;
    expect(await fs.readFile(join(lockPath, `owner-${'f'.repeat(32)}.json`), 'utf8')).toBe(
      replacement,
    );
  });

  it('preserves a successor installed immediately before the transition claim', async () => {
    let entered!: () => void;
    const enteredCriticalSection = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = withFileLock(target, async () => {
      entered();
      await hold;
    });
    await enteredCriticalSection;

    const lockPath = `${target}.lock`;
    const parkedPath = `${lockPath}.race-old`;
    const [originalMarker] = await fs.readdir(lockPath);
    const originalMarkerPath = join(lockPath, originalMarker!);
    const successorNonce = 'e'.repeat(32);
    const successorMarkerPath = join(lockPath, `owner-${successorNonce}.json`);
    const successor = lockRecord(process.pid, successorNonce);
    const realRename = fs.rename.bind(fs);
    let swapped = false;

    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (
        !swapped &&
        String(oldPath) === originalMarkerPath &&
        basename(String(newPath)).startsWith('.transition-')
      ) {
        swapped = true;
        await realRename(lockPath, parkedPath);
        await fs.mkdir(lockPath, { mode: 0o700 });
        await fs.writeFile(successorMarkerPath, successor, { mode: 0o600 });
      }
      return realRename(oldPath, newPath);
    });

    release();
    await owner;

    expect(swapped).toBe(true);
    expect(await fs.readFile(successorMarkerPath, 'utf8')).toBe(successor);
  });

  it('gives a fresh partial owner marker a grace period', async () => {
    const lockPath = `${target}.lock`;
    const nonce = '4'.repeat(32);
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(join(lockPath, `owner-${nonce}.json`), '', { mode: 0o600 });
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 150, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it('fails closed on a stale legacy file-style lock', async () => {
    const legacy = `999999\n${Date.now() - 120_000}\n`;
    await fs.writeFile(`${target}.lock`, legacy, { mode: 0o600 });
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 150, staleMs: 1 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(legacy);
  });
});
