import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { ToolRisk } from './tool-factory.js';
import { withFileLock } from './file-lock.js';
import { readJsonFile, removeFileDurable, writeJsonAtomic } from './runtime-state.js';

/**
 * Executor function for a pending action. Returned within the pending action
 * so that on confirm the exact same handler can be run with the same args.
 * Closes over the original handler and is meant to be called exactly once.
 */
export type PendingExecutor = () => Promise<CallToolResult>;

export interface PendingAction {
  id: string;
  toolName: string;
  risk: ToolRisk;
  summary: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  initiator: string;
  idempotencyKey?: string;
  argsHash?: string;
  execute: PendingExecutor;
}

/** Public-facing view (without execute and without args — args may contain sensitive data). */
export interface PendingActionInfo {
  id: string;
  toolName: string;
  risk: ToolRisk;
  summary: string;
  createdAt: number;
  expiresAt: number;
  initiator: string;
}

/**
 * TTL'd store of pending actions awaiting confirmation. It can be process-local
 * or backed by locked, durable records shared across stdio processes.
 *
 * Confirmation is one-time: a durable claim is published before execution and
 * removed only after the executor and result persistence succeed. Cancellation,
 * expiry, and hard-confirmation lockout remove unclaimed entries.
 *
 * Subscriber for store changes. v0.6.0 — needed for the MCP resource
 * `avito://state/pending-actions`, so that clients can subscribe via
 * resources/subscribe and receive notifications/resources/updated.
 */
export type PendingChangeListener = (
  event: 'created' | 'deleted' | 'expired',
  action?: PendingActionInfo,
) => void;

export class PendingActionLimitError extends Error {
  constructor(public readonly maxActions: number) {
    super(
      `Pending action limit reached (${maxActions}); confirm, cancel, or wait for expiry before creating another action.`,
    );
    this.name = 'PendingActionLimitError';
  }
}

export interface ConfirmationFailureResult {
  found: boolean;
  failedAttempts: number;
  /** True means the shared threshold was reached and the pending action was deleted. */
  locked: boolean;
}

