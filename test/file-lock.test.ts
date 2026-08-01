/**
 * Tests for the cross-process token lease. We do not fork processes here; the
 * deterministic transition test injects the exact successor-replacement race.
 *
 * They run in the repo-filesystem sandbox rather than os.tmpdir() on purpose; the
 * reasoning lives in test/support/sandbox.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { FileLockTimeoutError, withFileLock } from '../src/core/file-lock.js';
import { createSandbox, removeSandbox } from './support/sandbox.js';

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

/**
 * A pid that is provably gone. A hardcoded large number is not: pid_max on Linux is
 * commonly 4194304, so 999999 is allocatable and a liveness assertion built on it can
 * invert on a busy host. Spawning a child and waiting for its exit reaps it, so the
 * number is guaranteed free for as long as the run lasts.
 */
let DEAD_PID: number;

beforeAll(async () => {
  const child = spawn(process.execPath, ['-e', '']);
  DEAD_PID = child.pid!;
  await new Promise((resolve) => child.once('exit', resolve));
});

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
  let base: string;
  let target: string;

  beforeEach(async () => {
    base = await createSandbox('lock');
    target = join(base, 'lock-target');
  });

  afterEach(async () => {
    // The whole sandbox goes, so leases, transitioned leftovers and strays all go with it.
    await removeSandbox(base);
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
    await createDirectoryLease(target, DEAD_PID, '2'.repeat(32));
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

  // Ownership cannot be proved by inode: ext4 hands the freed directory inode straight
  // back to the next mkdir at the same path, so a competitor that reclaimed our lease
  // and republished it passes every dev/ino check. Only the marker set distinguishes
  // them, and getting this wrong grants the lease to two processes at once.
  it('refuses ownership when another generation published a marker into our directory', async () => {
    const lockPath = `${target}.lock`;
    const competitor = `owner-${'9'.repeat(32)}.json`;
    const realOpen = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    // Plant a competitor's marker in the instant between our mkdir and our marker write
    // — exactly what a stalled writer does after its directory has been reclaimed.
    vi.spyOn(fs, 'open').mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      if (String(path).startsWith(join(lockPath, 'owner-'))) {
        await fs
          .writeFile(join(lockPath, competitor), lockRecord(process.pid, '9'.repeat(32)), {
            mode: 0o600,
          })
          .catch(() => undefined);
      }
      return realOpen(path, ...rest);
    }) as unknown as typeof fs.open);

    await expect(
      withFileLock(target, async () => 'stolen', { timeoutMs: 300, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    // The competitor's lease must be intact, and we must not have left our own marker
    // behind — a second marker is what makes a directory unadjudicable in the first place.
    const entries = await fs.readdir(lockPath);
    expect(entries).toEqual([competitor]);
  });

  /**
   * The ownership proof, and it runs everywhere.
   *
   * A replacement generation that carries the very inode the acquirer published is the
   * one case dev/ino cannot see, and it is the case soleMarker() exists for: lockMatches()
   * compares dev/ino and our marker's bytes, both of which agree here, so the only thing
   * left to refuse the lease is the marker set.
   *
   * The inode is held identical by construction instead of by hoping the kernel recycles
   * it. rename() carries a directory across a vacancy without changing its inode, so the
   * path is genuinely emptied and republished with a different generation in it. What the
   * acquirer can observe afterwards — dev, ino, mode, link count, the marker set — is what
   * ext4 produces when it hands the freed inode straight back to a competitor's mkdir,
   * which is exactly why an inode is worthless as proof of ownership.
   *
   * Real recycling is left to the sibling test below, because it cannot be made reliable:
   * ext4 allocates the lowest free inode in the block group, so any concurrent delete of a
   * lower inode anywhere in that group — another vitest worker tearing down its sandbox,
   * say — takes the freed inode first. Measured on ext4 under that kind of load the inode
   * came back 104 times out of 200; retrying does not recover it (99/200) because after
   * the first miss the allocator is stable on the lower inode.
   */
  it('refuses a lease whose directory was replaced under it, inode identity and all', async () => {
    const lockPath = `${target}.lock`;
    const nonce = '7'.repeat(32);
    const competitor = `owner-${nonce}.json`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await backdate(lockPath);

    let publishedIno: number | undefined;
    let replacedIno: number | undefined;
    const realOpen = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, 'open').mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      if (String(path).startsWith(join(lockPath, 'owner-')) && replacedIno === undefined) {
        publishedIno = (await fs.lstat(lockPath)).ino;
        // A competitor reclaims our lease and republishes the path before our marker lands.
        // The directory the acquirer meets on its return is not the generation it published
        // — it holds a competitor's marker and not ours — yet dev/ino still agree.
        const reclaimed = `${lockPath}.reclaimed`;
        await fs.rename(lockPath, reclaimed);
        await fs.writeFile(join(reclaimed, competitor), lockRecord(process.pid, nonce), {
          mode: 0o600,
        });
        await fs.rename(reclaimed, lockPath);
        replacedIno = (await fs.lstat(lockPath)).ino;
      }
      return realOpen(path, ...rest);
    }) as unknown as typeof fs.open);

    await expect(
      withFileLock(target, async () => 'stolen', { timeoutMs: 300, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    // The interception has to have happened, or the assertions below prove nothing.
    expect(publishedIno).toBeDefined();
    // What an inode-based owner check would have consulted still says "our directory"...
    expect(replacedIno).toBe(publishedIno);
    // ...and the lease was refused anyway, so the marker set is what decided it. The
    // competitor keeps its lease, and we left no stray marker of our own behind.
    expect(await fs.readdir(lockPath)).toEqual([competitor]);
  });

  // The same scenario driven by the kernel rather than by rename(), which is worth having
  // because it also demonstrates the recycling the design is built around. It is the one
  // test here that depends on the filesystem, and the reason this suite runs next to the
  // repo rather than in tmpdir. The precondition is not ours to guarantee, so when the
  // freed inode does not come back this skips instead of failing: the ownership proof is
  // in the test above, which does not need the kernel's cooperation.
  it('refuses a replaced lease when the kernel hands the directory inode back', async (ctx) => {
    const lockPath = `${target}.lock`;
    const nonce = '7'.repeat(32);
    const competitor = `owner-${nonce}.json`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await backdate(lockPath);

    let publishedIno: number | undefined;
    let replacedIno: number | undefined;
    const realOpen = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, 'open').mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      if (String(path).startsWith(join(lockPath, 'owner-')) && replacedIno === undefined) {
        publishedIno = (await fs.lstat(lockPath)).ino;
        // A competitor reclaims our lease and republishes the path before our marker lands.
        await fs.rmdir(lockPath);
        await fs.mkdir(lockPath, { mode: 0o700 });
        replacedIno = (await fs.lstat(lockPath)).ino;
        await fs.writeFile(join(lockPath, competitor), lockRecord(process.pid, nonce), {
          mode: 0o600,
        });
      }
      return realOpen(path, ...rest);
    }) as unknown as typeof fs.open);

    await expect(
      withFileLock(target, async () => 'stolen', { timeoutMs: 300, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    // A missed interception is a broken test, not an uncooperative kernel.
    expect(publishedIno).toBeDefined();
    ctx.skip(
      replacedIno !== publishedIno,
      'the kernel did not hand the directory inode back: ext4 allocates the lowest free ' +
        'inode in the block group, so a concurrent delete elsewhere in that group takes ' +
        'it first, and tmpfs never recycles at all. Nothing is lost — the ownership proof ' +
        'is the preceding test, which pins the inode with rename() instead',
    );
    // The competitor keeps its lease, and we left no stray marker of our own behind.
    expect(await fs.readdir(lockPath)).toEqual([competitor]);
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
