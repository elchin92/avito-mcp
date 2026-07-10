/**
 * MCP Prompts (spec 2025-11-25). Ready-made prompts that guide an agent through
 * common Avito operations. They do not call the API themselves — they render an
 * instruction for the LLM about which tools to use and in what order. This
 * reduces agent hallucinations and saves context: a single prompt operation
 * instead of a lengthy "first do X, then Y".
 *
 *  - avito_daily_overview      — balance + list of listings + spendings
 *  - avito_check_unread_chats  — find and summarize unread chats
 *  - avito_safety_report       — reveal the current safety mode + what is blocked
 *  - avito_explain_tool        — describe a single tool by name (without calling it)
 *  - avito_promote_item        — what is needed before buying VAS (suggests + prices)
 *
 * All prompts render a role='user' message, as is standard in MCP. The client
 * can supply parameters (limit, item_id, tool_name) via the completion API.
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
      title: 'Avito: Daily Overview / ежедневная сводка',
      description:
        'Ready-made agent prompt: check the balance, active listings and spendings for a period. ' +
        'All calls are read-only — safe to run on a production account without confirmations. ' +
        'Готовый промпт для агента: проверить баланс, активные объявления и расходы за период. ' +
        'Все вызовы read-only — безопасно запускать на боевом аккаунте без подтверждений.',
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe('Spendings period in days (defaults to 7). / Период расходов в днях (по умолчанию 7).'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const days = Number.parseInt(args.days ?? '7', 10) || 7;
      const dateTo = new Date().toISOString().slice(0, 10);
      const dateFrom = new Date(Date.now() - days * 86400_000)
        .toISOString()
        .slice(0, 10);
      return {
        description: `Avito daily overview for the last ${days} days / Ежедневная сводка Avito за последние ${days} дней`,
        messages: [
          userMessage(
            `Prepare a daily overview of my Avito account for the last ${days} days.\n\n` +
              `Use these tools (all read-only, no confirmation required):\n` +
              `  1. user_get_user_balance — current wallet balance (real + bonus).\n` +
              `  2. items_get_items_info { status: "active", per_page: 50 } — active listings.\n` +
              `  3. items_post_account_spendings {\n` +
              `       dateFrom: "${dateFrom}",\n` +
              `       dateTo:   "${dateTo}",\n` +
              `       spendingTypes: ["vas","perf_vas","tariff","cpa"],\n` +
              `       grouping: "day"\n` +
              `     }\n\n` +
              `Produce a summary: balance, number of active listings (by status), ` +
              `total spendings for the period broken down by type. No long tables.` +
              `\n\n— Русский / Russian —\n\n` +
              `Подготовь ежедневную сводку моего Avito-аккаунта за последние ${days} дней.\n\n` +
              `Используй эти tools (все read-only, не требуют confirmation):\n` +
              `  1. user_get_user_balance — текущий баланс кошелька (real + bonus).\n` +
              `  2. items_get_items_info { status: "active", per_page: 50 } — активные объявления.\n` +
              `  3. items_post_account_spendings {\n` +
              `       dateFrom: "${dateFrom}",\n` +
              `       dateTo:   "${dateTo}",\n` +
              `       spendingTypes: ["vas","perf_vas","tariff","cpa"],\n` +
              `       grouping: "day"\n` +
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
      title: 'Avito: Unread Chats / непрочитанные чаты',
      description:
        'Find unread chats and show the latest messages. Read-only — it does not send, ' +
        'only reads. The decision to mark as read or reply is left to the human. ' +
        'Найти непрочитанные чаты и показать последние сообщения. Read-only — не отправляет, ' +
        'только читает. Решение о пометке прочитанным или ответе оставляется человеку.',
      argsSchema: {
        limit: z
          .string()
          .optional()
          .describe('How many chats to look at (defaults to 20). / Сколько чатов смотреть (по умолчанию 20).'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const limit = Number.parseInt(args.limit ?? '20', 10) || 20;
      return {
        description: `Search for up to ${limit} unread chats / Поиск до ${limit} непрочитанных чатов`,
        messages: [
          userMessage(
            `Find unread chats and briefly summarize the latest messages.\n\n` +
              `Steps:\n` +
              `  1. messenger_get_chats_v2 { unread_only: true, limit: ${limit} }\n` +
              `  2. For each chat_id call messenger_get_messages_v3 { chat_id, limit: 5 } ` +
              `to see the context. (No more than 5 chats in parallel — otherwise rate-limit.)\n\n` +
              `Output: a list of { item_title, last_message_preview, unread_count }. ` +
              `Do NOT call messenger_chat_read and do NOT reply — these are write/public operations ` +
              `that require an explicit human decision.` +
              `\n\n— Русский / Russian —\n\n` +
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
      title: 'Avito: Safety Mode Report / отчёт о safety-режиме',
      description:
        'Compose an answer to the question "what can I do with this server right now". ' +
        'Uses MCP resources (state/config + manifest), does not hit the Avito API. ' +
        'Сформировать ответ на вопрос «что я могу сейчас сделать с этим сервером». ' +
        'Использует MCP-resources (state/config + manifest), не дёргает Avito API.',
    },
    async (): Promise<GetPromptResult> => {
      return {
        description: 'Active safety mode and current restrictions / Активный режим safety и текущие ограничения',
        messages: [
          userMessage(
            `Tell me which mode avito-mcp is running in right now.\n\n` +
              `Steps:\n` +
              `  1. Read the resource avito://state/config — it has mode, allow/deny, ` +
              `confirmation_mode, hard_confirmation.\n` +
              `  2. Read the resource avito://manifest — count tools by risk.\n` +
              `  3. If anything about the modes is unclear, read avito://docs/safety.\n\n` +
              `Produce a short answer (3-5 sentences): which mode, which tools are visible, ` +
              `which are hidden, whether money/public confirmation is required, and where hard-confirmation applies.` +
              `\n\n— Русский / Russian —\n\n` +
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
      title: 'Avito: Explain a Tool / объяснить tool',
      description:
        'Give a detailed description of a single tool by name. Uses the manifest + swagger ' +
        'from the corresponding domain. ' +
        'Дать развёрнутое описание одного tool по имени. Использует manifest + swagger ' +
        'из соответствующего домена.',
      argsSchema: {
        tool_name: z
          .string()
          .describe('Tool name, e.g. "items_update_price" or "messenger_get_chats_v2". / Имя tool, например "items_update_price" или "messenger_get_chats_v2".'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const name = args.tool_name?.trim() ?? '';
      if (!name) {
        return {
          description: 'tool_name is required',
          messages: [userMessage('Provide tool_name, e.g. items_update_price.\n\n— Русский / Russian —\n\nУкажи tool_name, например items_update_price.')],
        };
      }
      return {
        description: `Description of tool ${name} / Описание tool ${name}`,
        messages: [
          userMessage(
            `Explain the tool '${name}' from avito-mcp to me.\n\n` +
              `Steps:\n` +
              `  1. Read avito://manifest and find the entry { name: "${name}" }. ` +
              `Show its risk, domain, annotations, description.\n` +
              `  2. If there is a corresponding swagger at avito://swaggers/<name>, ` +
              `find the endpoint and show its raw description from OpenAPI.\n` +
              `  3. At the end, warn if risk=money/public — a confirmation flow is required.` +
              `\n\n— Русский / Russian —\n\n` +
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
      title: 'Avito: Prepare to Buy VAS / подготовка к покупке VAS',
      description:
        'Safely prepare to promote a listing: check the balance, review suggests, ' +
        'look up prices. Does NOT buy VAS — leaves the final decision to the human. ' +
        'Безопасно подготовить продвижение объявления: проверить баланс, посмотреть suggests, ' +
        'узнать цены. НЕ покупает VAS — оставляет финальное решение человеку.',
      argsSchema: {
        item_id: z.string().describe('Avito listing ID to promote. / ID объявления Avito для продвижения.'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const itemId = args.item_id?.trim() ?? '';
      if (!itemId) {
        return {
          description: 'item_id is required',
          messages: [userMessage('Provide item_id.\n\n— Русский / Russian —\n\nУкажи item_id.')],
        };
      }
      return {
        description: `Promotion preparation for item ${itemId} / Подготовка продвижения для item ${itemId}`,
        messages: [
          userMessage(
            `I want to consider promoting listing ${itemId}. Do not buy anything — gather information:\n\n` +
              `  1. user_get_user_balance — whether there are funds.\n` +
              `  2. items_get_item_info { item_id: ${itemId} } — what this listing is, ` +
              `its status, current price.\n` +
              `  3. items_post_vas_prices { itemIds: [${itemId}] } — which VAS are available and at what price.\n` +
              `  4. promotion_get_bbip_suggests_by_items_v1 { itemIds: [${itemId}] } — ` +
              `Avito's recommendations for this listing.\n\n` +
              `Draw a conclusion: which VAS gives the best ROI given the balance. ` +
              `If I decide to buy — I will call items_put_item_vas / items_apply_vas myself, ` +
              `after the confirmation flow.` +
              `\n\n— Русский / Russian —\n\n` +
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
  // ctx is used via server.server.sendLoggingMessage in bindMcpLogger;
  // here it is only for future extensibility (e.g. filtering prompts by mode).
  void ctx;
}
