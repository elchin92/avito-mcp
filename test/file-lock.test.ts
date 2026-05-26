/**
 * Тесты межпроцессного file-lock (v0.7.0).
 * Не пытаемся реально форкать процессы — проверяем serialization
 * через параллельные withFileLock в том же процессе + симуляцию stale-lock.
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
    // Каждый enter должен идти подряд со своим exit — без перемежения других.
    // Проверяем парами: i-й enter и (i+1)-й exit должны быть одной буквой.
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
    // Если lock не освобождён — следующий withFileLock зависнет; ставим короткий timeout.
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { timeoutMs: 1000 });
    expect(ran).toBe(true);
  });

  it('throws FileLockTimeoutError when lock cannot be acquired within timeout', async () => {
    // Создаём lock руками с живым (нашим) PID
    await fs.writeFile(`${target}.lock`, `${process.pid}\n${Date.now()}\n`, { mode: 0o600 });
    await expect(
      withFileLock(target, async () => 'never', { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    await fs.rm(`${target}.lock`, { force: true });
  });

  it('snatches stale lock (dead PID)', async () => {
    // PID 999999 заведомо не существует. process.kill(pid, 0) бросит ESRCH → stale.
    await fs.writeFile(`${target}.lock`, `999999\n${Date.now()}\n`, { mode: 0o600 });
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { timeoutMs: 5000 });
    expect(ran).toBe(true);
  });

  it('snatches stale lock by age (timestamp > staleMs)', async () => {
    // Живой PID но древний timestamp → должно быть stale.
    const ancient = Date.now() - 120_000; // 2 минуты назад
    await fs.writeFile(`${target}.lock`, `${process.pid}\n${ancient}\n`, { mode: 0o600 });
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { timeoutMs: 5000, staleMs: 60_000 });
    expect(ran).toBe(true);
  });
});
