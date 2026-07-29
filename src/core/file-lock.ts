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

import { logger } from '../logger.js';

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
const RECLAIM_MARKER = '.reclaim.json';

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
    let lostRace = false;

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
      if (!(await lockMatches(ownership, lockPath, markerPath)) || !(await soleMarker(lockPath, markerName))) {
        lostRace = true;
        throw new Error(`File lock ${lockPath} was claimed concurrently during initialization`);
      }
      return ownership;
    } catch (err) {
      if (createdDirectory) {
        if (lostRace) {
          // Our marker may be sitting inside a generation we do not own, and dev/ino
          // cannot tell us which — this filesystem hands the freed inode straight back
          // to the next mkdir. Removing the marker is always safe because its name
          // carries our nonce; removing the directory would destroy a live competitor.
          await fs.rm(markerPath, { force: true }).catch(() => undefined);
          // Only succeeds when no marker at all is left, which means nobody published.
          await fs.rmdir(lockPath).catch(() => undefined);
          if (Date.now() >= deadline) {
            throw new FileLockTimeoutError(lockPath, opts.timeoutMs);
          }
          await sleep(retryDelay(opts));
          continue;
        }
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
          // No generation marker was published. Before removeIfAbandoned() existed a
          // marker-less directory could only be ours, but it can now be reclaimed while
          // we are stalled between the mkdir and the marker write, and a successor may
          // already hold the path. Delete only what is still provably our inode.
          const ours = createdStat !== undefined && (await hasIdentity(lockPath, createdStat));
          if (ours) {
            if (markerCreated) await fs.rm(markerPath, { force: true }).catch(() => undefined);
            await fs.rmdir(lockPath).catch(() => undefined);
          } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Our lease was reclaimed underneath us, which is ordinary contention
            // rather than a failure. Retry instead of surfacing a raw ENOENT.
            if (Date.now() >= deadline) {
              throw new FileLockTimeoutError(lockPath, opts.timeoutMs);
            }
            await sleep(retryDelay(opts));
            continue;
          }
        }
        throw err;
      }

      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const stale = await staleSnapshot(lockPath, opts.staleMs);
      if (stale && (await removeIfUnchanged(lockPath, stale))) continue;
      if (await removeIfAbandoned(lockPath, opts.staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, opts.timeoutMs);
      }
      await sleep(retryDelay(opts));
    }
  }
}

function retryDelay(opts: Required<FileLockOptions>): number {
  return opts.retryMinMs + Math.floor(Math.random() * (opts.retryMaxMs - opts.retryMinMs + 1));
}

/**
 * A valid owner is stale only when its PID is gone. During a transition the
 * claimant PID owns cleanup. A partial recognized marker receives staleMs grace.
 * Legacy file-style locks fail closed because Node has no atomic compare-and-unlink
 * primitive for that shape. Directories that do not carry exactly one recognized
 * marker cannot be adjudicated here at all and are handled by removeIfAbandoned().
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

/**
 * Reclaims a lease directory whose shape cannot name an owner, so that nothing is
 * ever able to declare it stale and every later acquirer blocks until its timeout,
 * permanently. A healthy generation always publishes exactly one recognized marker,
 * so any other shape is off-protocol and unreachable for staleSnapshot():
 *
 *   - empty: the owner died between mkdir and the marker write (SIGKILL, OOM, or a
 *     parent killing the process while a persist was in flight). This shape is the
 *     one that occurs in practice, and it blocks its lease path indefinitely.
 *   - two or more markers: a process stalled past staleMs between its mkdir and its
 *     marker write, its directory was reclaimed, a successor took the path, and the
 *     stalled writer then landed its marker inside the successor's directory.
 *   - unrecognized entries only: leftovers from an interrupted external cleanup.
 *
 * Safety rests on two independent gates. Nothing is reclaimed while any marker names
 * a live process, and nothing is reclaimed until the directory and every entry have
 * been untouched for staleMs — which a healthy owner never is, because it publishes
 * its marker microseconds after mkdir and that write also bumps the directory mtime.
 *
 * The deletion itself is atomic in both branches: rmdir fails with ENOTEMPTY the
 * instant a marker appears, and rename moves the whole directory in one step, so of
 * two concurrent reclaimers exactly one wins and the loser sees ENOENT. A process
 * whose directory is reclaimed underneath it cannot silently continue either — its
 * marker open(2) resolves through the unlinked path and fails with ENOENT.
 */
