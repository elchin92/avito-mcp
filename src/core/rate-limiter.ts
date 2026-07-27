import { logger } from '../logger.js';
import { join } from 'node:path';
import { withFileLock } from './file-lock.js';
import { readJsonFile, safeStatePart, writeJsonAtomic } from './runtime-state.js';

export interface RateSnapshot {
  domain: string;
  limit?: number;
  remaining?: number;
  /** unix seconds */
  resetAt?: number;
  observedAt: number;
}

/**
 * Stores the latest X-RateLimit-* snapshot for each "domain" (a logical group of tools).
 * Used (a) for observability via meta_get_rate_limits, and (b) for soft throttling.
 */
export class RateLimiter {
  private snapshots = new Map<string, RateSnapshot>();
  /** Newest snapshot still waiting to be written, per path. A newer one replaces it. */
  private queued = new Map<string, RateSnapshot>();
  /** The single drain running for a path, so only one lock attempt is ever in flight. */
  private draining = new Map<string, Promise<void>>();

  constructor(
    private readonly persistent?: { stateDir: string; namespace: string; lockTimeoutMs?: number },
  ) {}

  observe(domain: string, headers: Headers, displayDomain: string = domain): RateSnapshot {
    const limit = numberOrUndefined(headers.get('x-ratelimit-limit'));
    const remaining = numberOrUndefined(headers.get('x-ratelimit-remaining'));
    const resetRaw = headers.get('x-ratelimit-reset');
    const resetAt = resetRaw ? Number.parseInt(resetRaw, 10) : undefined;
    const snap: RateSnapshot = {
      domain: displayDomain,
      limit,
      remaining,
      resetAt,
      observedAt: Math.floor(Date.now() / 1000),
    };
    this.snapshots.set(domain, snap);
    // Most Avito endpoints send no X-RateLimit-* headers at all. Persisting those
    // observations costs a lease and a write to record nothing: waitIfNeeded() treats a
    // snapshot without `remaining` exactly like a missing file. Keeping them out of the
    // queue removes the majority of lease traffic, and getStatus() still sees them
    // because the in-memory map above is written unconditionally.
    const observedAnyLimit =
      limit !== undefined || remaining !== undefined || Number.isFinite(resetAt);
    const path = observedAnyLimit ? this.path(domain) : undefined;
    if (path) this.persistLater(path, snap);
    if (remaining !== undefined && limit !== undefined && remaining <= 1) {
      logger.warn({ domain, remaining, limit }, 'rate-limit nearly exhausted');
    }
    return snap;
  }

  /**
   * Queues the snapshot for persistence instead of firing an unawaited withFileLock()
   * per response. observe() stays synchronous — its caller is on the request path and
   * must not wait up to lockTimeoutMs for a file write — but the writes it produces are
   * now bounded and ordered rather than unbounded and racing.
   *
   * Every response used to start its own lock acquisition, so a burst put N of them in
   * flight against the same file at once: they contended with each other, each opened a
   * fresh mkdir/marker window, and any of those windows could be cut by a SIGKILL or an
   * OOM kill and leave a wedged lease directory behind. Coalescing collapses a burst to
   * at most one write in flight plus one pending, and the pending slot always holds the
   * newest snapshot, so a delayed write can no longer land after a newer one.
   */
  private persistLater(path: string, snap: RateSnapshot): void {
    this.queued.set(path, snap);
    if (this.draining.has(path)) return;
    // drain() runs synchronously up to its first await, which is inside withFileLock,
    // so the entry just queued is consumed and the drain is registered below before any
    // other observe() can run and start a second drain for this path.
    const drain = this.drain(path);
    this.draining.set(path, drain);
  }

  private async drain(path: string): Promise<void> {
    try {
      for (;;) {
        const snap = this.queued.get(path);
        if (!snap) return;
        this.queued.delete(path);
        try {
          // A telemetry write does not deserve the full 30s request lease: capping it
          // keeps a contended file from stretching shutdown and bounds how long this
          // process leaves a lease directory of its own open.
          await withFileLock(path, () => writeJsonAtomic(path, snap), {
            timeoutMs: Math.min(this.persistent?.lockTimeoutMs ?? 30_000, 5_000),
          });
        } catch (error) {
          logger.warn(
            { error, domain: snap.domain },
            'failed to persist rate-limit snapshot',
          );
        }
      }
    } finally {
      // Deregistering in the same tick as the loop exit leaves no window in which a
      // concurrent observe() would skip starting a drain for an unwritten snapshot.
      this.draining.delete(path);
    }
  }

  /**
   * Resolves once every queued snapshot has been written. Call before exiting: a
   * process that dies mid-acquisition leaves a lease directory nobody can reclaim
   * until it ages past staleMs.
   */
  async flushPersisted(): Promise<void> {
    while (this.draining.size > 0) {
      await Promise.allSettled([...this.draining.values()]);
    }
  }

  /** If remaining <= 1, sleep softly for 1 second to let the reset window unfold. */
  async waitIfNeeded(domain: string): Promise<void> {
    const path = this.path(domain);
    if (!path) {
      const snap = this.snapshots.get(domain);
      if (snap?.remaining !== undefined && snap.remaining <= 1) await sleep(1000);
      return;
    }
    while (true) {
      const delay = await withFileLock(
        path,
        async () => {
          const snap = await readJsonFile<RateSnapshot>(path);
          if (!snap || snap.remaining === undefined) return 0;
          const now = Math.floor(Date.now() / 1000);
          if (snap.resetAt === undefined && now > snap.observedAt) {
            const stale = { ...snap, remaining: undefined, observedAt: now };
            await writeJsonAtomic(path, stale);
            this.snapshots.set(domain, stale);
            return 0;
          }
          if (snap.resetAt !== undefined && snap.resetAt <= now) {
            const refreshed = { ...snap, remaining: Math.max(0, (snap.limit ?? 1) - 1), observedAt: now };
            await writeJsonAtomic(path, refreshed);
            this.snapshots.set(domain, refreshed);
            return 0;
          }
          if (snap.remaining > 1) {
            const reserved = { ...snap, remaining: snap.remaining - 1 };
            await writeJsonAtomic(path, reserved);
            this.snapshots.set(domain, reserved);
            return 0;
          }
          return snap.resetAt && snap.resetAt > now ? (snap.resetAt - now) * 1000 : 1000;
        },
        { timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000 },
      );
      if (delay === 0) return;
      await sleep(Math.min(delay, 30_000));
    }
  }

  getStatus(domain?: string): RateSnapshot[] {
    if (domain) {
      const s = this.snapshots.get(domain);
      return s ? [s] : [];
    }
    return [...this.snapshots.values()];
  }

  async getSharedStatus(domain?: string): Promise<RateSnapshot[]> {
    if (!this.persistent) return this.getStatus(domain);
    if (domain) {
      const snapshot = await readJsonFile<RateSnapshot>(this.path(domain)!);
      return snapshot ? [snapshot] : [];
    }
    const directory = join(this.persistent.stateDir, this.persistent.namespace, 'rate-limits');
    let names: string[];
    try {
      names = await import('node:fs').then(({ promises }) => promises.readdir(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows = await Promise.all(
      names.filter((name) => name.endsWith('.json')).map((name) => readJsonFile<RateSnapshot>(join(directory, name))),
    );
    return rows.filter((row): row is RateSnapshot => row !== undefined);
  }

  private path(domain: string): string | undefined {
    if (!this.persistent) return undefined;
    return join(
      this.persistent.stateDir,
      this.persistent.namespace,
      'rate-limits',
      `${safeStatePart(domain)}.json`,
    );
  }
}

function numberOrUndefined(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
