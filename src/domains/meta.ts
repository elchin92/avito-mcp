/**
 * Мета-tools — не относятся к swagger, нужны для observability и safety самого MCP-сервера.
 *
 * - `meta_get_rate_limits` — последние X-RateLimit-* по доменам Avito API
 * - `meta_confirm_action` — подтверждает pending action из confirmation flow
 * - `meta_cancel_action` — отменяет pending action
 * - `meta_list_pending_actions` — список текущих pending actions (без секретов в выводе)
 *
 * Три последних регистрируются только когда AVITO_MCP_CONFIRMATION_MODE != 'off'.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logger } from '../logger.js';
import { evaluatePolicy, requiresConfirmation } from '../core/policy.js';
import type { DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // ───────────────── meta_get_rate_limits ─────────────────

  const rlDecision = evaluatePolicy('meta_get_rate_limits', 'read', ctx.config);
  if (!rlDecision.allowed) {
    logger.info(
      { tool: 'meta_get_rate_limits', risk: 'read', reason: rlDecision.reason },
      'tool hidden by policy',
    );
  } else {
    server.registerTool(
      'meta_get_rate_limits',
      {
        description:
          'Возвращает последние увиденные значения X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset, ' +
          'сгруппированные по логическим доменам API (core, messenger, items и т.д.). ' +
          'Полезно для диагностики "почему меня троттлят" — Avito выставляет лимит на минуту.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { risk: 'read' },
      },
      async (): Promise<CallToolResult> => {
        const snaps = ctx.client.rateLimiter.getStatus();
        if (snaps.length === 0) {
          return {
            content: [
              { type: 'text', text: 'Нет данных: ни одного запроса к Avito ещё не сделано.' },
            ],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(snaps, null, 2) }],
        };
      },
    );
  }

  // Confirmation tools регистрируются только если confirmation flow включён.
  // Это и проще для агента (нет посторонних tools когда они бессмысленны),
  // и снижает surface когда confirmation выключен сознательно.
  if (ctx.config.confirmationMode === 'off') {
    logger.info(
      { confirmationMode: 'off' },
      'confirmation tools hidden because AVITO_MCP_CONFIRMATION_MODE=off',
    );
    return;
  }

  // ───────────────── meta_confirm_action ─────────────────

  server.registerTool(
    'meta_confirm_action',
    {
      description:
        '⚠️ Выполняет ранее отложенное действие по его confirmation_id. ' +
        'Применять ТОЛЬКО после явного подтверждения человеком — flow задуман как server-side ' +
        'two-step guard от случайного one-shot выполнения, не как криптографическая защита ' +
        'от автономного агента. Confirmation одноразовый: после успешного вызова id удаляется. ' +
        'Если pending истёк, был отменён или tool теперь запрещён политикой — вернётся ошибка.',
      inputSchema: {
        confirmation_id: z
          .string()
          .min(16)
          .describe('ID отложенного действия (возвращается полем confirmation_id при первом вызове tool).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { risk: 'write' },
    },
    async (args): Promise<CallToolResult> => {
      const id = String(args.confirmation_id ?? '');
      const pending = ctx.pendingStore.get(id);
      if (!pending) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Confirmation '${id}' не найден. Возможные причины: id невалиден, истёк TTL (${ctx.config.confirmationTtlSec}s), уже подтверждён или отменён.`,
            },
          ],
        };
      }
      // Re-evaluate policy — пользователь мог поменять конфиг между create и confirm.
      const decision = evaluatePolicy(pending.toolName, pending.risk, ctx.config);
      if (!decision.allowed) {
        ctx.pendingStore.delete(id);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Tool '${pending.toolName}' больше не разрешён политикой: ${decision.reason}. Pending удалён.`,
            },
          ],
        };
      }
      // One-time use: удаляем ДО выполнения, чтобы повторный confirm даже при race не сработал.
      ctx.pendingStore.delete(id);
      logger.info(
        { tool: pending.toolName, risk: pending.risk, confirmation_id: id },
        'pending action confirmed and executing',
      );
      return pending.execute();
    },
  );

  // ───────────────── meta_cancel_action ─────────────────

  server.registerTool(
    'meta_cancel_action',
    {
      description:
        'Отменяет ранее отложенное действие. После cancel confirmation_id перестаёт быть валидным.',
      inputSchema: {
        confirmation_id: z
          .string()
          .min(16)
          .describe('ID отложенного действия для отмены.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { risk: 'write' },
    },
    async (args): Promise<CallToolResult> => {
      const id = String(args.confirmation_id ?? '');
      const existed = ctx.pendingStore.delete(id);
      return {
        content: [
          {
            type: 'text',
            text: existed
              ? `Pending action '${id}' отменён.`
              : `Pending action '${id}' не найден (возможно, уже истёк, был подтверждён или отменён).`,
          },
        ],
      };
    },
  );

  // ───────────────── meta_list_pending_actions ─────────────────

  server.registerTool(
    'meta_list_pending_actions',
    {
      description:
        'Список текущих pending actions, ожидающих подтверждения. Args не показываются — ' +
        'только tool name, risk, краткое summary, времена создания и истечения. ' +
        'Используйте для диагностики "что я только что попросил подтвердить".',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { risk: 'read' },
    },
    async (): Promise<CallToolResult> => {
      const items = ctx.pendingStore.list();
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: 'Нет pending actions.' }],
        };
      }
      const view = items.map((a) => ({
        id: a.id,
        tool: a.toolName,
        risk: a.risk,
        summary: a.summary,
        created_at: new Date(a.createdAt).toISOString(),
        expires_at: new Date(a.expiresAt).toISOString(),
        // Не: args, потому что они могут содержать item_id, message_id, цены и т.п. в нежелательном объёме
        // Не: execute, потому что это closure
      }));
      const requiresHint =
        `\n\nConfirmation mode = ${ctx.config.confirmationMode}. ` +
        `Требуют confirmation в этом режиме: ` +
        (requiresConfirmation('money', ctx.config) ? 'money ' : '') +
        (requiresConfirmation('public', ctx.config) ? 'public ' : '') +
        (requiresConfirmation('write', ctx.config) ? 'write ' : '');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(view, null, 2) + requiresHint,
          },
        ],
      };
    },
  );
};
