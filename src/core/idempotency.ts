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
 * Without stateDir/namespace the store is process-local. With them it uses
 * locked, durable JSON records shared by stdio processes in the same namespace.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { withFileLock } from './file-lock.js';
import {
  readJsonFile,
  removeFileDurable,
  safeStatePart,
  writeJsonAtomic,
} from './runtime-state.js';

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
  promise: Promise<IdempotencyEntry>;
}

interface PersistentRecord {
  version: 1;
  state: 'in_flight' | 'completed';
  key: string;
  toolName: string;
  argsHash: string;
  createdAt: number;
  expiresAt: number;
  ownerPid?: number;
  result?: CallToolResult;
}

export interface IdempotencyStoreOptions {
  stateDir?: string;
  namespace?: string;
  lockTimeoutMs?: number;
}

export interface IdempotencyRetentionOptions {
  /** Keep an expired entry while an external lifecycle (for example confirmation) is active. */
  retainExpired?: (entry: IdempotencyEntry) => boolean;
  /** Cross-process equivalent used before removing an expired durable record. */
  retainExpiredPersistent?: (entry: IdempotencyEntry) => boolean | Promise<boolean>;
  /** Fail closed unless a cached result is still safe and useful to replay. */
  replayAllowed?: (entry: IdempotencyEntry) => boolean | Promise<boolean>;
}

export class IdempotencyConflictError extends Error {
  constructor(key: string, toolName: string) {
    const safeKey = storedIdempotencyKey(key);
    super(
      `Idempotency conflict: key '${safeKey}' was already used for tool '${toolName}' with different arguments. ` +
        `Use a fresh idempotencyKey or repeat the call with identical arguments to get the cached result.`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyLimitError extends Error {
  constructor(public readonly maxEntries: number) {
    super(
      `Idempotency ledger capacity reached (${maxEntries}); wait for an in-flight operation to finish ` +
        'or for an existing entry to expire before using a new idempotency key.',
    );
    this.name = 'IdempotencyLimitError';
  }
}

export class IdempotencyRecoveryRequiredError extends Error {
  constructor(key: string, toolName: string) {
    super(
      `Idempotency key '${storedIdempotencyKey(key)}' for '${toolName}' has an unfinished durable reservation. ` +
        'The previous process may have received an upstream result before it stopped. Refusing to repeat the action; reconcile the remote operation first.',
    );
    this.name = 'IdempotencyRecoveryRequiredError';
  }
}

export class IdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();
  private reservations = new Map<string, IdempotencyReservation>();
  private retainExpired = new Map<
    string,
    NonNullable<IdempotencyRetentionOptions['retainExpired']>
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = 10_000,
    private readonly options: IdempotencyStoreOptions = {},
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('IdempotencyStore maxEntries must be a positive safe integer');
    }
  }

