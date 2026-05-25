import { logger } from '../logger.js';

export interface RateSnapshot {
  domain: string;
  limit?: number;
  remaining?: number;
  /** unix seconds */
  resetAt?: number;
  observedAt: number;
}

/**
 * Хранит последний снимок X-RateLimit-* для каждого "домена" (логической группы tools).
 * Используется (а) для observability через meta_get_rate_limits, (б) мягкого троттлинга.
 */
export class RateLimiter {
  private snapshots = new Map<string, RateSnapshot>();

  observe(domain: string, headers: Headers): RateSnapshot {
    const limit = numberOrUndefined(headers.get('x-ratelimit-limit'));
    const remaining = numberOrUndefined(headers.get('x-ratelimit-remaining'));
    const resetRaw = headers.get('x-ratelimit-reset');
    const resetAt = resetRaw ? Number.parseInt(resetRaw, 10) : undefined;
    const snap: RateSnapshot = {
      domain,
      limit,
      remaining,
      resetAt,
      observedAt: Math.floor(Date.now() / 1000),
    };
    this.snapshots.set(domain, snap);
    if (remaining !== undefined && limit !== undefined && remaining <= 1) {
      logger.warn({ domain, remaining, limit }, 'rate-limit nearly exhausted');
    }
    return snap;
  }

  /** Если remaining <= 1 — мягко спим 1 сек, чтобы дать reset развернуться. */
  async waitIfNeeded(domain: string): Promise<void> {
    const snap = this.snapshots.get(domain);
    if (!snap || snap.remaining === undefined) return;
    if (snap.remaining <= 1) {
      await sleep(1000);
    }
  }

  getStatus(domain?: string): RateSnapshot[] {
    if (domain) {
      const s = this.snapshots.get(domain);
      return s ? [s] : [];
    }
    return [...this.snapshots.values()];
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
