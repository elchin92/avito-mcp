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
    const path = this.path(domain);
    if (path) {
      void withFileLock(path, () => writeJsonAtomic(path, snap), {
        timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000,
      }).catch((error) => logger.warn({ error, domain }, 'failed to persist rate-limit snapshot'));
    }
    if (remaining !== undefined && limit !== undefined && remaining <= 1) {
      logger.warn({ domain, remaining, limit }, 'rate-limit nearly exhausted');
    }
    return snap;
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
