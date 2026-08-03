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
import type { CallToolResult } from '@modelcontextprotocol/server';
import { logger } from '../logger.js';
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

/**
 * A reservation kept ON PURPOSE after its operation failed, because the failure
 * did not tell us whether the upstream mutation happened.
 *
 * It is not an entry (there is no result to replay) and not a reservation (no
 * promise is still running). It is a refusal with an expiry date.
 */
interface IdempotencyHold {
  key: string;
  toolName: string;
  argsHash: string;
  heldAt: number;
  expiresAt: number;
}

interface PersistentRecord {
  version: 1;
  /**
   * `in_flight`   — a reservation whose owning process never came back. Never expires:
   *                 a hard stop leaves no evidence at all, so it stays fail-closed.
   * `completed`   — a remembered result, replayable until `expiresAt`.
   * `indeterminate` — {@link IdempotencyHold}: the request WAS dispatched and the
   *                 outcome is unknown. Refused until `expiresAt`, then swept.
   */
  state: 'in_flight' | 'completed' | 'indeterminate';
  key: string;
  toolName: string;
  argsHash: string;
  createdAt: number;
  expiresAt: number;
  ownerPid?: number;
  result?: CallToolResult;
  /** Why an `indeterminate` record exists, for the operator reading the file. */
  heldReason?: string;
  heldAt?: number;
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

/**
 * The family of refusals that all say the same thing: an upstream mutation may
 * ALREADY have happened under this key, so the server will not run it again.
 *
 * They are deliberate policy answers, not malfunctions, and
 * {@link import('./errors.js').errorToMcpContent} has a branch for the base
 * class so the agent is told the reason instead of `INTERNAL_ERROR`.
 */
export class IdempotencyReconcileRequiredError extends Error {
  constructor(
    message: string,
    /** Machine-readable cause, surfaced in the error envelope. */
    readonly reason: 'unfinished_reservation' | 'cancelled_after_dispatch',
    /** When the refusal lifts by itself, if it ever does. */
    readonly heldUntil?: number,
  ) {
    super(message);
    this.name = 'IdempotencyReconcileRequiredError';
  }
}

export class IdempotencyRecoveryRequiredError extends IdempotencyReconcileRequiredError {
  constructor(key: string, toolName: string) {
    super(
      `Idempotency key '${storedIdempotencyKey(key)}' for '${toolName}' has an unfinished durable reservation. ` +
        'The previous process may have received an upstream result before it stopped. Refusing to repeat the action; reconcile the remote operation first.',
      'unfinished_reservation',
    );
    this.name = 'IdempotencyRecoveryRequiredError';
  }
}

/**
 * The caller went away AFTER the request had already been handed to Avito.
 *
 * Whether the mutation applied is unknowable from here — that is the whole
 * point — so the key is refused rather than replayed or re-run. Unlike
 * `in_flight`, this refusal expires: it was produced by a live process that
 * recorded exactly what it knew, so it earns a bounded lifetime.
 */
export class IdempotencyHeldError extends IdempotencyReconcileRequiredError {
  constructor(key: string, toolName: string, heldUntil: number) {
    super(
      `Idempotency key '${storedIdempotencyKey(key)}' for '${toolName}' is held: the previous call was cancelled ` +
        'AFTER its request had already been sent to Avito, so the operation may have taken effect. ' +
        'Refusing to repeat it. Check the operation on the Avito side; the hold lifts by itself at ' +
        `${new Date(heldUntil).toISOString()}, and an operator can lift it sooner (see docs/safety.md). ` +
        'Use a fresh idempotencyKey only if you have confirmed the previous attempt did NOT apply.',
      'cancelled_after_dispatch',
      heldUntil,
    );
    this.name = 'IdempotencyHeldError';
  }
}

/**
 * Wrapper an `execute` throws to tell {@link IdempotencyStore.runExclusive}
 * "this failure does not mean nothing happened".
 *
 * Every other rejection releases the reservation, which is right: a call that
 * failed before it reached Avito must not wedge the key. This one is the
 * exception the ledger cannot infer on its own, because only the caller knows
 * whether the request had already been dispatched when it fell over.
 */
export class UpstreamOutcomeUnknownError extends Error {
  constructor(
    /** The original failure, rethrown to the caller after the hold is recorded. */
    readonly cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? `Upstream outcome unknown: ${cause.message}`
        : `Upstream outcome unknown: ${String(cause)}`,
    );
    this.name = 'UpstreamOutcomeUnknownError';
  }
}

