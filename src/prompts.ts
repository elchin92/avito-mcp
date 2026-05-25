/**
 * MCP Prompts (spec 2025-11-25). Готовые промпты, направляющие агента на типовые
 * Avito-операции. Не вызывают API сами — рендерят инструкцию для LLM, какие
 * tool'ы и в каком порядке использовать. Это уменьшает галлюцинации агента и
 * экономит контекст: одна prompt-операция вместо длинного "first do X, then Y".
 *
 *  - avito_daily_overview      — баланс + список объявлений + spendings
 *  - avito_check_unread_chats  — найти и резюмировать непрочитанные чаты
 *  - avito_safety_report       — раскрыть текущий режим safety + что заблокировано
 *  - avito_explain_tool        — описать один tool по имени (без вызова)
 *  - avito_promote_item        — что нужно перед покупкой VAS (suggests + цены)
 *
 * Все промпты рендерят role='user' message, как принято в MCP. Клиент может
 * подставить параметры (limit, item_id, tool_name) через completion API.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

import { logger } from './logger.js';
import type { ToolContext } from './core/tool-factory.js';

function userMessage(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  // ─────────── avito_daily_overview ───────────
  server.registerPrompt(
    'avito_daily_overview',
    {
      title: 'Avito: ежедневная сводка',
      description:
        'Готовый промпт для агента: проверить баланс, активные объявления и расходы за период. ' +
        'Все вызовы read-only — безопасно запускать на боевом аккаунте без подтверждений.',
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe('Период расходов в днях (по умолчанию 7).'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const days = Number.parseInt(args.days ?? '7', 10) || 7;
      const dateTo = new Date().toISOString().slice(0, 10);
      const dateFrom = new Date(Date.now() - days * 86400_000)
        .toISOString()
        .slice(0, 10);
      return {
        description: `Ежедневная сводка Avito за последние ${days} дней`,
        messages: [
          userMessage(
            `Подготовь ежедневную сводку моего Avito-аккаунта за последние ${days} дней.\n\n` +
              `Используй эти tools (все read-only, не требуют confirmation):\n` +
              `  1. user_get_user_balance — текущий баланс кошелька (real + bonus).\n` +
              `  2. items_get_items_info { status: "active", per_page: 50 } — активные объявления.\n` +
              `  3. items_post_account_spendings {\n` +
              `       dateFrom: "${dateFrom}",\n` +
              `       dateTo:   "${dateTo}",\n` +
              `       spendingTypes: ["vas","perf_vas","tariff","cpa"],\n` +
              `       grouping: { period: "day" }\n` +
              `     }\n\n` +
              `Сформируй итог: баланс, количество активных объявлений (по статусам), ` +
              `сумма расходов за период с разбивкой по типам. Без длинных таблиц.`,
          ),
        ],
      };
    },
  );

  // ─────────── avito_check_unread_chats ───────────
  server.registerPrompt(
    'avito_check_unread_chats',
    {
      title: 'Avito: непрочитанные чаты',
      description:
        'Найти непрочитанные чаты и показать последние сообщения. Read-only — не отправляет, ' +
        'только читает. Решение о пометке прочитанным или ответе оставляется человеку.',
      argsSchema: {
        limit: z
          .string()
          .optional()
          .describe('Сколько чатов смотреть (по умолчанию 20).'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const limit = Number.parseInt(args.limit ?? '20', 10) || 20;
      return {
        description: `Поиск до ${limit} непрочитанных чатов`,
        messages: [
          userMessage(
            `Найди непрочитанные чаты и кратко резюмируй последние сообщения.\n\n` +
              `Шаги:\n` +
              `  1. messenger_get_chats_v2 { unread_only: true, limit: ${limit} }\n` +
              `  2. Для каждого chat_id вызови messenger_get_messages_v3 { chat_id, limit: 5 } ` +
              `чтобы увидеть контекст. (Не больше 5 чатов параллельно — иначе rate-limit.)\n\n` +
              `На выходе: список { item_title, last_message_preview, unread_count }. ` +
              `НЕ вызывай messenger_chat_read и НЕ отвечай — это write/public операции, ` +
              `требуют явного решения человека.`,
          ),
        ],
      };
    },
  );

  // ─────────── avito_safety_report ───────────
  server.registerPrompt(
    'avito_safety_report',
    {
      title: 'Avito: отчёт о safety-режиме',
      description:
        'Сформировать ответ на вопрос «что я могу сейчас сделать с этим сервером». ' +
        'Использует MCP-resources (state/config + manifest), не дёргает Avito API.',
    },
    async (): Promise<GetPromptResult> => {
      return {
        description: 'Активный режим safety и текущие ограничения',
        messages: [
          userMessage(
            `Расскажи мне, в каком режиме работает avito-mcp прямо сейчас.\n\n` +
              `Шаги:\n` +
              `  1. Прочитай resource avito://state/config — там mode, allow/deny, ` +
              `confirmation_mode, hard_confirmation.\n` +
              `  2. Прочитай resource avito://manifest — посчитай tools по risk.\n` +
              `  3. Если что-то непонятно про режимы — прочитай avito://docs/safety.\n\n` +
              `Сформируй короткий ответ (3-5 предложений): какой mode, какие tools видимы, ` +
              `какие — спрятаны, требует ли money/public confirmation, и где hard-confirmation.`,
          ),
        ],
      };
    },
  );

  // ─────────── avito_explain_tool ───────────
  server.registerPrompt(
    'avito_explain_tool',
    {
      title: 'Avito: объяснить tool',
      description:
        'Дать развёрнутое описание одного tool по имени. Использует manifest + swagger ' +
        'из соответствующего домена.',
      argsSchema: {
        tool_name: z
          .string()
          .describe('Имя tool, например "items_update_price" или "messenger_get_chats_v2".'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const name = args.tool_name?.trim() ?? '';
      if (!name) {
        return {
          description: 'tool_name is required',
          messages: [userMessage('Укажи tool_name, например items_update_price.')],
        };
      }
      return {
        description: `Описание tool ${name}`,
        messages: [
          userMessage(
            `Объясни мне tool '${name}' из avito-mcp.\n\n` +
              `Шаги:\n` +
              `  1. Прочитай avito://manifest и найди запись { name: "${name}" }. ` +
              `Покажи её risk, domain, annotations, описание.\n` +
              `  2. Если есть соответствующий swagger в avito://swaggers/<имя> — ` +
              `найди endpoint и покажи его сырое описание из OpenAPI.\n` +
              `  3. В конце предупреди если risk=money/public — нужен confirmation flow.`,
          ),
        ],
      };
    },
  );

  // ─────────── avito_promote_item ───────────
  server.registerPrompt(
    'avito_promote_item',
    {
      title: 'Avito: подготовка к покупке VAS',
      description:
        'Безопасно подготовить продвижение объявления: проверить баланс, посмотреть suggests, ' +
        'узнать цены. НЕ покупает VAS — оставляет финальное решение человеку.',
      argsSchema: {
        item_id: z.string().describe('ID объявления Avito для продвижения.'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const itemId = args.item_id?.trim() ?? '';
      if (!itemId) {
        return {
          description: 'item_id is required',
          messages: [userMessage('Укажи item_id.')],
        };
      }
      return {
        description: `Подготовка продвижения для item ${itemId}`,
        messages: [
          userMessage(
            `Я хочу подумать про продвижение объявления ${itemId}. Не покупай ничего — собери информацию:\n\n` +
              `  1. user_get_user_balance — есть ли деньги.\n` +
              `  2. items_get_item_info { item_id: ${itemId} } — что это за объявление, ` +
              `статус, текущая цена.\n` +
              `  3. items_post_vas_prices { itemIds: [${itemId}] } — какие VAS доступны и почём.\n` +
              `  4. promotion_get_bbip_suggests_by_items_v1 { itemIds: [${itemId}] } — ` +
              `рекомендации Авито для этого объявления.\n\n` +
              `Сделай вывод: какой VAS даст лучший ROI с учётом баланса. ` +
              `Если решу покупать — я вызову items_put_item_vas / items_apply_vas сам, ` +
              `после confirmation flow.`,
          ),
        ],
      };
    },
  );

  logger.info({ promptCount: 5 }, 'MCP prompts registered');
  // ctx используется через server.server.sendLoggingMessage в bindMcpLogger;
  // здесь только для будущей расширяемости (например, фильтровать promos по mode).
  void ctx;
}
