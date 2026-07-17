import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { ToolRisk } from './tool-factory.js';
import { withFileLock } from './file-lock.js';
import { readJsonFile, writeJsonAtomic } from './runtime-state.js';

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
 * In-memory TTL'd store of pending actions awaiting confirmation.
 *
 * Deliberately NOT persisted to disk:
 *   - after a restart the pending entries are lost, which is better than accidentally confirming a stale action
 *   - a stdio MCP server is usually ephemeral
 *   - smaller surface for leaks
 *
 * Confirmation is one-time: after a successful confirm the entry is removed.
 * Cancel and expiry remove it too. Cleanup is lazy — on every get/list.
 */
/**
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
    (args: Record<string, unknown>, idempotencyKey?: string, argsHash?: string) => Promise<CallToolResult>
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxActions: number = 1000,
    private readonly persistent?: { stateDir: string; namespace: string; lockTimeoutMs?: number },
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

  async createPersistent(input: Parameters<PendingActionStore['create']>[0]): Promise<PendingAction> {
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
    const local = this.get(id);
    if (local) return local;
    const path = this.actionPath(id);
    if (!path) return undefined;
    const record = await readJsonFile<PersistentPendingRecord>(path);
    return record ? this.rehydrate(record) : undefined;
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
    const local = this.delete(id);
    const path = this.actionPath(id);
    if (!path) return local;
    return withFileLock(
      path,
      async () => {
        const existed = (await readJsonFile<PersistentPendingRecord>(path)) !== undefined;
        await fs.rm(path, { force: true });
        return local || existed;
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
        const local = this.actions.get(id);
        const action = local ?? this.rehydrate(record);
        if (!action || action.expiresAt < Date.now()) {
          await fs.rm(path, { force: true });
          return undefined;
        }
        this.actions.delete(id);
        this.inFlight.set(id, action);
        this.failedConfirmationAttempts.delete(id);
        await fs.rm(path, { force: true });
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

  /**
   * True while the action can still be confirmed OR is already executing. This
   * is intentionally wider than get(): confirmation callers must not be able to
   * claim an in-flight action twice, while idempotency needs the lifecycle view.
   */
  isActive(id: string): boolean {
    this.cleanupExpired();
    return this.actions.has(id) || this.inFlight.has(id);
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

  async recordFailedConfirmationPersistent(
    id: string,
    maxAttempts: number = 5,
  ): Promise<ConfirmationFailureResult> {
    const attempt = this.recordFailedConfirmation(id, maxAttempts);
    if (attempt.locked) {
      await this.deletePersistent(id);
    }
    return attempt;
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.list();
      throw error;
    }
    const records = await Promise.all(
      names.filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).map((name) => readJsonFile<PersistentPendingRecord>(join(directory, name))),
    );
    const byId = new Map(this.list().map((item) => [item.id, item]));
    for (const record of records) {
      if (!record || record.expiresAt < Date.now()) continue;
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
    };
  }

  private rehydrate(record: PersistentPendingRecord): PendingAction | undefined {
    if (record.version !== 1 || record.expiresAt < Date.now()) return undefined;
    const executor = this.executors.get(record.toolName);
    if (!executor) return undefined;
    const action = { ...record } as Omit<PersistentPendingRecord, 'version'> & {
      version?: number;
    };
    delete action.version;
    return {
      ...action,
      execute: () => executor(record.args, record.idempotencyKey, record.argsHash),
    };
  }
}

interface PersistentPendingRecord extends Omit<PendingAction, 'execute'> {
  version: 1;
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
