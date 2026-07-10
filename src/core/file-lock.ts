/**
 * A cross-process advisory lease used by TokenStore during OAuth refresh.
 *
 * The canonical `{target}.lock` path is a private directory containing one
 * generation-specific owner marker. Release and stale cleanup first rename that
 * marker to a transition marker, then move the whole directory to a unique path
 * before deleting it. The marker rename is the atomic ownership claim: a delayed
 * cleaner cannot claim a replacement generation because its marker has a
 * different name.
 *
 * This remains advisory. Every cooperating process must use withFileLock().
 */
import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface FileLockOptions {
  /** Maximum time to wait for the lock to become free. Default 30s. */
  timeoutMs?: number;
  /** Minimum interval between attempts. Default 50ms. */
  retryMinMs?: number;
  /** Maximum interval between attempts. Default 150ms. */
  retryMaxMs?: number;
  /** Grace age before a partial marker can be reclaimed. Default 60s. */
  staleMs?: number;
}

interface LockRecord {
  version: 1;
  pid: number;
  createdAt: number;
  nonce: string;
}

interface LockSnapshot {
  dev: number;
  ino: number;
  mtimeMs: number;
  directory: boolean;
  markerName?: string;
  markerMtimeMs?: number;
  raw?: string;
  record?: Pick<LockRecord, 'pid' | 'createdAt'> & { nonce?: string };
  claimantPid?: number;
}

interface LockOwnership extends LockSnapshot {
  directory: true;
  markerName: string;
  raw: string;
  record: LockRecord;
}

const OWNER_MARKER = /^owner-([0-9a-f]{32})\.json$/;
const TRANSITION_MARKER = /^\.transition-(\d+)-([0-9a-f]{32})\.json$/;

const DEFAULTS: Required<FileLockOptions> = {
  timeoutMs: 30_000,
  retryMinMs: 50,
  retryMaxMs: 150,
  staleMs: 60_000,
};

/**
 * Acquires `${target}.lock`, runs fn(), then releases it.
 * fn runs only after the lease has been acquired.
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + opts.timeoutMs;

  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownership = await acquireLock(lockPath, deadline, opts);
  try {
    return await fn();
  } finally {
    await removeIfUnchanged(lockPath, ownership).catch(() => false);
  }
}

async function acquireLock(
  lockPath: string,
  deadline: number,
  opts: Required<FileLockOptions>,
): Promise<LockOwnership> {
  while (true) {
    const record: LockRecord = {
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
      nonce: randomBytes(16).toString('hex'),
    };
    const raw = `${JSON.stringify(record)}\n`;
    const markerName = `owner-${record.nonce}.json`;
    const markerPath = join(lockPath, markerName);
    let createdDirectory = false;
    let createdStat: Stats | undefined;
    let markerCreated = false;

    try {
      // mkdir is the atomic publication of a new lease generation.
      await fs.mkdir(lockPath, { mode: 0o700 });
      createdDirectory = true;
      createdStat = await fs.lstat(lockPath);

      const marker = await fs.open(markerPath, 'wx', 0o600);
      markerCreated = true;
      try {
        await marker.writeFile(raw, 'utf8');
        await marker.sync();
      } finally {
        await marker.close();
      }

      const ownership: LockOwnership = {
        dev: createdStat.dev,
        ino: createdStat.ino,
        mtimeMs: createdStat.mtimeMs,
        directory: true,
        markerName,
        raw,
        record,
      };
      if (!(await lockMatches(ownership, lockPath, markerPath))) {
        throw new Error(`File lock ${lockPath} changed during initialization`);
      }
      return ownership;
    } catch (err) {
      if (createdDirectory) {
        if (createdStat && markerCreated) {
          const partial: LockSnapshot = {
            dev: createdStat.dev,
            ino: createdStat.ino,
            mtimeMs: createdStat.mtimeMs,
            directory: true,
            markerName,
            raw,
            record,
          };
          await removeIfUnchanged(lockPath, partial).catch(() => false);
        } else {
          // No generation marker was published, so the directory can only be ours.
          if (markerCreated) await fs.rm(markerPath, { force: true }).catch(() => undefined);
          await fs.rmdir(lockPath).catch(() => undefined);
        }
        throw err;
      }

      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const stale = await staleSnapshot(lockPath, opts.staleMs);
      if (stale && (await removeIfUnchanged(lockPath, stale))) continue;
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
 * A valid owner is stale only when its PID is gone. During a transition the
 * claimant PID owns cleanup. A partial recognized marker receives staleMs grace.
 * Legacy file-style locks and marker-less directories fail closed because Node
 * has no atomic compare-and-unlink primitive for those shapes.
 */
