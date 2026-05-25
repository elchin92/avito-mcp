import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';

import type { ToolRisk } from './tool-factory.js';

/**
 * Функция-исполнитель отложенного действия. Возвращается в pending action
 * чтобы при confirm можно было выполнить ровно тот же handler с теми же args.
 * Замкнута на оригинальный handler и cтрого один раз вызывается.
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

/** Public-facing view (без execute и без args — args могут содержать чувствительные данные). */
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
 * Сознательно НЕ персистится на диск:
 *   - после рестарта pending теряется, что лучше чем случайно подтвердить старое действие
 *   - stdio MCP сервер обычно ephemeral
 *   - меньше surface для leak'ов
 *
 * Конфирмация одноразовая: после успешного confirm запись удаляется.
 * Cancel и expiry тоже удаляют. Cleanup ленивый — при каждом get/list.
 */
/**
 * Подписчик на изменения store. v0.6.0 — нужен MCP resource
 * `avito://state/pending-actions`, чтобы клиенты могли подписаться через
 * resources/subscribe и получать notifications/resources/updated.
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
   * Создаёт запись. id — 32 hex символа (16 байт энтропии), достаточно
   * сильно чтобы не угадать без timing-атаки.
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

  /** Возвращает запись если жива. Иначе undefined (вызывающий должен сам сообщить почему). */
  get(id: string): PendingAction | undefined {
    this.cleanupExpired();
    return this.actions.get(id);
  }

  /** Возвращает true если запись была и удалилась, false если её и не было. */
  delete(id: string): boolean {
    const had = this.actions.get(id);
    const existed = this.actions.delete(id);
    if (existed && had) this.emit('deleted', had);
    return existed;
  }

  /** Безопасный list — без args, без execute. */
  list(): PendingActionInfo[] {
    this.cleanupExpired();
    return [...this.actions.values()].map(toInfo);
  }

  /** Для тестов — текущий размер. */
  size(): number {
    this.cleanupExpired();
    return this.actions.size;
  }

  /** Подписка на изменения store. Возвращает unsubscribe. */
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
        // Подписчик не должен ломать store. Глотаем.
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
