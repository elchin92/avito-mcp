import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';

import type { ToolRisk } from './tool-factory.js';

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

export class PendingActionStore {
  private actions = new Map<string, PendingAction>();
  private listeners: PendingChangeListener[] = [];

  constructor(private readonly ttlMs: number) {}

  /**
   * Creates an entry. id is 32 hex characters (16 bytes of entropy), strong
   * enough that it can't be guessed without a timing attack.
   */
  create(input: {
    toolName: string;
    risk: ToolRisk;
    summary: string;
    args: Record<string, unknown>;
    execute: PendingExecutor;
  }): PendingAction {
    const id = randomBytes(16).toString('hex');
    const now = Date.now();
    const action: PendingAction = {
      ...input,
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.actions.set(id, action);
    this.emit('created', action);
    return action;
  }

  /** Returns the entry if it's alive. Otherwise undefined (the caller must report why itself). */
  get(id: string): PendingAction | undefined {
    this.cleanupExpired();
    return this.actions.get(id);
  }

  /** Returns true if the entry existed and was removed, false if it never existed. */
  delete(id: string): boolean {
    const had = this.actions.get(id);
    const existed = this.actions.delete(id);
    if (existed && had) this.emit('deleted', had);
    return existed;
  }

  /** Safe list — without args, without execute. */
  list(): PendingActionInfo[] {
    this.cleanupExpired();
    return [...this.actions.values()].map(toInfo);
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

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, a] of this.actions) {
      if (a.expiresAt < now) {
        this.actions.delete(id);
        this.emit('expired', a);
      }
    }
  }
}

function toInfo(a: PendingAction): PendingActionInfo {
  return {
    id: a.id,
    toolName: a.toolName,
    risk: a.risk,
    summary: a.summary,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}
