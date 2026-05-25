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
export class PendingActionStore {
  private actions = new Map<string, PendingAction>();

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
    return action;
  }

  /** Возвращает запись если жива. Иначе undefined (вызывающий должен сам сообщить почему). */
  get(id: string): PendingAction | undefined {
    this.cleanupExpired();
    return this.actions.get(id);
  }

  /** Возвращает true если запись была и удалилась, false если её и не было. */
  delete(id: string): boolean {
    return this.actions.delete(id);
  }

  /** Безопасный list — без args, без execute. */
  list(): PendingActionInfo[] {
    this.cleanupExpired();
    return [...this.actions.values()].map((a) => ({
      id: a.id,
      toolName: a.toolName,
      risk: a.risk,
      summary: a.summary,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    }));
  }

  /** Для тестов — текущий размер. */
  size(): number {
    this.cleanupExpired();
    return this.actions.size;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, a] of this.actions) {
      if (a.expiresAt < now) this.actions.delete(id);
    }
  }
}
