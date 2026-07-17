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
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, path);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
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
