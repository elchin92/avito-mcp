/**
 * Idempotency ledger (v0.7.0). Optionally protects destructive tools
 * (risk='write' | 'money' | 'public') from re-execution after a retry / crash /
 * race condition between multiple agents.
 *
 * Contract:
 *   - The agent passes `idempotencyKey: string` in args
 *   - On the first call: the tool runs, and the result is remembered under (key, hash)
 *   - On a repeated call with the same key and the same args within the TTL:
 *     the cached result is returned, flagged with `idempotent_replay: true`
 *   - On a repeated call with the same key but different args: ConflictError → the agent
 *     sees a clear error and does not get "the same result for different args"
 *
 * The design is intentionally in-memory. Persistent / shared backends (file, Redis, etc.)
 * are out of scope for a general-purpose package: different users will want different ones.
 * We document this as an extension point.
 */
import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface IdempotencyEntry {
  key: string;
  toolName: string;
  argsHash: string;
  createdAt: number;
  expiresAt: number;
  result: CallToolResult;
}

interface IdempotencyReservation {
  argsHash: string;
  expiresAt: number;
  promise: Promise<IdempotencyEntry>;
}

export class IdempotencyConflictError extends Error {
  constructor(key: string, toolName: string) {
    super(
      `Idempotency conflict: key '${key}' was already used for tool '${toolName}' with different arguments. ` +
        `Use a fresh idempotencyKey or repeat the call with identical arguments to get the cached result.`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();
  private reservations = new Map<string, IdempotencyReservation>();

  constructor(private readonly ttlMs: number) {}

  /**
   * If an entry for `key` exists and it is for the same tool+args, returns it.
   * If it is for different args, throws IdempotencyConflictError.
   * If none exists, returns undefined (the caller must run the tool and record it).
   */
  lookup(key: string, toolName: string, argsHash: string): IdempotencyEntry | undefined {
    this.cleanupExpired();
    const e = this.entries.get(this.composeKey(toolName, key));
    if (!e) return undefined;
    if (e.argsHash !== argsHash) {
      throw new IdempotencyConflictError(key, toolName);
    }
    return e;
  }

  /**
   * Stores the result under (toolName, key). Overwrites expired entries.
   * Returns the fresh entry.
   */
  remember(
    key: string,
    toolName: string,
    argsHash: string,
    result: CallToolResult,
  ): IdempotencyEntry {
    const now = Date.now();
    const entry: IdempotencyEntry = {
      key,
      toolName,
      argsHash,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      result,
    };
    this.entries.set(this.composeKey(toolName, key), entry);
    this.reservations.delete(this.composeKey(toolName, key));
    return entry;
  }

  /**
   * Atomically runs the operation for a new (toolName, key), or waits for the
   * already in-flight operation with the same args. This closes the lookup →
   * execute → remember race for concurrent destructive calls in one process.
   */
  async runExclusive(
    key: string,
    toolName: string,
    argsHash: string,
    execute: () => Promise<CallToolResult>,
  ): Promise<{ entry: IdempotencyEntry; replay: boolean }> {
    const composed = this.composeKey(toolName, key);
    this.cleanupExpired();

    const cached = this.entries.get(composed);
    if (cached) {
      if (cached.argsHash !== argsHash) throw new IdempotencyConflictError(key, toolName);
      return { entry: cached, replay: true };
    }

    const existing = this.reservations.get(composed);
    if (existing) {
      if (existing.argsHash !== argsHash) throw new IdempotencyConflictError(key, toolName);
      return { entry: await existing.promise, replay: true };
    }

    const now = Date.now();
    const promise = (async () => {
      try {
        const result = await execute();
        return this.remember(key, toolName, argsHash, result);
      } catch (err) {
        this.reservations.delete(composed);
        throw err;
      }
    })();
    this.reservations.set(composed, {
      argsHash,
      expiresAt: now + this.ttlMs,
      promise,
    });
    return { entry: await promise, replay: false };
  }

  /**
   * Removes the entry for (toolName, key), if any. Used to evict a stale
   * "requires_confirmation" replay once its pending action is cancelled/expired,
   * so a fresh retry with the same key is not wedged on a dead confirmation_id.
   */
  delete(key: string, toolName: string): boolean {
    return this.entries.delete(this.composeKey(toolName, key));
  }

  size(): number {
    this.cleanupExpired();
    return this.entries.size;
  }

  /** For tests / meta_*. */
  list(): Array<Omit<IdempotencyEntry, 'result'>> {
    this.cleanupExpired();
    return [...this.entries.values()].map(({ result: _result, ...rest }) => rest);
  }

  private composeKey(toolName: string, key: string): string {
    return `${toolName}::${key}`;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt < now) this.entries.delete(k);
    }
    for (const [k, r] of this.reservations) {
      if (r.expiresAt < now) this.reservations.delete(k);
    }
  }
}

/**
 * Stable hash of the arguments. JSON.stringify does not guarantee key order,
 * so we sort recursively. Used only to compare "same args or not",
 * not for cryptography — sha256 here is just a short, stable representation.
 */
export function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}
