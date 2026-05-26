/**
 * Idempotency ledger (v0.7.0). Опционально защищает destructive tools
 * (risk='write' | 'money' | 'public') от повторного выполнения после retry / crash /
 * race condition между несколькими агентами.
 *
 * Контракт:
 *   - Агент передаёт `idempotencyKey: string` в args
 *   - На первый вызов: tool выполняется, результат запоминается под (key, hash)
 *   - На повторный вызов с тем же key и теми же args в течение TTL:
 *     возвращается закешированный результат с пометкой `idempotent_replay: true`
 *   - На повторный вызов с тем же key но другими args: ConflictError → агент видит
 *     понятную ошибку и не получит "тот же результат для разных args"
 *
 * Конструкция намеренно in-memory. Persistent / shared backends (file, Redis, etc.)
 * — за пределами универсального пакета: разные пользователи захотят разные. Документируем
 * как extension point.
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

  constructor(private readonly ttlMs: number) {}

  /**
   * Если запись по `key` существует и она для того же tool+args — возвращает её.
   * Если для других args — бросает IdempotencyConflictError.
   * Если нет — возвращает undefined (caller должен выполнить tool и записать).
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
   * Сохраняет результат под (toolName, key). Перезаписывает истекшие записи.
   * Возвращает свежую запись.
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
    return entry;
  }

  size(): number {
    this.cleanupExpired();
    return this.entries.size;
  }

  /** Для тестов / meta_*. */
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
  }
}

/**
 * Стабильный hash аргументов. JSON.stringify не гарантирует порядок ключей,
 * поэтому сортируем рекурсивно. Используется только для сравнения "те же args или нет",
 * не для криптографии — sha256 здесь — это просто короткое стабильное представление.
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
