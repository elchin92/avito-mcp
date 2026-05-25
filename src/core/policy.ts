import { logger } from '../logger.js';
import type { Config } from '../config.js';
import type { ToolRisk } from './tool-factory.js';

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Решает, должен ли tool с заданным risk быть зарегистрирован для текущего сервера.
 *
 * Порядок проверки (соответствует контракту v0.4.0):
 *   1. `sensitive` — auth-tools и т.п. скрыты по default. Включаются только
 *      через AVITO_MCP_EXPOSE_AUTH_TOOLS=1. Сразу выходим если нет opt-in.
 *   2. `denyTools` — deny всегда сильнее allow.
 *   3. `allowTools` — если список не пуст и имени там нет, отказ.
 *   4. `mode`:
 *      - `read_only`   → разрешает только risk='read' (sensitive уже отсеян выше)
 *      - `guarded`     → разрешает 'read' и 'write'; блокирует 'money' и 'public'
 *      - `full_access` → разрешает всё (default)
 *
 * Скрытие выполняется на этапе регистрации tool (в `defineTool` и для
 * custom-tools через `server.registerTool`). Заблокированный tool агент не видит
 * в `tools/list` — это сильнее чем runtime-блокировка.
 *
 * Confirmation flow — отдельный слой поверх этой policy, в `tool-factory.ts`.
 */
export function evaluatePolicy(
  toolName: string,
  risk: ToolRisk,
  cfg: Config,
): PolicyDecision {
  if (risk === 'sensitive' && !cfg.exposeAuthTools) {
    return {
      allowed: false,
      reason: `risk=sensitive hidden by default — set AVITO_MCP_EXPOSE_AUTH_TOOLS=1 to expose`,
    };
  }
  if (cfg.denyTools.includes(toolName)) {
    return { allowed: false, reason: `tool is in AVITO_MCP_DENY_TOOLS` };
  }
  if (cfg.allowTools.length > 0 && !cfg.allowTools.includes(toolName)) {
    return { allowed: false, reason: `tool is not in AVITO_MCP_ALLOW_TOOLS allowlist` };
  }
  if (cfg.mode === 'read_only' && risk !== 'read') {
    return { allowed: false, reason: `AVITO_MCP_MODE=read_only blocks risk=${risk}` };
  }
  if (cfg.mode === 'guarded' && (risk === 'money' || risk === 'public')) {
    return { allowed: false, reason: `AVITO_MCP_MODE=guarded blocks risk=${risk}` };
  }
  return { allowed: true };
}

/**
 * Решает, требует ли tool с заданным risk подтверждения через meta_confirm_action.
 * Применяется на runtime (после policy pass). Sensitive не требует — оно уже под
 * жёстким opt-in, дополнительный confirm там не имеет смысла.
 */
export function requiresConfirmation(risk: ToolRisk, cfg: Config): boolean {
  if (cfg.confirmationMode === 'off') return false;
  if (cfg.confirmationMode === 'money_public') {
    return risk === 'money' || risk === 'public';
  }
  // all_destructive
  return risk === 'money' || risk === 'public' || risk === 'write';
}

/**
 * Логирует один раз при старте — пользователь видит какие tools были скрыты политикой.
 * Принимает массив скрытых имён + риски — печатает компактно по группам.
 */
export function logHiddenTools(hidden: Array<{ name: string; risk: ToolRisk; reason: string }>): void {
  if (hidden.length === 0) return;
  const byReason = new Map<string, string[]>();
  for (const h of hidden) {
    const key = h.reason;
    const list = byReason.get(key) ?? [];
    list.push(h.name);
    byReason.set(key, list);
  }
  for (const [reason, names] of byReason) {
    logger.info(
      { count: names.length, reason, sample: names.slice(0, 5) },
      'tools hidden by policy',
    );
  }
}