  async rememberPersistent(
    key: string,
    toolName: string,
    argsHash: string,
    result: CallToolResult,
    options: IdempotencyRetentionOptions = {},
  ): Promise<IdempotencyEntry> {
    const entry = this.remember(key, toolName, argsHash, result, options);
    const path = this.persistentPath(toolName, key);
    if (path) {
      await withFileLock(
        path,
        async () => {
          await writeJsonAtomic(path, this.toPersistent(entry));
        },
        { timeoutMs: this.options.lockTimeoutMs ?? 30_000 },
      );
    }
    return entry;
  }

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
    options: IdempotencyRetentionOptions = {},
  ): IdempotencyEntry {
    this.cleanupExpired();
    const composed = this.composeKey(toolName, key);
    this.assertCapacity(composed);
    const now = Date.now();
    const entry: IdempotencyEntry = {
      key: storedIdempotencyKey(key),
      toolName,
      argsHash,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      result,
    };
    // Replace an existing reservation/entry in the same logical slot. No code can
    // interleave between these synchronous map operations.
    this.reservations.delete(composed);
    this.entries.set(composed, entry);
    if (options.retainExpired) this.retainExpired.set(composed, options.retainExpired);
    else this.retainExpired.delete(composed);
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
    options: IdempotencyRetentionOptions = {},
  ): Promise<{ entry: IdempotencyEntry; replay: boolean }> {
    const persistentPath = this.persistentPath(toolName, key);
    if (persistentPath) {
      return withFileLock(
        persistentPath,
        async () => {
          const record = await readJsonFile<PersistentRecord>(persistentPath);
          const now = Date.now();
          if (record && record.argsHash !== argsHash) {
            throw new IdempotencyConflictError(key, toolName);
          }
          if (record?.state === 'completed' && record.result) {
            const entry = this.fromPersistent(record);
            const retained =
              record.expiresAt >= now || (await this.isExpiredReplayRetained(entry, options));
            if (retained && (await this.isReplayAllowed(entry, options))) {
              this.entries.set(this.composeKey(toolName, key), entry);
              return { entry, replay: true };
            }
          }
          if (record?.state === 'in_flight') {
            throw new IdempotencyRecoveryRequiredError(key, toolName);
          }
          if (record) {
            this.entries.delete(this.composeKey(toolName, key));
            this.retainExpired.delete(this.composeKey(toolName, key));
            await removeFileDurable(persistentPath);
          }

          const reservation: PersistentRecord = {
            version: 1,
            state: 'in_flight',
            key: storedIdempotencyKey(key),
            toolName,
            argsHash,
            createdAt: now,
            expiresAt: now + this.ttlMs,
            ownerPid: process.pid,
          };
          await writeJsonAtomic(persistentPath, reservation);
          try {
            const result = await execute();
            const entry = this.remember(key, toolName, argsHash, result, options);
            await writeJsonAtomic(persistentPath, this.toPersistent(entry));
            return { entry, replay: false };
          } catch (error) {
            // A caught application failure means no usable result was produced. A hard
            // process stop never reaches this branch, leaving the reservation fail-closed.
            await fs.rm(persistentPath, { force: true });
            throw error;
          }
        },
        { timeoutMs: this.options.lockTimeoutMs ?? 30_000 },
      );
    }

    const composed = this.composeKey(toolName, key);
    this.cleanupExpired();

    const cached = this.entries.get(composed);
    if (cached) {
      if (cached.argsHash !== argsHash) throw new IdempotencyConflictError(key, toolName);
      if (await this.isReplayAllowed(cached, options)) {
        return { entry: cached, replay: true };
      }
      this.entries.delete(composed);
      this.retainExpired.delete(composed);
    }

    const existing = this.reservations.get(composed);
    if (existing) {
      if (existing.argsHash !== argsHash) throw new IdempotencyConflictError(key, toolName);
      return { entry: await existing.promise, replay: true };
    }

    // Capacity is checked before execute() is invoked. Never evict a completed
    // entry to make room: doing so could permit a duplicate destructive action.
    this.assertCapacity(composed);
    let resolveReservation!: (entry: IdempotencyEntry) => void;
    let rejectReservation!: (reason: unknown) => void;
    const promise = new Promise<IdempotencyEntry>((resolve, reject) => {
      resolveReservation = resolve;
      rejectReservation = reject;
    });
    this.reservations.set(composed, { argsHash, promise });
    void (async () => {
      try {
        const result = await execute();
        resolveReservation(this.remember(key, toolName, argsHash, result, options));
      } catch (err) {
        this.reservations.delete(composed);
        rejectReservation(err);
      }
    })();
    return { entry: await promise, replay: false };
  }

  /**
   * Removes the entry for (toolName, key), if any. Used to evict a stale
   * "requires_confirmation" replay once its pending action is cancelled/expired,
   * so a fresh retry with the same key is not wedged on a dead confirmation_id.
   */
  delete(key: string, toolName: string): boolean {
    const composed = this.composeKey(toolName, key);
    this.retainExpired.delete(composed);
    return this.entries.delete(composed);
  }

  size(): number {
    this.cleanupExpired();
    return this.entries.size + this.reservations.size;
  }

  /** For tests / meta_*. */
  list(): Array<Omit<IdempotencyEntry, 'result'>> {
    this.cleanupExpired();
    return [...this.entries.values()].map(({ result: _result, ...rest }) => rest);
  }

  private composeKey(toolName: string, key: string): string {
    return `${toolName}::${fingerprintIdempotencyKey(key)}`;
  }

  private persistentPath(toolName: string, key: string): string | undefined {
    if (!this.options.stateDir || !this.options.namespace) return undefined;
    return join(
      this.options.stateDir,
      this.options.namespace,
      'idempotency',
      safeStatePart(toolName),
      `${fingerprintIdempotencyKey(key)}.json`,
    );
  }

  private toPersistent(entry: IdempotencyEntry): PersistentRecord {
    return { version: 1, state: 'completed', ...entry };
  }

  private fromPersistent(record: PersistentRecord): IdempotencyEntry {
    return {
      key: record.key,
      toolName: record.toolName,
      argsHash: record.argsHash,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      result: record.result!,
    };
  }

  private async isReplayAllowed(
    entry: IdempotencyEntry,
    options: IdempotencyRetentionOptions,
  ): Promise<boolean> {
    if (!options.replayAllowed) return true;
    try {
      return await options.replayAllowed(entry);
    } catch {
      // A lifecycle-check failure must never reopen a destructive slot.
      return true;
    }
  }

  private async isExpiredReplayRetained(
    entry: IdempotencyEntry,
    options: IdempotencyRetentionOptions,
  ): Promise<boolean> {
    if (!options.retainExpiredPersistent) return false;
    try {
      return await options.retainExpiredPersistent(entry);
    } catch {
      // An uncertain lifecycle must keep the destructive slot closed.
      return true;
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt >= now) continue;
      const retain = this.retainExpired.get(k);
      let active = false;
      if (retain) {
        try {
          active = retain(e);
        } catch {
          // A lifecycle check failure must not reopen a destructive slot.
          active = true;
        }
      }
      if (!active) {
        this.entries.delete(k);
        this.retainExpired.delete(k);
      }
    }
    // Active reservations deliberately have no TTL. Removing one before its
    // promise settles would allow a second mutation to run under the same key.
  }

  private assertCapacity(composed: string): void {
    if (this.entries.has(composed) || this.reservations.has(composed)) return;
    if (this.entries.size + this.reservations.size >= this.maxEntries) {
      throw new IdempotencyLimitError(this.maxEntries);
    }
  }
}

/** A fixed-size namespace key for the in-memory ledger and safe diagnostic logging. */
export function fingerprintIdempotencyKey(key: string): string {
  return createHash('sha256').update('avito-mcp:idempotency-key:v1\0').update(key).digest('hex');
}

function storedIdempotencyKey(key: string): string {
  return Buffer.byteLength(key, 'utf8') <= 256 ? key : `sha256:${fingerprintIdempotencyKey(key)}`;
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
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