async function removeIfAbandoned(lockPath: string, staleMs: number): Promise<boolean> {
  let stat: Stats;
  let entries: string[];
  try {
    stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    entries = await fs.readdir(lockPath);
  } catch {
    return false;
  }

  // Exactly one recognized marker is the healthy shape; staleSnapshot() owns it.
  const recognized = entries.filter(
    (name) => OWNER_MARKER.test(name) || TRANSITION_MARKER.test(name) || name === RECLAIM_MARKER,
  );
  if (recognized.length === 1) return false;
  if (!(await abandonedFor(lockPath, entries, stat.mtimeMs, staleMs))) return false;
  try {
    if (entries.length === 0) {
      await fs.rmdir(lockPath);
      logReclaim(lockPath, stat.mtimeMs, 'no owner marker was ever written');
      return true;
    }
    // Publish a live transition marker before moving a non-empty directory. This is
    // the compare-and-claim step: if a successor replaced the directory while the
    // checks above were awaiting, our marker lands in that successor and the entry
    // comparison fails. Once it lands in the checked generation, cooperating
    // reclaimers see our live PID and cannot replace the directory before rename.
    const claimName = RECLAIM_MARKER;
    const claimPath = join(lockPath, claimName);
    const claim = await fs.open(claimPath, 'wx', 0o600);
    try {
      await claim.writeFile(
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          createdAt: Date.now(),
          nonce: randomBytes(16).toString('hex'),
        })}\n`,
        'utf8',
      );
      await claim.sync();
    } finally {
      await claim.close();
    }
    const currentEntries = await fs.readdir(lockPath);
    if (
      currentEntries.length !== entries.length + 1 ||
      !entries.every((entry) => currentEntries.includes(entry)) ||
      !currentEntries.includes(claimName)
    ) {
      await fs.rm(claimPath, { force: true }).catch(() => undefined);
      return false;
    }
    const transitionedPath = `${lockPath}.transitioned-${randomBytes(16).toString('hex')}`;
    await fs.rename(lockPath, transitionedPath);
    await fs.rm(transitionedPath, { recursive: true, force: true }).catch(() => undefined);
    logReclaim(lockPath, stat.mtimeMs, `${recognized.length} owner markers, ${entries.length} entries`);
    return true;
  } catch {
    // ENOENT (another acquirer got there first) or ENOTEMPTY (a marker appeared
    // between the readdir and the rmdir): fall back to a normal retry.
    return false;
  }
}

/**
 * Ownership proved by content instead of by inode, which is the only proof that holds
 * here: ext4 hands a freed directory inode straight back to the next mkdir at the same
 * path — measured 200 times out of 200, against 0 out of 200 on tmpfs — so a dev/ino
 * match cannot distinguish our generation from a replacement that took the path after
 * ours was removed. A directory holding anything other than exactly our marker is not
 * ours, whatever its inode says.
 */
async function soleMarker(lockPath: string, markerName: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(lockPath);
    const recognized = entries.filter(
      (name) => OWNER_MARKER.test(name) || TRANSITION_MARKER.test(name) || name === RECLAIM_MARKER,
    );
    return recognized.length === 1 && recognized[0] === markerName;
  } catch {
    return false;
  }
}

/** Same directory, same generation — dev/ino alone would miss a reused inode. */
async function hasIdentity(lockPath: string, expected: Stats): Promise<boolean> {
  try {
    const current = await fs.lstat(lockPath);
    return (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.mtimeMs === expected.mtimeMs
    );
  } catch {
    return false;
  }
}

/**
 * A reclaim always means a process died holding this path. It is rare, it is the
 * signature of the outage this code exists to prevent, and without a log line the
 * only evidence left behind is the absence of a directory.
 *
 * The field is the basename rather than the path: `lockPath` is a redacted key, and a
 * redacted lease tells an operator nothing. A basename is either a state hash or a
 * token file name, so it identifies the lease without disclosing where state lives.
 */
function logReclaim(lockPath: string, mtimeMs: number, reason: string): void {
  logger.warn(
    { lease: basename(lockPath), ageMs: Math.round(Date.now() - mtimeMs), reason },
    'reclaimed an abandoned file lease',
  );
}

/** True when no entry names a live process and nothing here has been touched for staleMs. */
async function abandonedFor(
  lockPath: string,
  entries: string[],
  directoryMtimeMs: number,
  staleMs: number,
): Promise<boolean> {
  let newestMtimeMs = directoryMtimeMs;
  for (const name of entries) {
    let entryStat: Stats;
    try {
      entryStat = await fs.lstat(join(lockPath, name));
    } catch {
      // The entry vanished mid-check, so someone is actively working in here.
      return false;
    }
    newestMtimeMs = Math.max(newestMtimeMs, entryStat.mtimeMs);
    const pid = await entryOwnerPid(lockPath, name, entryStat);
    if (pid !== undefined && processIsAlive(pid)) return false;
  }
  return Date.now() - newestMtimeMs > staleMs;
}

/** The process an entry claims, when it can be read; undefined leaves the age gate in charge. */
async function entryOwnerPid(
  lockPath: string,
  name: string,
  entryStat: Stats,
): Promise<number | undefined> {
  const transition = TRANSITION_MARKER.exec(name);
  if (transition) return Number(transition[1]);
  if (name === RECLAIM_MARKER && entryStat.isFile() && !entryStat.isSymbolicLink()) {
    try {
      return parseRecord(await fs.readFile(join(lockPath, name), 'utf8'))?.pid;
    } catch {
      return undefined;
    }
  }
  if (!OWNER_MARKER.test(name) || !entryStat.isFile() || entryStat.isSymbolicLink()) {
    return undefined;
  }
  try {
    return parseRecord(await fs.readFile(join(lockPath, name), 'utf8'))?.pid;
  } catch {
    return undefined;
  }
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
    (name) => OWNER_MARKER.test(name) || TRANSITION_MARKER.test(name) || name === RECLAIM_MARKER,
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
  if (markerName === RECLAIM_MARKER) snapshot.claimantPid = snapshot.record?.pid;
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