export class IdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();
  private reservations = new Map<string, IdempotencyReservation>();
  /** Keys refused because a dispatched mutation's outcome is unknown. See {@link IdempotencyHold}. */
  private holds = new Map<string, IdempotencyHold>();
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
    // interleave between these synchronous map operations. A hold goes too: a
    // known result supersedes "we do not know what happened".
    this.reservations.delete(composed);
    this.holds.delete(composed);
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
          // A live hold: the previous caller was cancelled with its request
          // already on the wire. Refuse while it lasts.
          if (record?.state === 'indeterminate' && record.expiresAt >= now) {
            this.holds.set(this.composeKey(toolName, key), {
              key: record.key,
              toolName,
              argsHash: record.argsHash,
              heldAt: record.heldAt ?? record.createdAt,
              expiresAt: record.expiresAt,
            });
            throw new IdempotencyHeldError(key, toolName, record.expiresAt);
          }
          if (record?.state === 'in_flight') {
            throw new IdempotencyRecoveryRequiredError(key, toolName);
          }
          if (record) {
            // The one sweep this ledger has: a record that is no longer usable is
            // removed the next time its key comes round. An expired hold lands
            // here too, which is what keeps it from being permanent.
            if (record.state === 'indeterminate') {
              logger.info(
                {
                  tool: toolName,
                  idempotencyKeyHash: fingerprintIdempotencyKey(key),
                  heldForMs: now - (record.heldAt ?? record.createdAt),
                },
                'expired idempotency hold swept; the key is usable again',
              );
            }
            this.holds.delete(this.composeKey(toolName, key));
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
            // An outcome nobody can determine is NOT the same as no outcome.
            // Releasing the key here would let the very next retry fire a second
            // mutation for a first one that may already have been applied.
            if (error instanceof UpstreamOutcomeUnknownError) {
              await this.holdReservation(persistentPath, reservation, key, toolName, error);
              throw error.cause;
            }
            // Any other caught application failure means no usable result was produced,
            // and the request never reached Avito or was definitively answered by it.
            // A hard process stop never reaches this branch, leaving the reservation
            // fail-closed as `in_flight`.
            await fs.rm(persistentPath, { force: true });
            throw error;
          }
        },
        { timeoutMs: this.options.lockTimeoutMs ?? 30_000 },
      );
    }

    const composed = this.composeKey(toolName, key);
    // Sweeps expired holds as well as expired entries, so the check below only
    // ever sees a hold that is still in force.
    this.cleanupExpired();

    const held = this.holds.get(composed);
    if (held) {
      if (held.argsHash !== argsHash) throw new IdempotencyConflictError(key, toolName);
      throw new IdempotencyHeldError(key, toolName, held.expiresAt);
    }

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
        if (err instanceof UpstreamOutcomeUnknownError) {
          // Same rule as the durable path: an unknown upstream outcome converts
          // the reservation into a bounded refusal instead of freeing the key.
          this.hold(composed, key, toolName, argsHash);
          rejectReservation(err.cause);
        } else {
          rejectReservation(err);
        }
      }
    })();
    return { entry: await promise, replay: false };
  }

  /**
   * Records the in-memory half of a hold. The caller that produced it still gets
   * its ORIGINAL failure — it is the cancelled request, and rewriting its
   * rejection into a policy answer would only mislead whoever reads the logs.
   */
  private hold(composed: string, key: string, toolName: string, argsHash: string): void {
    const heldAt = Date.now();
    const expiresAt = heldAt + this.ttlMs;
    this.holds.set(composed, {
      key: storedIdempotencyKey(key),
      toolName,
      argsHash,
      heldAt,
      expiresAt,
    });
    logger.warn(
      {
        tool: toolName,
        idempotencyKeyHash: fingerprintIdempotencyKey(key),
        heldUntil: new Date(expiresAt).toISOString(),
      },
      'idempotency key HELD: the caller cancelled after the request had already been sent to Avito. ' +
        'The key is refused until it expires; reconcile the operation on the Avito side.',
    );
  }

  /**
   * Rewrites a durable reservation into a bounded hold, keeping the `expiresAt`
   * the reservation was created with. That deadline is what stops this from
   * becoming a second permanent `in_flight`: the record is refused while it
   * lasts and swept by {@link runExclusive} once it does not.
   */
  private async holdReservation(
    persistentPath: string,
    reservation: PersistentRecord,
    key: string,
    toolName: string,
    error: UpstreamOutcomeUnknownError,
  ): Promise<void> {
    const heldAt = Date.now();
    const record: PersistentRecord = {
      ...reservation,
      state: 'indeterminate',
      heldAt,
      heldReason: error.message,
    };
    await writeJsonAtomic(persistentPath, record);
    this.holds.set(this.composeKey(toolName, key), {
      key: reservation.key,
      toolName,
      argsHash: reservation.argsHash,
      heldAt,
      expiresAt: reservation.expiresAt,
    });
    logger.warn(
      {
        tool: toolName,
        idempotencyKeyHash: fingerprintIdempotencyKey(key),
        record: persistentPath,
        heldUntil: new Date(reservation.expiresAt).toISOString(),
      },
      'idempotency key HELD: the caller cancelled after the request had already been sent to Avito. ' +
        'The key is refused until it expires. Reconcile the operation with Avito first; ' +
        'to lift the hold sooner, delete the record file named above (see docs/safety.md).',
    );
  }

  /**
   * The operator escape hatch for a hold that must not wait out its TTL —
   * because the operation was reconciled with Avito and the answer is known.
   *
   * Removes both halves (the process-local refusal and the durable record) and
   * touches nothing else: a `completed` entry or an `in_flight` reservation
   * under the same key is left exactly where it is.
   */
  async releaseHold(key: string, toolName: string): Promise<boolean> {
    const composed = this.composeKey(toolName, key);
    let released = this.holds.delete(composed);
    const persistentPath = this.persistentPath(toolName, key);
    if (persistentPath) {
      await withFileLock(
        persistentPath,
        async () => {
          const record = await readJsonFile<PersistentRecord>(persistentPath);
          if (record?.state !== 'indeterminate') return;
          await removeFileDurable(persistentPath);
          released = true;
        },
        { timeoutMs: this.options.lockTimeoutMs ?? 30_000 },
      );
    }
    if (released) {
      logger.warn(
        { tool: toolName, idempotencyKeyHash: fingerprintIdempotencyKey(key) },
        'idempotency hold released by operator request',
      );
    }
    return released;
  }

  /**
   * Removes the entry for (toolName, key), if any. Used to evict a stale
   * "requires_confirmation" replay once its pending action is cancelled/expired,
   * so a fresh retry with the same key is not wedged on a dead confirmation_id.
   */
  delete(key: string, toolName: string): boolean {
    const composed = this.composeKey(toolName, key);
    this.retainExpired.delete(composed);
    // A hold occupies the same logical slot as an entry, so "remove what is
    // under this key" has to mean both — otherwise the process-local refusal
    // would outlive the eviction that was supposed to clear the key.
    const heldRemoved = this.holds.delete(composed);
    return this.entries.delete(composed) || heldRemoved;
  }

  size(): number {
    this.cleanupExpired();
    return this.entries.size + this.reservations.size + this.holds.size;
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
    //
    // Holds are the opposite case and DO expire: nothing is running any more, and
    // an unbounded hold would both wedge the key for good and eat a maxEntries
    // slot that no operator could ever get back.
    for (const [k, hold] of this.holds) {
      if (hold.expiresAt >= now) continue;
      this.holds.delete(k);
      logger.info(
        { tool: hold.toolName, heldForMs: now - hold.heldAt },
        'expired idempotency hold swept; the key is usable again',
      );
    }
  }

  private assertCapacity(composed: string): void {
    if (this.entries.has(composed) || this.reservations.has(composed) || this.holds.has(composed))
      return;
    if (this.entries.size + this.reservations.size + this.holds.size >= this.maxEntries) {
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
