/**
 * Мета-tools — не относятся к swagger, нужны для observability и safety самого MCP-сервера.
 *
 * v0.6.x: rate-limits + confirmation flow.
 * v0.7.0: добавлены health / auth_status / capabilities со строгим outputSchema —
 *         универсальные диагностические tools, полезные любому MCP-клиенту.
 *
 * Confirmation tools регистрируются только когда AVITO_MCP_CONFIRMATION_MODE != 'off'.
 * Все meta_* — local environment, без обращения к Avito API (кроме auth_status,
 * который опционально пробует ping через client_credentials refresh).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { logger } from '../logger.js';
import { evaluatePolicy, requiresConfirmation } from '../core/policy.js';
import type { DomainRegister } from '../core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

/**
 * Constant-time secret comparison. Equal-length buffers required by Node's
 * timingSafeEqual; length mismatch short-circuits to false without leaking length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
        title: 'Состояние rate-limits',
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
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const snaps = ctx.client.rateLimiter.getStatus();
        if (snaps.length === 0) {
          return {
            content: [
              { type: 'text', text: 'Нет данных: ни одного запроса к Avito ещё не сделано.' },
            ],
            structuredContent: { snapshots: [], count: 0 },
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(snaps, null, 2) }],
          structuredContent: { snapshots: snaps, count: snaps.length },
        };
      },
    );
  }

  // ───────────────── v0.7.0: meta_health ─────────────────

  const healthDecision = evaluatePolicy('meta_health', 'read', ctx.config);
  if (healthDecision.allowed) {
    server.registerTool(
      'meta_health',
      {
        title: 'Health: общее состояние сервера',
        description:
          'Универсальный health-check: версия пакета, активные capabilities, состояние ' +
          'rate-limits, idempotency ledger size, pending actions count, dryRun-default. ' +
          'Не дёргает Avito API. Безопасно вызывать сколько угодно.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        outputSchema: {
          ok: z.boolean(),
          name: z.string(),
          version: z.string(),
          uptimeSec: z.number(),
          capabilities: z.object({
            tools: z.boolean(),
            resources: z.boolean(),
            prompts: z.boolean(),
            logging: z.boolean(),
          }),
          safety: z.object({
            mode: z.string(),
            confirmationMode: z.string(),
            hardConfirmation: z.boolean(),
            dryRunDefault: z.boolean(),
            exposeAuthTools: z.boolean(),
          }),
          counters: z.object({
            pendingActions: z.number().int(),
            idempotencyEntries: z.number().int(),
            rateLimitSnapshots: z.number().int(),
          }),
          timestamp: z.string(),
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const payload = {
          ok: true,
          name: PACKAGE_NAME,
          version: VERSION,
          uptimeSec: Math.round(process.uptime()),
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            logging: true,
          },
          safety: {
            mode: ctx.config.mode,
            confirmationMode: ctx.config.confirmationMode,
            hardConfirmation: !!ctx.config.confirmationSecret,
            dryRunDefault: ctx.config.dryRunDefault,
            exposeAuthTools: ctx.config.exposeAuthTools,
          },
          counters: {
            pendingActions: ctx.pendingStore.size(),
            idempotencyEntries: ctx.idempotencyStore?.size() ?? 0,
            rateLimitSnapshots: ctx.client.rateLimiter.getStatus().length,
          },
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  } else {
    logger.info(
      { tool: 'meta_health', risk: 'read', reason: healthDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── v0.7.0: meta_auth_status ─────────────────

  const authStatusDecision = evaluatePolicy('meta_auth_status', 'read', ctx.config);
  if (authStatusDecision.allowed) {
    server.registerTool(
      'meta_auth_status',
      {
        title: 'Auth: состояние OAuth-токена (без секретов)',
        description:
          'Сообщает только МЕТАДАННЫЕ токена: present/absent, expiresInSec, последняя ошибка ' +
          'refresh. Сам токен НИКОГДА не отдаётся — для этого используйте auth_* tools под ' +
          'AVITO_MCP_EXPOSE_AUTH_TOOLS=1 (скрыты по default). По умолчанию не вынуждает refresh — ' +
          'если probe=true, попытается getToken() (это может вызвать refresh).',
        inputSchema: {
          probe: z
            .boolean()
            .optional()
            .describe(
              'Если true — попробовать getToken(), что может вызвать refresh при истёкшем токене. Default false.',
            ),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        outputSchema: {
          configured: z.boolean(),
          tokenPresent: z.boolean(),
          expiresInSec: z.number().int().nullable(),
          probeOk: z.boolean().nullable(),
          lastError: z.string().nullable(),
          tokenFile: z.string(),
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (args): Promise<CallToolResult> => {
        const configured = !!ctx.config.clientId && !!ctx.config.clientSecret;
        // tokenStore.cache — internal; используем тонкий путь: getToken() возвращает строку,
        // но мы не должны её отдавать наружу. Поэтому только метаданные через приватный пробник.
        let probeOk: boolean | null = null;
        let lastError: string | null = null;
        let expiresInSec: number | null = null;
        if (args.probe === true && configured) {
          try {
            await ctx.client.tokenStore.getToken();
            probeOk = true;
          } catch (err) {
            probeOk = false;
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        // Читаем файл напрямую — токен сам в выходе НЕ показываем, только expiresAt.
        try {
          const fs = await import('node:fs/promises');
          const raw = await fs.readFile(ctx.config.tokenFile, 'utf8');
          const parsed = JSON.parse(raw) as { expiresAt?: number };
          if (typeof parsed.expiresAt === 'number') {
            expiresInSec = Math.max(0, Math.floor((parsed.expiresAt - Date.now()) / 1000));
          }
        } catch {
          /* нет файла — токен ещё не получен */
        }
        const payload = {
          configured,
          tokenPresent: expiresInSec !== null,
          expiresInSec,
          probeOk,
          lastError,
          tokenFile: ctx.config.tokenFile,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  } else {
    logger.info(
      { tool: 'meta_auth_status', risk: 'read', reason: authStatusDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── v0.7.0: meta_capabilities ─────────────────

  const capDecision = evaluatePolicy('meta_capabilities', 'read', ctx.config);
  if (capDecision.allowed) {
    server.registerTool(
      'meta_capabilities',
      {
        title: 'Capabilities: что включено в этом запуске',
        description:
          'Возвращает машинно-читаемое описание текущей конфигурации: режим, allow/deny lists, ' +
          'confirmation, dry-run, idempotency, доступ к локальным файлам. Полезно агенту чтобы ' +
          'понять, какие операции принципиально доступны до того как пробовать вызывать tools.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        outputSchema: {
          name: z.string(),
          version: z.string(),
          mode: z.string(),
          allowToolsCount: z.number().int(),
          denyToolsCount: z.number().int(),
          features: z.object({
            dryRun: z.boolean(),
            idempotency: z.boolean(),
            confirmation: z.boolean(),
            hardConfirmation: z.boolean(),
            fileUploads: z.boolean(),
            sensitiveAuthTools: z.boolean(),
          }),
          confirmationMode: z.string(),
          dryRunDefault: z.boolean(),
          idempotencyTtlSec: z.number().int(),
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const payload = {
          name: PACKAGE_NAME,
          version: VERSION,
          mode: ctx.config.mode,
          allowToolsCount: ctx.config.allowTools.length,
          denyToolsCount: ctx.config.denyTools.length,
          features: {
            dryRun: true,
            idempotency: !!ctx.idempotencyStore,
            confirmation: ctx.config.confirmationMode !== 'off',
            hardConfirmation: !!ctx.config.confirmationSecret,
            fileUploads: ctx.config.allowedUploadDirs.length > 0,
            sensitiveAuthTools: ctx.config.exposeAuthTools,
          },
          confirmationMode: ctx.config.confirmationMode,
          dryRunDefault: ctx.config.dryRunDefault,
          idempotencyTtlSec: ctx.config.idempotencyTtlSec,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  } else {
    logger.info(
      { tool: 'meta_capabilities', risk: 'read', reason: capDecision.reason },
      'tool hidden by policy',
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

  // v0.5.1: каждый confirmation tool ОТДЕЛЬНО проходит через evaluatePolicy.
  // До v0.5.0 они проскакивали мимо allow/deny — это нарушало контракт.
  // Теперь allowlist/denylist полностью охватывает реестр.
  const confirmDecision = evaluatePolicy('meta_confirm_action', 'write', ctx.config);
  const cancelDecision = evaluatePolicy('meta_cancel_action', 'write', ctx.config);
  const listDecision = evaluatePolicy('meta_list_pending_actions', 'read', ctx.config);

  // DX warning: если confirmation включён, money/public tools будут возвращать pending,
  // но если meta_confirm_action заблокирован — pending некому подтвердить.
  if (!confirmDecision.allowed) {
    logger.warn(
      { reason: confirmDecision.reason, confirmationMode: ctx.config.confirmationMode },
      'AVITO_MCP_CONFIRMATION_MODE is enabled but meta_confirm_action is hidden by policy — ' +
        'pending actions will be unconfirmable. Either add meta_confirm_action to your allowlist ' +
        'or set AVITO_MCP_CONFIRMATION_MODE=off.',
    );
  }

  // ───────────────── meta_confirm_action ─────────────────

  const requireSecret = !!ctx.config.confirmationSecret;
  if (confirmDecision.allowed) server.registerTool(
    'meta_confirm_action',
    {
      title: '✓ Подтвердить отложенное действие',
      description:
        '⚠️ Выполняет ранее отложенное действие по его confirmation_id. ' +
        'Применять ТОЛЬКО после явного подтверждения человеком — flow задуман как server-side ' +
        'two-step guard от случайного one-shot выполнения, не как криптографическая защита ' +
        'от автономного агента. Confirmation одноразовый: после успешного вызова id удаляется. ' +
        (requireSecret
          ? 'AVITO_MCP_CONFIRMATION_SECRET задан: дополнительно нужен параметр confirmation_secret ' +
            '(сравнивается constant-time). Без него подтверждение отклоняется. Это hard-confirmation ' +
            '— секрет генерируется и хранится у человека, агент его получить не может.'
          : 'AVITO_MCP_CONFIRMATION_SECRET не задан — работает soft-confirmation. ' +
            'Установите env-переменную чтобы перейти на hard-confirmation.'),
      inputSchema: {
        confirmation_id: z
          .string()
          .min(16)
          .describe('ID отложенного действия (возвращается полем confirmation_id при первом вызове tool).'),
        confirmation_secret: z
          .string()
          .optional()
          .describe(
            requireSecret
              ? 'Обязательное значение AVITO_MCP_CONFIRMATION_SECRET (вводится человеком).'
              : 'Не используется когда AVITO_MCP_CONFIRMATION_SECRET не задан.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { risk: 'write', environment: 'local' },
    },
    async (args): Promise<CallToolResult> => {
      const id = String(args.confirmation_id ?? '');

      // Hard-confirmation: проверка секрета ДО любых других действий.
      if (requireSecret) {
        const provided = typeof args.confirmation_secret === 'string' ? args.confirmation_secret : '';
        if (!provided || !secretsMatch(provided, ctx.config.confirmationSecret!)) {
          logger.warn(
            { confirmation_id: id, hasSecret: !!provided },
            'confirmation rejected: bad or missing confirmation_secret',
          );
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  'Bad or missing confirmation_secret. AVITO_MCP_CONFIRMATION_SECRET is configured — ' +
                  'every confirmation requires the human-typed secret. Pending action is NOT deleted by this rejection; ' +
                  'retry with the correct secret before the TTL expires, or call meta_cancel_action to discard it.',
              },
            ],
          };
        }
      }

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
        {
          tool: pending.toolName,
          risk: pending.risk,
          confirmation_id: id,
          hardConfirmation: requireSecret,
        },
        'pending action confirmed and executing',
      );
      return pending.execute();
    },
  );

  if (!confirmDecision.allowed) {
    logger.info(
      { tool: 'meta_confirm_action', risk: 'write', reason: confirmDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── meta_cancel_action ─────────────────

  if (cancelDecision.allowed) server.registerTool(
    'meta_cancel_action',
    {
      title: '✗ Отменить отложенное действие',
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
      _meta: { risk: 'write', environment: 'local' },
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
        structuredContent: { confirmation_id: id, cancelled: existed },
      };
    },
  );

  if (!cancelDecision.allowed) {
    logger.info(
      { tool: 'meta_cancel_action', risk: 'write', reason: cancelDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── meta_list_pending_actions ─────────────────

  if (listDecision.allowed) server.registerTool(
    'meta_list_pending_actions',
    {
      title: 'Pending actions: список',
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
      _meta: { risk: 'read', environment: 'local' },
    },
    async (): Promise<CallToolResult> => {
      const items = ctx.pendingStore.list();
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: 'Нет pending actions.' }],
          structuredContent: { pending: [], count: 0, confirmation_mode: ctx.config.confirmationMode },
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
        structuredContent: {
          pending: view,
          count: view.length,
          confirmation_mode: ctx.config.confirmationMode,
        },
      };
    },
  );
  if (!listDecision.allowed) {
    logger.info(
      { tool: 'meta_list_pending_actions', risk: 'read', reason: listDecision.reason },
      'tool hidden by policy',
    );
  }
};
