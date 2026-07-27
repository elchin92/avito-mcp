import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Config } from '../config.js';

export function runtimeNamespace(
  config: Pick<Config, 'baseUrl' | 'clientId' | 'profileId'>,
): string {
  return createHash('sha256')
    .update('avito-mcp:runtime:v1\0')
    .update(config.baseUrl)
    .update('\0')
    .update(config.clientId)
    .update('\0')
    .update(String(config.profileId ?? 'unconfigured'))
    .digest('hex');
}

export function runtimeStateDirectory(
  config: Pick<Config, 'runtimeStateDir' | 'tokenFile'>,
): string {
  return config.runtimeStateDir ?? join(dirname(config.tokenFile), 'runtime');
}

/** Minimal readiness check for the shared idempotency/pending/limiter directory. */
export async function isRuntimeStateReady(directory: string): Promise<boolean> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    await fs.access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function safeStatePart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Unsafe runtime state file: ${path}`);
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temp = join(directory, `.${randomBytes(12).toString('hex')}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
  } catch (error) {
    // A write that fails after the file exists used to leave it behind: the close ran
    // in a finally, but nothing removed the temp. ENOSPC and EIO reach this far more
    // often than a kill does.
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await fs.rename(temp, path);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  // After the durable write, so collecting other processes' litter never delays this one.
  await sweepStaleTemps(directory);
}

/** A live temp exists for milliseconds; anything this old was abandoned. */
const STALE_TEMP_MS = 3_600_000;
/** Exactly what the writer above produces. Other components keep their own temps in
 *  these directories under different names, and deleting one mid-write would lose data. */
const OWN_TEMP_NAME = /^\.[0-9a-f]{24}\.tmp$/;
const lastSweptAt = new Map<string, number>();

/**
 * Clears temps left by a process killed between open() and rename() — the one leak the
 * error handling above cannot close, because no handler runs at all.
 *
 * Rate-limited to once per directory per stale window rather than once per process: a
 * long-lived server would otherwise never collect a leak that happened after its first
 * write, and a directory scan on every snapshot write is not free. It runs after the
 * rename so it never sits between the caller's lease and its durable write.
 *
 * The age gate is what makes this safe beside a concurrent writer, whose temp is seconds
 * old at most. It is judged on wall clock, so a large forward clock step could in
 * principle condemn a live temp; the loser of that race is one write that fails and is
 * retried, never a corrupted file, because the temp is not yet visible under its name.
 */
async function sweepStaleTemps(directory: string): Promise<void> {
  const now = Date.now();
  const last = lastSweptAt.get(directory);
  if (last !== undefined && now - last < STALE_TEMP_MS) return;
  const cutoff = now - STALE_TEMP_MS;
  try {
    // opendir streams, so a large ledger directory never materializes as one array.
    const dir = await fs.opendir(directory);
    for await (const entry of dir) {
      if (!entry.isFile() || !OWN_TEMP_NAME.test(entry.name)) continue;
      const candidate = join(directory, entry.name);
      const stat = await fs.lstat(candidate).catch(() => undefined);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
      await fs.rm(candidate, { force: true }).catch(() => undefined);
    }
    lastSweptAt.set(directory, now);
  } catch {
    // Best effort: a leaked temp is untidy, never a correctness problem. Not recording
    // the sweep leaves a transient failure to be retried on the next write.
  }
}

/** Removes a runtime-state file and durably records the unlink in its directory. */
export async function removeFileDurable(path: string): Promise<void> {
  const directory = dirname(path);
  await fs.rm(path, { force: true });
  await syncDirectory(directory);
}

/** Flushes directory metadata where supported; some safe platforms reject directory fsync. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR') {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