export interface ConfirmationRateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export class PendingActionStore {
  private actions = new Map<string, PendingAction>();
  /**
   * Claimed actions stay here until their executor settles. They are no longer
   * confirmable/listed, but an idempotency entry that points at their id must not
   * be mistaken for a cancelled/expired pending action while the mutation runs.
   */
  private inFlight = new Map<string, PendingAction>();
  private failedConfirmationAttempts = new Map<string, number>();
  private confirmationAttempts = new Map<string, number[]>();
  private listeners: PendingChangeListener[] = [];
  private executors = new Map<
    string,
    (
      args: Record<string, unknown>,
      idempotencyKey?: string,
      argsHash?: string,
    ) => Promise<CallToolResult>
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxActions: number = 1000,
    private readonly persistent?: {
      stateDir: string;
      namespace: string;
      lockTimeoutMs?: number;
    },
  ) {}

  registerExecutor(
    toolName: string,
    executor: (
      args: Record<string, unknown>,
      idempotencyKey?: string,
      argsHash?: string,
    ) => Promise<CallToolResult>,
  ): void {
    this.executors.set(toolName, executor);
  }

  /**
   * Creates an entry. id is 32 hex characters (16 bytes of entropy), strong
   * enough that it can't be guessed without a timing attack.
   */
  create(input: {
    toolName: string;
    risk: ToolRisk;
    summary: string;
    args: Record<string, unknown>;
    initiator?: string;
    idempotencyKey?: string;
    argsHash?: string;
    execute: PendingExecutor;
  }): PendingAction {
    const now = Date.now();
    this.cleanupExpired(now);
    if (this.actions.size + this.inFlight.size >= this.maxActions) {
      throw new PendingActionLimitError(this.maxActions);
    }
    const id = randomBytes(16).toString('hex');
    const action: PendingAction = {
      ...input,
      initiator: input.initiator ?? 'session:local-stdio',
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.actions.set(id, action);
    this.emit('created', action);
    return action;
  }

  async createPersistent(
    input: Parameters<PendingActionStore['create']>[0],
  ): Promise<PendingAction> {
    const action = this.create(input);
    const path = this.actionPath(action.id);
    if (path) {
      try {
        await withFileLock(path, () => writeJsonAtomic(path, this.toRecord(action)), {
          timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000,
        });
      } catch (error) {
        this.delete(action.id);
        throw error;
      }
    }
    return action;
  }

  /** Returns the entry if it's alive. Otherwise undefined (the caller must report why itself). */
  get(id: string): PendingAction | undefined {
    this.cleanupExpired();
    return this.actions.get(id);
  }

  async getPersistent(id: string): Promise<PendingAction | undefined> {
    const path = this.actionPath(id);
    if (!path) return this.get(id);
    this.cleanupExpired();
    const record = await readJsonFile<PersistentPendingRecord>(path);
    if (!record) {
      // The durable record is authoritative in persistent mode. Another
      // process may have claimed, cancelled, expired, or locked the action.
      this.delete(id);
      return undefined;
    }
    if ((record.state ?? 'pending') !== 'pending') {
      this.delete(id);
      return undefined;
    }
    if (record.expiresAt < Date.now()) {
      await this.removeExpiredPersistent(id, path);
      return undefined;
    }
    return this.actions.get(id) ?? this.rehydrate(record);
  }

  /** Returns true if the entry existed and was removed, false if it never existed. */
  delete(id: string): boolean {
    const had = this.actions.get(id);
    const existed = this.actions.delete(id);
    this.failedConfirmationAttempts.delete(id);
    if (existed && had) this.emit('deleted', had);
    return existed;
  }

  async deletePersistent(id: string): Promise<boolean> {
    const path = this.actionPath(id);
    if (!path) return this.delete(id);
    return withFileLock(
      path,
      async () => {
        const record = await readJsonFile<PersistentPendingRecord>(path);
        const existed =
          record !== undefined &&
          record.expiresAt >= Date.now() &&
          (record.state ?? 'pending') === 'pending';
        if (record && (record.state ?? 'pending') !== 'claimed') {
          await removeFileDurable(path);
        }
        // A process-local entry may be stale after another process claimed or
        // cancelled the action. Clear it, but never use it to report success.
        this.delete(id);
        return existed;
      },
      { timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000 },
    );
  }

  /**
   * Atomically claims a pending action for one-time execution. Only one caller can
   * receive the action; concurrent sessions observe undefined after the first claim.
   */
  take(id: string): PendingAction | undefined {
    this.cleanupExpired();
    const action = this.actions.get(id);
    if (!action) return undefined;
    this.actions.delete(id);
    this.inFlight.set(id, action);
    this.failedConfirmationAttempts.delete(id);
    this.emit('deleted', action);
    return action;
  }

  async takePersistent(id: string): Promise<PendingAction | undefined> {
    const path = this.actionPath(id);
    if (!path) return this.take(id);
    return withFileLock(
      path,
      async () => {
        const record = await readJsonFile<PersistentPendingRecord>(path);
        if (!record) {
          this.actions.delete(id);
          return undefined;
        }
        if ((record.state ?? 'pending') !== 'pending') {
          this.delete(id);
          return undefined;
        }
        const local = this.actions.get(id);
        const action = local ?? this.rehydrate(record);
        if (!action || action.expiresAt < Date.now()) {
          await removeFileDurable(path);
          this.delete(id);
          return undefined;
        }
        // Publish the claimed state before returning the executor. Other
        // processes must see that this id is executing, not cancelled.
        await writeJsonAtomic(path, {
          ...record,
          state: 'claimed',
          claimedAt: Date.now(),
        });
        this.actions.delete(id);
        this.inFlight.set(id, action);
        this.failedConfirmationAttempts.delete(id);
        this.emit('deleted', action);
        return action;
      },
      { timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000 },
    );
  }

  /**
   * Releases a claimed action after its executor has settled. Callers must place
   * this in a finally block so a thrown executor cannot permanently pin the key.
   */
  complete(id: string): boolean {
    return this.inFlight.delete(id);
  }

  /** Removes the durable claimed marker only after execution/result persistence succeeds. */
  async completePersistent(id: string): Promise<boolean> {
    const completed = this.complete(id);
    const path = this.actionPath(id);
    if (!path || !completed) return completed;
    return withFileLock(
      path,
      async () => {
        const record = await readJsonFile<PersistentPendingRecord>(path);
        if (!record || (record.state ?? 'pending') !== 'claimed') return false;
        await removeFileDurable(path);
        return true;
      },
      { timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000 },
    );
  }

  /**
   * True while the action can still be confirmed OR is already executing. This
   * is intentionally wider than get(): confirmation callers must not be able to
   * claim an in-flight action twice, while idempotency needs the lifecycle view.
   */
  isActive(id: string): boolean {
    this.cleanupExpired();
    return this.actions.has(id) || this.inFlight.has(id);
  }

  /** Durable lifecycle check for callers that may run in another process. */
  async isActivePersistent(id: string): Promise<boolean> {
    if (this.inFlight.has(id)) return true;
    const path = this.actionPath(id);
    if (!path) return this.isActive(id);
    const record = await readJsonFile<PersistentPendingRecord>(path);
    if (!record) {
      this.delete(id);
      return false;
    }
    if ((record.state ?? 'pending') === 'claimed') return true;
    if (record.expiresAt < Date.now()) {
      await this.removeExpiredPersistent(id, path);
      return false;
    }
    return true;
  }

  /**
   * Atomically records a hard-confirmation failure in the process-wide store.
   * Every MCP session shares this counter through the shared ToolContext.
   */
  recordFailedConfirmation(id: string, maxAttempts: number = 5): ConfirmationFailureResult {
    this.cleanupExpired();
    const action = this.actions.get(id);
    if (!action) return { found: false, failedAttempts: 0, locked: false };

    const failedAttempts = (this.failedConfirmationAttempts.get(id) ?? 0) + 1;
    const locked = failedAttempts >= Math.max(1, maxAttempts);
    if (locked) {
      this.actions.delete(id);
      this.failedConfirmationAttempts.delete(id);
      this.emit('deleted', action);
    } else {
      this.failedConfirmationAttempts.set(id, failedAttempts);
    }
    return { found: true, failedAttempts, locked };
  }

  /** Atomically shares the failure counter and final lockout across processes. */
  async recordFailedConfirmationPersistent(
    id: string,
    maxAttempts: number = 5,
  ): Promise<ConfirmationFailureResult> {
    const path = this.actionPath(id);
    if (!path) return this.recordFailedConfirmation(id, maxAttempts);

    this.cleanupExpired();
    return withFileLock(
      path,
      async () => {
        const record = await readJsonFile<PersistentPendingRecord>(path);
        if (!record) {
          this.delete(id);
          return { found: false, failedAttempts: 0, locked: false };
        }
        if ((record.state ?? 'pending') !== 'pending') {
          this.delete(id);
          return { found: false, failedAttempts: 0, locked: false };
        }
        if (record.expiresAt < Date.now()) {
          if (record) await removeFileDurable(path);
          // Another process may already have claimed, cancelled, or locked the
          // durable action. Drop any stale process-local copy as well.
          this.delete(id);
          return { found: false, failedAttempts: 0, locked: false };
        }
        const previousFailures = record.failedConfirmationAttempts ?? 0;
        if (!Number.isSafeInteger(previousFailures) || previousFailures < 0) {
          throw new Error('Invalid persistent confirmation failure counter');
        }
        const failedAttempts = previousFailures + 1;
        const locked = failedAttempts >= Math.max(1, maxAttempts);
        if (locked) {
          await removeFileDurable(path);
          this.delete(id);
        } else {
          await writeJsonAtomic(path, {
            ...record,
            failedConfirmationAttempts: failedAttempts,
          });
          this.failedConfirmationAttempts.set(id, failedAttempts);
        }
        return { found: true, failedAttempts, locked };
      },
      { timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000 },
    );
  }

  /** Clears the shared failure counter after a valid secret without deleting the action. */
  resetConfirmationFailures(id: string): void {
    this.failedConfirmationAttempts.delete(id);
  }

  /** Shared sliding-window budget keyed by an authenticated principal fingerprint. */
  checkConfirmationRateLimit(
    principal: string,
    now: number = Date.now(),
    maxAttempts: number = 20,
    windowMs: number = 60_000,
  ): ConfirmationRateLimitResult {
    const cutoff = now - windowMs;
    for (const [key, attempts] of this.confirmationAttempts) {
      const live = attempts.filter((timestamp) => timestamp > cutoff);
      if (live.length === 0) this.confirmationAttempts.delete(key);
      else if (live.length !== attempts.length) this.confirmationAttempts.set(key, live);
    }

    const attempts = this.confirmationAttempts.get(principal) ?? [];
    if (attempts.length >= Math.max(1, maxAttempts)) {
      return { allowed: false, retryAfterMs: Math.max(1, attempts[0]! + windowMs - now) };
    }
    attempts.push(now);
    this.confirmationAttempts.set(principal, attempts);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Safe list — without args, without execute. */
  list(): PendingActionInfo[] {
    this.cleanupExpired();
    return [...this.actions.values()].map(toInfo);
  }

  async listPersistent(): Promise<PendingActionInfo[]> {
    if (!this.persistent) return this.list();
    const directory = join(this.persistent.stateDir, this.persistent.namespace, 'pending');
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
        .map(async (name) => ({
          id: name.slice(0, -'.json'.length),
          path: join(directory, name),
          record: await readJsonFile<PersistentPendingRecord>(join(directory, name)),
        })),
    );
    // Durable records are authoritative in persistent mode. Process-local
    // entries can be stale after another process claims, cancels, or locks one.
    const byId = new Map<string, PendingActionInfo>();
    const now = Date.now();
    await Promise.all(
      records
        .filter(
          ({ record }) =>
            record !== undefined &&
            (record.state ?? 'pending') === 'pending' &&
            record.expiresAt < now,
        )
        .map(({ id, path }) => this.removeExpiredPersistent(id, path, now)),
    );
    for (const { record } of records) {
      if (!record || record.expiresAt < now || (record.state ?? 'pending') !== 'pending') {
        continue;
      }
      byId.set(record.id, {
        id: record.id,
        toolName: record.toolName,
        risk: record.risk,
        summary: record.summary,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        initiator: record.initiator,
      });
    }
    return [...byId.values()];
  }

  /** Finds a fail-closed claimed marker after its idempotency result replaced the pending payload. */
  async hasClaimedPersistent(
    toolName: string,
    idempotencyKey: string,
    argsHash: string,
  ): Promise<boolean> {
    for (const action of this.inFlight.values()) {
      if (
        action.toolName === toolName &&
        action.idempotencyKey === idempotencyKey &&
        action.argsHash === argsHash
      ) {
        return true;
      }
    }
    if (!this.persistent) return false;
    const directory = join(this.persistent.stateDir, this.persistent.namespace, 'pending');
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
        .map((name) => readJsonFile<PersistentPendingRecord>(join(directory, name))),
    );
    return records.some(
      (record) =>
        record !== undefined &&
        (record.state ?? 'pending') === 'claimed' &&
        record.toolName === toolName &&
        record.idempotencyKey === idempotencyKey &&
        record.argsHash === argsHash,
    );
  }

  /** For tests — the current size. */
  size(): number {
    this.cleanupExpired();
    return this.actions.size;
  }

  /** Subscribe to store changes. Returns an unsubscribe function. */
  onChange(listener: PendingChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: 'created' | 'deleted' | 'expired', action: PendingAction): void {
    const info = toInfo(action);
    for (const l of this.listeners) {
      try {
        l(event, info);
      } catch {
        // A subscriber must not break the store. Swallow the error.
      }
    }
  }

  private cleanupExpired(now: number = Date.now()): void {
    for (const [id, a] of this.actions) {
      if (a.expiresAt < now) {
        this.actions.delete(id);
        this.failedConfirmationAttempts.delete(id);
        this.emit('expired', a);
      }
    }
  }

  private actionPath(id: string): string | undefined {
    if (!this.persistent || !/^[0-9a-f]{32}$/.test(id)) return undefined;
    return join(this.persistent.stateDir, this.persistent.namespace, 'pending', `${id}.json`);
  }

  private async removeExpiredPersistent(
    id: string,
    path: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    return withFileLock(
      path,
      async () => {
        const record = await readJsonFile<PersistentPendingRecord>(path);
        if (!record) {
          this.delete(id);
          return false;
        }
        if ((record.state ?? 'pending') === 'claimed') return false;
        if (record.expiresAt >= now) return false;
        await removeFileDurable(path);
        this.delete(id);
        return true;
      },
      { timeoutMs: this.persistent?.lockTimeoutMs ?? 30_000 },
    );
  }

  private toRecord(action: PendingAction): PersistentPendingRecord {
    return {
      version: 1,
      id: action.id,
      toolName: action.toolName,
      risk: action.risk,
      summary: action.summary,
      args: action.args,
      createdAt: action.createdAt,
      expiresAt: action.expiresAt,
      initiator: action.initiator,
      idempotencyKey: action.idempotencyKey,
      argsHash: action.argsHash,
      state: 'pending',
    };
  }

  private rehydrate(record: PersistentPendingRecord): PendingAction | undefined {
    if (
      record.version !== 1 ||
      record.expiresAt < Date.now() ||
      (record.state ?? 'pending') !== 'pending'
    ) {
      return undefined;
    }
    const executor = this.executors.get(record.toolName);
    if (!executor) return undefined;
    return {
      id: record.id,
      toolName: record.toolName,
      risk: record.risk,
      summary: record.summary,
      args: record.args,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      initiator: record.initiator,
      idempotencyKey: record.idempotencyKey,
      argsHash: record.argsHash,
      execute: () => executor(record.args, record.idempotencyKey, record.argsHash),
    };
  }
}

interface PersistentPendingRecord extends Omit<PendingAction, 'execute'> {
  version: 1;
  /** Missing means pending for backward compatibility with v1.3.0/v1.3.1. */
  state?: 'pending' | 'claimed';
  claimedAt?: number;
  /** Shared hard-confirmation failures; optional for v1.3.0/1.3.1 records. */
  failedConfirmationAttempts?: number;
}

export interface CallerExtra {
  authInfo?: { clientId?: string };
  sessionId?: string;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}

export function callerPrincipal(extra: CallerExtra | undefined): string {
  if (extra?.authInfo?.clientId) return `oauth:${extra.authInfo.clientId}`;
  const raw = extra?.requestInfo?.headers?.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (bearer) {
    return `bearer:${createHash('sha256').update(bearer).digest('base64url')}`;
  }
  return `session:${extra?.sessionId ?? 'local-stdio'}`;
}

function toInfo(a: PendingAction): PendingActionInfo {
  return {
    id: a.id,
    toolName: a.toolName,
    risk: a.risk,
    summary: a.summary,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    initiator: a.initiator,
  };
}
