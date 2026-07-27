/**
 * writeJsonAtomic() writes to a temp file and renames it into place. Two paths used to
 * leave that temp behind: a write that failed after the file existed (the close ran in
 * a finally, nothing removed the file), and a process killed between open and rename.
 *
 * Like test/file-lock.test.ts these run below the project directory rather than in
 * os.tmpdir(), so the filesystem matches the one the deployment stores state on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { writeJsonAtomic } from '../src/core/runtime-state.js';

let base: string;

async function temps(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory).catch(() => []);
  return entries.filter((name) => name.startsWith('.') && name.endsWith('.tmp'));
}

beforeEach(async () => {
  // Anchored to this file, not to process.cwd(), which vitest does not guarantee.
  base = join(import.meta.dirname, `.tmptest-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

describe('writeJsonAtomic temp handling', () => {
  it('leaves no temp behind on the happy path', async () => {
    const target = join(base, 'state.json');
    await writeJsonAtomic(target, { ok: true });

    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ ok: true });
    expect(await temps(base)).toEqual([]);
  });

  it('removes the temp when the write itself fails', async () => {
    const target = join(base, 'state.json');
    const realOpen = fs.open.bind(fs) as (...args: unknown[]) => Promise<{
      writeFile: (...args: unknown[]) => Promise<void>;
    }>;
    // A full disk fails here, with the temp already created — the reachable case, and
    // the one the old finally-only cleanup missed entirely.
    vi.spyOn(fs, 'open').mockImplementation((async (...args: unknown[]) => {
      const handle = await realOpen(...args);
      handle.writeFile = async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      };
      return handle;
    }) as unknown as typeof fs.open);

    await expect(writeJsonAtomic(target, { ok: true })).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await temps(base)).toEqual([]);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the temp when the rename fails', async () => {
    const target = join(base, 'state.json');
    vi.spyOn(fs, 'rename').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );

    await expect(writeJsonAtomic(target, { ok: true })).rejects.toMatchObject({ code: 'EXDEV' });
    expect(await temps(base)).toEqual([]);
  });

  it('sweeps only the temps this writer produces', async () => {
    const target = join(base, 'state.json');
    // Other components keep their own temps in these directories under their own names.
    // Deleting one mid-write would lose the file it is about to become.
    const survivors = [
      '.token.json.aabbccddeeff001122334455.tmp', // token-store
      '.oauth.json.aabbccddeeff.tmp', // oauth store
      'notatemp.tmp', // no leading dot
      '.hidden', // no .tmp suffix
      'state-other.json',
    ];
    const old = new Date(Date.now() - 7_200_000);
    for (const name of survivors) {
      await fs.writeFile(join(base, name), 'keep', { mode: 0o600 });
      await fs.utimes(join(base, name), old, old);
    }

    await writeJsonAtomic(target, { ok: true });

    for (const name of survivors) {
      expect(await fs.readFile(join(base, name), 'utf8')).toBe('keep');
    }
  });

  it('clears temps abandoned by a killed process without touching a fresh one', async () => {
    const target = join(base, 'state.json');
    const abandoned = join(base, `.${'a'.repeat(24)}.tmp`);
    const inFlight = join(base, `.${'b'.repeat(24)}.tmp`);
    await fs.writeFile(abandoned, 'orphan', { mode: 0o600 });
    await fs.writeFile(inFlight, 'someone is writing right now', { mode: 0o600 });
    const old = new Date(Date.now() - 7_200_000);
    await fs.utimes(abandoned, old, old);

    await writeJsonAtomic(target, { ok: true });

    // Only the aged one goes: a concurrent writer's temp is seconds old, never hours.
    expect(await temps(base)).toEqual([`.${'b'.repeat(24)}.tmp`]);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ ok: true });
  });
});