async function staleSnapshot(lockPath: string, staleMs: number): Promise<LockSnapshot | undefined> {
  const snapshot = await readSnapshot(lockPath);
  if (!snapshot?.directory || !snapshot.markerName || snapshot.raw === undefined) return undefined;
  if (snapshot.claimantPid !== undefined) {
    return processIsAlive(snapshot.claimantPid) ? undefined : snapshot;
  }
  if (snapshot.record) {
    return processIsAlive(snapshot.record.pid) ? undefined : snapshot;
  }
  const ageBase = Math.max(snapshot.mtimeMs, snapshot.markerMtimeMs ?? 0);
  return Date.now() - ageBase > staleMs ? snapshot : undefined;
}

async function readSnapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  let stat: Stats;
  try {
    stat = await fs.lstat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  const snapshot: LockSnapshot = {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    directory: stat.isDirectory() && !stat.isSymbolicLink(),
  };

  if (!snapshot.directory) {
    // Parse old file-style locks only to recognize their owner. They are never
    // auto-removed: doing so would reintroduce the compare/unlink race.
    if (stat.isFile() && !stat.isSymbolicLink()) {
      try {
        snapshot.raw = await fs.readFile(lockPath, 'utf8');
        snapshot.record = parseRecord(snapshot.raw);
      } catch {
        // Fail closed on an unreadable legacy lock.
      }
    }
    return snapshot;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(lockPath);
  } catch {
    return snapshot;
  }
  const markerNames = entries.filter(
    (name) => OWNER_MARKER.test(name) || TRANSITION_MARKER.test(name),
  );
  if (markerNames.length !== 1) return snapshot;

  const markerName = markerNames[0]!;
  const markerPath = join(lockPath, markerName);
  try {
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return snapshot;
    snapshot.markerName = markerName;
    snapshot.markerMtimeMs = markerStat.mtimeMs;
    snapshot.raw = await fs.readFile(markerPath, 'utf8');
    snapshot.record = parseRecord(snapshot.raw);
  } catch {
    return snapshot;
  }

  const owner = OWNER_MARKER.exec(markerName);
  if (owner && snapshot.record?.nonce !== owner[1]) {
    snapshot.record = undefined;
  }
  const transition = TRANSITION_MARKER.exec(markerName);
  if (transition) snapshot.claimantPid = Number(transition[1]);
  return snapshot;
}

function parseRecord(raw: string): LockSnapshot['record'] {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (
      parsed.version === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid! > 0 &&
      Number.isFinite(parsed.createdAt) &&
      typeof parsed.nonce === 'string' &&
      /^[0-9a-f]{32}$/.test(parsed.nonce)
    ) {
      return { pid: parsed.pid!, createdAt: parsed.createdAt!, nonce: parsed.nonce };
    }
  } catch {
    // Fall through to the legacy two-line format.
  }
  const [pidLine, tsLine] = raw.split('\n', 2);
  const pid = Number.parseInt(pidLine ?? '', 10);
  const createdAt = Number.parseInt(tsLine ?? '', 10);
  if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(createdAt)) {
    return { pid, createdAt };
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function lockMatches(
  expected: LockSnapshot,
  lockPath: string,
  markerPath: string,
): Promise<boolean> {
  try {
    const current = await fs.lstat(lockPath);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      return false;
    }
    return expected.raw === undefined || (await fs.readFile(markerPath, 'utf8')) === expected.raw;
  } catch {
    return false;
  }
}

/** Atomically claims this generation, moves it aside, then deletes only that path. */
async function removeIfUnchanged(lockPath: string, expected: LockSnapshot): Promise<boolean> {
  if (!expected.directory || !expected.markerName || expected.raw === undefined) return false;

  const markerPath = join(lockPath, expected.markerName);
  if (!(await lockMatches(expected, lockPath, markerPath))) return false;

  const transitionId = randomBytes(16).toString('hex');
  const claimedName = `.transition-${process.pid}-${transitionId}.json`;
  const claimedPath = join(lockPath, claimedName);
  try {
    // This rename is the compare-and-claim operation. A successor generation has
    // a different owner marker, so a delayed release receives ENOENT here.
    await fs.rename(markerPath, claimedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const claimed: LockSnapshot = {
    ...expected,
    markerName: claimedName,
    claimantPid: process.pid,
  };
  if (!(await lockMatches(claimed, lockPath, claimedPath))) {
    throw new Error(`File lock ${lockPath} changed after transition claim`);
  }

  const transitionedPath = `${lockPath}.transitioned-${transitionId}`;
  await fs.rename(lockPath, transitionedPath);
  const transitionedMarker = join(transitionedPath, basename(claimedPath));
  if (!(await lockMatches(claimed, transitionedPath, transitionedMarker))) {
    throw new Error(`File lock ${lockPath} identity changed during transition`);
  }
  await fs.rm(transitionedPath, { recursive: true, force: true });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FileLockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly timeoutMs: number,
  ) {
    super(`Failed to acquire ${lockPath} within ${timeoutMs}ms`);
    this.name = 'FileLockTimeoutError';
  }
}
