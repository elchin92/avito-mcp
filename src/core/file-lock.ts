/**
 * Простой межпроцессный advisory file-lock для defence-in-depth поверх in-process
 * single-flight в TokenStore. Используется в OAuth refresh, чтобы несколько процессов
 * avito-mcp (например, MCP-клиент + cron-агент + ручной CLI) не делали одновременный
 * refresh и не упирались в rate-limit /token endpoint Avito.
 *
 * Implementation: exclusive-create lock file (`{target}.lock`) с записанным PID.
 * Stale-detection: если PID не живёт, lock считается осиротевшим и удаляется.
 * Backoff: 50–150ms jitter, чтобы избежать lockstep при многократных contenders.
 *
 * Это advisory-механизм. Любой код, не использующий withFileLock(), его не увидит —
 * поэтому он работает только когда все процессы honor одной и той же конвенции.
 *
 * Зависимостей не добавляем. proper-lockfile, который чаще всего используют для
 * таких задач, втащил бы graceful-fs и retry — здесь это излишне.
 */
import { promises as fs } from 'node:fs';

export interface FileLockOptions {
  /** Максимальное время ожидания свободного lock'а. Default 30s. */
  timeoutMs?: number;
  /** Минимальный интервал между попытками. Default 50ms. */
  retryMinMs?: number;
  /** Максимальный интервал между попытками. Default 150ms. */
  retryMaxMs?: number;
  /** Максимальный возраст stale lock'а, после которого его можно снять. Default 60s. */
  staleMs?: number;
}

const DEFAULTS: Required<FileLockOptions> = {
  timeoutMs: 30_000,
  retryMinMs: 50,
  retryMaxMs: 150,
  staleMs: 60_000,
};

/**
 * Acquires `${target}.lock`, runs fn(), then releases.
 * fn выполняется только когда lock реально получен.
 * Если за timeoutMs lock получить не удалось — бросаем FileLockTimeoutError.
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + opts.timeoutMs;

  await acquireLock(lockPath, deadline, opts);
  try {
    return await fn();
  } finally {
    // Releasing — best-effort. Если файл уже не наш (украли через stale-cleanup),
    // не страшно: следующий acquireLock получит свежий lock.
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function acquireLock(
  lockPath: string,
  deadline: number,
  opts: Required<FileLockOptions>,
): Promise<void> {
  const pidLine = `${process.pid}\n${Date.now()}\n`;
  while (true) {
    try {
      // wx = O_CREAT | O_EXCL — атомарно создаёт файл; если есть — бросает EEXIST.
      const fd = await fs.open(lockPath, 'wx', 0o600);
      try {
        await fd.writeFile(pidLine);
      } finally {
        await fd.close();
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock занят. Если он stale, пробуем снять.
      const stale = await isStale(lockPath, opts.staleMs);
      if (stale) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        // На следующей итерации попробуем создать заново. Если кто-то другой
        // нас опередил — снова получим EEXIST и проверим stale.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, opts.timeoutMs);
      }
      const jitter =
        opts.retryMinMs + Math.floor(Math.random() * (opts.retryMaxMs - opts.retryMinMs + 1));
      await sleep(jitter);
    }
  }
}

/**
 * Считает lock stale если: (a) файл нечитаем (битый), или (b) PID-владелец не живёт,
 * или (c) timestamp в lock-файле старше opts.staleMs. Это спасает от ситуации,
 * когда один процесс упал с lock'ом, и никто его не снял.
 */
async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return true;
  }
  const [pidLine, tsLine] = raw.split('\n', 2);
  const pid = Number.parseInt(pidLine ?? '', 10);
  const ts = Number.parseInt(tsLine ?? '', 10);
  if (Number.isFinite(ts) && Date.now() - ts > staleMs) return true;
  if (!Number.isFinite(pid) || pid <= 0) return true;
  // signal 0 = только проверка существования. ESRCH = процесса нет; EPERM = есть,
  // но мы не имеем прав на сигнал — значит существует, lock жив.
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FileLockTimeoutError extends Error {
  constructor(public readonly lockPath: string, public readonly timeoutMs: number) {
    super(`Failed to acquire ${lockPath} within ${timeoutMs}ms`);
    this.name = 'FileLockTimeoutError';
  }
}
