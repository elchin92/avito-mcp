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

/** A pid that cannot be running, so liveness never rescues a marker written with it. */
const DEAD_PID = 999_999;

async function writeMarker(
  lockPath: string,
  markerName: string,
  pid: number,
  nonce: string,
): Promise<void> {
  await fs.writeFile(join(lockPath, markerName), lockRecord(pid, nonce), { mode: 0o600 });
}

/**
 * Ages a lease directory and everything in it past any plausible staleMs. Reclaim looks
 * at the newest mtime among the directory and its entries, so both have to move.
 */
async function backdate(lockPath: string, ageMs = 120_000): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  for (const entry of await fs.readdir(lockPath)) {
    await fs.utimes(join(lockPath, entry), when, when);
  }
  await fs.utimes(lockPath, when, when);
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

  it('reclaims a marker-less lease directory abandoned before its marker was written', async () => {
    const lockPath = `${target}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, old, old);

    await expect(
      withFileLock(target, async () => 'reclaimed', { timeoutMs: 2_000, staleMs: 60_000 }),
    ).resolves.toBe('reclaimed');
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds a freshly created marker-less directory until it ages out of the grace period', async () => {
    const lockPath = `${target}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });

    // Age is the only thing keeping this directory: it must survive while fresh...
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 150, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await fs.lstat(lockPath)).isDirectory()).toBe(true);

    // ...and be reclaimed once it is older, which is what proves the grace period is
    // doing the blocking rather than the reclaim path simply being absent.
    await backdate(lockPath);
    await expect(
      withFileLock(target, async () => 'reclaimed', { timeoutMs: 2_000, staleMs: 60_000 }),
    ).resolves.toBe('reclaimed');
  });

  // A directory carrying anything other than exactly one recognized marker cannot be
  // adjudicated by staleSnapshot(), so before the reclaim path each of these shapes
  // blocked its domain permanently — the same failure as the empty directory above.
  it.each([
    [
      'two owner markers left by a stalled writer landing in a successor directory',
      async (lockPath: string) => {
        await writeMarker(lockPath, `owner-${'a'.repeat(32)}.json`, DEAD_PID, 'a'.repeat(32));
        await writeMarker(lockPath, `owner-${'b'.repeat(32)}.json`, DEAD_PID, 'b'.repeat(32));
      },
    ],
    [
      'unrecognized leftovers only',
      async (lockPath: string) => {
        await fs.writeFile(join(lockPath, 'garbage.txt'), 'x', { mode: 0o600 });
      },
    ],
  ])('reclaims an abandoned lease directory with %s', async (_label, populate) => {
    const lockPath = `${target}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await populate(lockPath);
    await backdate(lockPath);

    await expect(
      withFileLock(target, async () => 'reclaimed', { timeoutMs: 2_000, staleMs: 60_000 }),
    ).resolves.toBe('reclaimed');
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // The reclaim moves the directory aside before deleting it; nothing may survive that.
    const parent = dirname(target);
    const leftovers = (await fs.readdir(parent)).filter((entry) =>
      entry.startsWith(`${basename(target)}.lock.transitioned-`),
    );
    expect(leftovers).toEqual([]);
  });

  // The reclaim path must never be able to break mutual exclusion. Age alone is not
  // enough to take a lease: a marker naming a live process always wins.
  it.each([
    [
      'a live owner whose critical section outlived staleMs',
      async (lockPath: string) => {
        await writeMarker(lockPath, `owner-${'a'.repeat(32)}.json`, process.pid, 'a'.repeat(32));
      },
    ],
    [
      'a live owner alongside a dead writer stray marker',
      async (lockPath: string) => {
        await writeMarker(lockPath, `owner-${'a'.repeat(32)}.json`, process.pid, 'a'.repeat(32));
        await writeMarker(lockPath, `owner-${'b'.repeat(32)}.json`, DEAD_PID, 'b'.repeat(32));
      },
    ],
    [
      'a live claimant mid-transition next to unrecognized leftovers',
      async (lockPath: string) => {
        await writeMarker(
          lockPath,
          `.transition-${process.pid}-${'c'.repeat(32)}.json`,
          DEAD_PID,
          'c'.repeat(32),
        );
        await fs.writeFile(join(lockPath, 'garbage.txt'), 'x', { mode: 0o600 });
      },
    ],
  ])('never reclaims a lease directory held by %s', async (_label, populate) => {
    const lockPath = `${target}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await populate(lockPath);
    await backdate(lockPath);

    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 200, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await fs.lstat(lockPath)).isDirectory()).toBe(true);
  });

  it('serialises concurrent acquirers racing to reclaim the same abandoned directory', async () => {
    const lockPath = `${target}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(join(lockPath, 'garbage.txt'), 'x', { mode: 0o600 });
    await backdate(lockPath);

    let inside = 0;
    let maxInside = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileLock(
          target,
          async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inside -= 1;
            return 'ok';
          },
          { timeoutMs: 5_000, staleMs: 60_000 },
        ),
      ),
    );

    // Reclaiming must not degenerate into several acquirers each deciding the directory
    // is theirs: the loser of the race retries, it does not enter.
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(maxInside).toBe(1);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
