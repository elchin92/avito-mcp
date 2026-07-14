import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Config } from '../config.js';

export function runtimeNamespace(config: Pick<Config, 'baseUrl' | 'clientId' | 'profileId'>): string {
  return createHash('sha256')
    .update('avito-mcp:runtime:v1\0')
    .update(config.baseUrl)
    .update('\0')
    .update(config.clientId)
    .update('\0')
    .update(String(config.profileId ?? 'unconfigured'))
    .digest('hex');
}

export function runtimeStateDirectory(config: Pick<Config, 'runtimeStateDir' | 'tokenFile'>): string {
  return config.runtimeStateDir ?? join(dirname(config.tokenFile), 'runtime');
}

export function safeStatePart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe runtime state file: ${path}`);
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
    const dir = await fs.open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
