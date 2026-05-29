/**
 * A simple cross-process advisory file lock for defence-in-depth on top of the
 * in-process single-flight in TokenStore. Used during OAuth refresh so that
 * multiple avito-mcp processes (e.g. an MCP client + a cron agent + a manual CLI)
 * do not refresh concurrently and hit the rate limit of Avito's /token endpoint.
 *
 * Implementation: an exclusive-create lock file (`{target}.lock`) with the PID written to it.
 * Stale detection: if the owning PID is not alive, the lock is treated as orphaned and removed.
 * Backoff: 50–150ms jitter to avoid lockstep when there are multiple contenders.
 *
 * This is an advisory mechanism. Any code that does not use withFileLock() will not see it,
 * so it only works when all processes honor the same convention.
 *
 * No dependencies are added. proper-lockfile, which is most commonly used for such tasks,
 * would pull in graceful-fs and retry — overkill here.
 */
import { promises as fs } from 'node:fs';

export interface FileLockOptions {
  /** Maximum time to wait for the lock to become free. Default 30s. */
  timeoutMs?: number;
  /** Minimum interval between attempts. Default 50ms. */
  retryMinMs?: number;
  /** Maximum interval between attempts. Default 150ms. */
  retryMaxMs?: number;
  /** Maximum age of a stale lock after which it can be removed. Default 60s. */
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
 * fn runs only once the lock has actually been acquired.
 * If the lock could not be acquired within timeoutMs, FileLockTimeoutError is thrown.
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
    // Releasing is best-effort. If the file is no longer ours (stolen via stale-cleanup),
    // that's fine: the next acquireLock will obtain a fresh lock.
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
      // wx = O_CREAT | O_EXCL — atomically creates the file; if it exists, throws EEXIST.
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
      // Lock is held. If it is stale, try to remove it.
      const stale = await isStale(lockPath, opts.staleMs);
      if (stale) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        // On the next iteration we will try to create it again. If someone else
        // beats us to it, we get EEXIST again and re-check for staleness.
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
 * Considers a lock stale if: (a) the file is unreadable (corrupted), or (b) the owning PID
 * is not alive, or (c) the timestamp in the lock file is older than opts.staleMs. This guards
 * against the case where a process crashed while holding the lock and nobody released it.
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
  // signal 0 = existence check only. ESRCH = the process is gone; EPERM = it exists,
  // but we lack permission to signal it — meaning it exists, so the lock is alive.
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
