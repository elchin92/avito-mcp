/**
 * MCP Prompts. Ready-made prompts that guide an agent through common Avito
 * operations. They do not call the API themselves — they render an instruction
 * for the LLM about which tools to use and in what order. This reduces agent
 * hallucinations and saves context: a single prompt operation instead of a
 * lengthy "first do X, then Y".
 *
 *  - avito_daily_overview      — balance + list of listings + spendings
 *  - avito_check_unread_chats  — find and summarize unread chats
 *  - avito_safety_report       — reveal the current safety mode + what is blocked
 *  - avito_explain_tool        — describe a single tool by name (without calling it)
 *  - avito_promote_item        — what is needed before buying VAS (suggests + prices)
 *
 * All prompts render a role='user' message, as is standard in MCP. The client
 * can supply parameters (limit, item_id, tool_name) via the completion API.
 *
 * ── M1.8. Why the arguments are validated the way they are ──────────────────
 *
 * This file is a text-injection surface, and until M1.8 it was an unguarded
 * one. `tool_name` and `item_id` arrive as arbitrary caller strings and are
 * interpolated straight into the text of a prompt that goes on to TELL A MODEL
 * WHAT TO DO — including which money/public tools exist and that a confirmation
 * flow guards them. Anything a caller can put in those two fields becomes
 * instructions in the model's context, sitting under this server's name.
 *
 * Revision 2026-07-28 is explicit that this is the server's job:
 *
 *   > Servers **SHOULD**: Validate all arguments … Implementations **MUST**
 *   > carefully validate all prompt inputs and outputs to prevent injection
 *   > attacks or unauthorized access to resources.
 *   > — https://modelcontextprotocol.io/specification/2026-07-28/server/prompts
 *
 * and that a bad argument is a refusal, not a stub: `-32602` covers "invalid
 * arguments" and "missing required arguments" for `prompts/get`
 * (`docs/mcp-2026-07-28/schema-2.md`). On that era a blank required argument
 * used to produce a SUCCESSFUL result whose text asked the model to supply the
 * value — an answer the client cannot distinguish from a real expansion, so an
 * agent would happily hand it to the model and act on a prompt that never
 * rendered.
 *
 * Two layers, and both are load-bearing:
 *
 *   1. **Allowlists in the schema.** Every argument is constrained to a
 *      character set with no expressive power: digits for `item_id` and the
 *      numeric arguments, `[a-z0-9_]` for `tool_name`. A value that cannot
 *      contain a newline, a quote, a bracket or a non-Latin letter cannot carry
 *      an instruction, so validation here is not "escaping done well", it is
 *      escaping made unnecessary. Failure is the SDK's own `-32602` from
 *      `prompts/get`, with the offending field named.
 *   2. **A sweep at the interpolation point** ({@link promptSafeText}). Layer 1
 *      is the guarantee; layer 2 is what survives someone loosening a schema
 *      later, and it refuses control characters, bidi/zero-width formatting and
 *      over-long values wherever they come from. It is a second opinion on
 *      every value that reaches prompt text, and it fails the same `-32602`.
 *
 * ── Era: MODERN ONLY, and why the first attempt at "both" was a regression ──
 *
 * M1.8 originally installed both layers on both eras, arguing that the old
 * behaviour was a defect on 2025-11-25 as well. It was — and installing the fix
 * on the 2025 wire was still wrong, because §1.2.B is not a promise to keep
 * 1.3.3's GOOD answers. It is a promise that a client which worked against
 * 1.3.3 keeps working, and that promise is worth nothing if the server gets to
 * decide which of 1.3.3's answers were worth keeping.
 *
 * The cost was measured, not theorised. Against a real 1.3.3 build, seventeen
 * of the nineteen prompt-argument forms the bench now sends moved from a
 * rendered prompt to `-32602`: `avito_explain_tool` with an empty value, with a
 * newline, with bidi or zero-width formatting, with a 5000-character value;
 * `avito_promote_item` with anything that is not bare digits; `days` and
 * `limit` outside the new bounds — every one of them an answer 1.3.3 gave and a
 * 2025 client may be relying on. A client that sends `days=0` and gets a
 * seven-day window today gets a hard error instead, on an upgrade it was told
 * was wire-compatible.
 *
 * This is the same shape as the `-32700`-on-an-unreadable-body divergence, and
 * it gets the same answer: an ERA SPLIT, not a rollback.
 *
 *   • **legacy (2025-11-25)** — byte-identical to 1.3.3: `z.string()` with no
 *     pattern, `Number.parseInt(x) || default` for the counts, `trim()` and the
 *     "…is required" stub for a blank required argument. Pinned by
 *     `test/legacy-wire-regression.test.ts` against a captured 1.3.3 process.
 *   • **modern (2026-07-28)** — both layers above, in full. This is the era the
 *     MUST is written for, it has no installed base to break, and it is the era
 *     block F of the plan puts into production.
 *
 * What that trade buys the legacy leg, stated plainly: a 2025 client can still
 * put arbitrary text into `avito_explain_tool`'s rendered prompt. It could
 * always do that; the mitigation there is the era migration itself, not a
 * silent behaviour change inside a compatibility contract.
 */
import { z } from 'zod';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type {
  McpServer,
  GetPromptResult,
  PromptMessage,
  ProtocolEra,
} from '@modelcontextprotocol/server';
import { logger } from './logger.js';
import { toolContextEra, type ToolContext } from './core/tool-factory.js';

function userMessage(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

/**
 * Characters that must never reach the text of a prompt, whatever schema let
 * them through.
 *
 *   • U+0000–U+001F and U+007F–U+009F — C0/C1 controls. A newline is
 *     the cheapest injection there is: it ends the sentence the server wrote
 *     and starts one the caller wrote, in the same message.
 *   • U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 and U+FEFF — zero-width
 *     and bidirectional-override formatting. These are invisible in every
 *     review surface a human uses and change what the rendered text reads as,
 *     which makes them the standard way to smuggle text past a reader who
 *     approves a prompt on sight.
 */
const UNSAFE_PROMPT_TEXT =
  // eslint-disable-next-line no-control-regex -- matching them is exactly the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * The longest a caller-supplied value may be once it is inside prompt text.
 * Far above every allowlist in this file (a tool name is capped at 64
 * characters, an item id at 19); it is the bound that applies to a field whose
 * own limit is ever relaxed.
 */
const MAX_PROMPT_ARGUMENT_CHARS = 128;

/** The refusal a bad prompt argument earns, naming the field and nothing else. */
function invalidPromptArgument(field: string, why: string): ProtocolError {
  // The value is not echoed: it is caller-chosen text, and reflecting it would
  // put the very thing that was refused into the client's logs and UI.
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Invalid value for prompt argument ${field}: ${why}`,
  );
}

/**
 * The form of a caller-supplied value that may be interpolated into prompt
 * text, or a `-32602` if there is none.
 *
 * Deliberately a REFUSAL rather than a sanitiser that strips and continues:
 * silently rewriting an argument would hand the model a prompt the caller did
 * not ask for and cannot see, which is a quieter version of the same problem.
 *
 * Reached on the MODERN era only — see the era note in the file header. Nothing
 * about the function is era-aware; the era decides whether it is installed.
 */
export function promptSafeText(field: string, value: string): string {
  if (value.length > MAX_PROMPT_ARGUMENT_CHARS) {
    return raise(field, `longer than ${MAX_PROMPT_ARGUMENT_CHARS} characters`);
  }
  if (UNSAFE_PROMPT_TEXT.test(value)) {
    return raise(field, 'contains a control or bidirectional formatting character');
  }
  return value;
}

function raise(field: string, why: string): never {
  throw invalidPromptArgument(field, why);
}

/**
 * The shape of a tool name on this server, as an allowlist.
 *
 * Deliberately syntactic rather than a lookup against the live registry. A
 * registry check would tie the prompt's answer to the deployment's safety
 * policy — asking about a tool the operator has hidden would become an error
 * rather than an explanation, which is the opposite of what a "explain a tool"
 * prompt is for, and it would leak which tools a policy hides. The pattern is
 * the same one `src/meta/tool-naming.ts` produces (`<domain>_<operation>`), so
 * anything outside it names nothing this server could describe anyway.
 *
 * What matters for injection is the CHARACTER SET: `[a-z0-9_]` cannot express a
 * sentence, a newline, a quote or a markup delimiter.
 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** An Avito listing id: digits only, within the range a 64-bit id can occupy. */
const ITEM_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

/** The longest spendings window `avito_daily_overview` will build a date range for. */
const MAX_OVERVIEW_DAYS = 365;

/** The most chats `avito_check_unread_chats` will ask the agent to walk. */
const MAX_CHAT_LIMIT = 100;

/** Defaults, shared by both eras so the two cannot drift apart on the happy path. */
const DEFAULT_OVERVIEW_DAYS = 7;
const DEFAULT_CHAT_LIMIT = 20;

// ─────────────────── the descriptors, identical on both eras ─────────────────
//
// `prompts/list` renders these verbatim, and that answer is frozen by §1.2.B
// (step `05-prompts-list` of the reference bench). They are named constants so
// the two registration branches below cannot drift: an era split is allowed to
// change what an argument ACCEPTS, never what the catalogue SAYS about it.

const DAYS_DESCRIPTION =
  'Spendings period in days (defaults to 7). / Период расходов в днях (по умолчанию 7).';
const LIMIT_DESCRIPTION =
  'How many chats to look at (defaults to 20). / Сколько чатов смотреть (по умолчанию 20).';
const TOOL_NAME_DESCRIPTION =
  'Tool name, e.g. "items_update_price" or "messenger_get_chats_v2". / Имя tool, например "items_update_price" или "messenger_get_chats_v2".';
const ITEM_ID_DESCRIPTION = 'Avito listing ID to promote. / ID объявления Avito для продвижения.';

const DAILY_OVERVIEW_META = {
  title: 'Avito: Daily Overview / ежедневная сводка',
  description:
    'Ready-made agent prompt: check the balance, active listings and spendings for a period. ' +
    'All calls are read-only — safe to run on a production account without confirmations. ' +
    'Готовый промпт для агента: проверить баланс, активные объявления и расходы за период. ' +
    'Все вызовы read-only — безопасно запускать на боевом аккаунте без подтверждений.',
} as const;

const UNREAD_CHATS_META = {
  title: 'Avito: Unread Chats / непрочитанные чаты',
  description:
    'Find unread chats and show the latest messages. Read-only — it does not send, ' +
    'only reads. The decision to mark as read or reply is left to the human. ' +
    'Найти непрочитанные чаты и показать последние сообщения. Read-only — не отправляет, ' +
    'только читает. Решение о пометке прочитанным или ответе оставляется человеку.',
} as const;

const EXPLAIN_TOOL_META = {
  title: 'Avito: Explain a Tool / объяснить tool',
  description:
    'Give a detailed description of a single tool by name. Uses the manifest + swagger ' +
    'from the corresponding domain. ' +
    'Дать развёрнутое описание одного tool по имени. Использует manifest + swagger ' +
    'из соответствующего домена.',
} as const;

const PROMOTE_ITEM_META = {
  title: 'Avito: Prepare to Buy VAS / подготовка к покупке VAS',
  description:
    'Safely prepare to promote a listing: check the balance, review suggests, ' +
    'look up prices. Does NOT buy VAS — leaves the final decision to the human. ' +
    'Безопасно подготовить продвижение объявления: проверить баланс, посмотреть suggests, ' +
    'узнать цены. НЕ покупает VAS — оставляет финальное решение человеку.',
} as const;

/**
 * A prompt argument holding a bounded count — MODERN only.
 *
 * MCP prompt arguments are strings on the wire, so the bound is expressed on
 * the decimal form and re-checked as a number: `"7"` is accepted, `"0"`, `"-1"`,
 * `"1e3"`, `"07 "` and `"9999"` are not. The legacy era keeps 1.3.3's
 * `Number.parseInt(...) || fallback`, which accepts `"-500"` (a date window
 * running into the future) and `"99999"` (a request the agent will be
 * rate-limited on) and silently rewrites every other malformation to the
 * default — bugs, and bugs a 2025 client is entitled to keep receiving.
 */
function countArgument(field: string, max: number, description: string) {
  return z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/, `${field} must be a decimal integer without a leading zero`)
    .refine((value) => Number(value) <= max, `${field} must be at most ${max}`)
    .optional()
    .describe(description);
}

// ───────────────────────────── the rendered text ─────────────────────────────
//
// Pure functions of the already-decided values, shared by both eras. The two
// registration branches differ ONLY in what they accept and in what they do
// with a blank required argument; a prompt that rendered on 1.3.3 must render
// the same bytes here, and the single source is what makes that mechanical
// rather than a matter of keeping two copies in step.

function dailyOverviewResult(days: number): GetPromptResult {
  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
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
          `       spendingTypes: ["all"],\n` +
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
          `       spendingTypes: ["all"],\n` +
          `       grouping: "day"\n` +
          `     }\n\n` +
          `Сформируй итог: баланс, количество активных объявлений (по статусам), ` +
          `сумма расходов за период с разбивкой по типам. Без длинных таблиц.`,
      ),
    ],
  };
}

function unreadChatsResult(limit: number): GetPromptResult {
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
}

function explainToolResult(name: string): GetPromptResult {
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
}

function promoteItemResult(itemId: string): GetPromptResult {
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
}

/**
 * 1.3.3's answer to a required argument that is blank or all whitespace: a
 * SUCCESSFUL result asking the model to supply the value.
 *
 * It is a defect — a client cannot tell it from a prompt that expanded — and it
 * is reproduced verbatim on the legacy era anyway, because a 2025 client that
 * renders this stub today would get `-32602` instead, and §1.2.B is a promise
 * about answers, not about which of them we would write again.
 */
function requiredArgumentStub(field: string, text: string): GetPromptResult {
  return { description: `${field} is required`, messages: [userMessage(text)] };
}

const safetyReportResult = (): GetPromptResult => ({
  description:
    'Active safety mode and current restrictions / Активный режим safety и текущие ограничения',
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
});

// ───────────────────────────── registration ──────────────────────────────────
//
// One function per prompt, each holding BOTH eras, rather than one function per
// era holding all five. The reason is `prompts/list`: array order is meaning
// there, the reference bench compares that answer element by element, and two
// per-era lists are one careless edit away from registering the same five
// prompts in two different orders. Here the order is written once, in
// `registerPrompts`, and neither era can change it.

/** `avito_daily_overview` — `days` is a bounded integer on 2026, anything on 2025. */
function registerDailyOverview(server: McpServer, era: ProtocolEra): void {
  if (era === 'modern') {
    server.registerPrompt(
      'avito_daily_overview',
      {
        ...DAILY_OVERVIEW_META,
        argsSchema: z.object({
          days: countArgument('days', MAX_OVERVIEW_DAYS, DAYS_DESCRIPTION),
        }),
      },
      async (args): Promise<GetPromptResult> =>
        // No fallback arithmetic left: the schema has already refused everything
        // that is not a decimal integer in range, so the only case left is absent.
        dailyOverviewResult(args.days === undefined ? DEFAULT_OVERVIEW_DAYS : Number(args.days)),
    );
    return;
  }
  server.registerPrompt(
    'avito_daily_overview',
    {
      ...DAILY_OVERVIEW_META,
      argsSchema: z.object({ days: z.string().optional().describe(DAYS_DESCRIPTION) }),
    },
    async (args): Promise<GetPromptResult> =>
      dailyOverviewResult(
        Number.parseInt(args.days ?? String(DEFAULT_OVERVIEW_DAYS), 10) || DEFAULT_OVERVIEW_DAYS,
      ),
  );
}

/** `avito_check_unread_chats` — the same split, on `limit`. */
function registerUnreadChats(server: McpServer, era: ProtocolEra): void {
  if (era === 'modern') {
    server.registerPrompt(
      'avito_check_unread_chats',
      {
        ...UNREAD_CHATS_META,
        argsSchema: z.object({
          limit: countArgument('limit', MAX_CHAT_LIMIT, LIMIT_DESCRIPTION),
        }),
      },
      async (args): Promise<GetPromptResult> =>
        unreadChatsResult(args.limit === undefined ? DEFAULT_CHAT_LIMIT : Number(args.limit)),
    );
    return;
  }
  server.registerPrompt(
    'avito_check_unread_chats',
    {
      ...UNREAD_CHATS_META,
      argsSchema: z.object({ limit: z.string().optional().describe(LIMIT_DESCRIPTION) }),
    },
    async (args): Promise<GetPromptResult> =>
      unreadChatsResult(
        Number.parseInt(args.limit ?? String(DEFAULT_CHAT_LIMIT), 10) || DEFAULT_CHAT_LIMIT,
      ),
  );
}

/** `avito_explain_tool` — an allowlisted tool name on both protocol eras. */
function registerExplainTool(server: McpServer, era: ProtocolEra): void {
  if (era === 'modern') {
    server.registerPrompt(
      'avito_explain_tool',
      {
        ...EXPLAIN_TOOL_META,
        argsSchema: z.object({
          tool_name: z
            .string()
            .regex(
              TOOL_NAME_PATTERN,
              'tool_name must be a tool name: lowercase letters, digits and underscores, ' +
                '3 to 64 characters, starting with a letter',
            )
            .describe(TOOL_NAME_DESCRIPTION),
        }),
      },
      // `"   "` reaches 1.3.3's handler and renders a "tool_name is required"
      // stub as a SUCCESSFUL result; here it is refused by the pattern above
      // with -32602 before the handler runs, and `promptSafeText` is the second
      // opinion for the day the pattern is loosened.
      async (args): Promise<GetPromptResult> =>
        explainToolResult(promptSafeText('tool_name', args.tool_name)),
    );
    return;
  }
  server.registerPrompt(
    'avito_explain_tool',
    {
      ...EXPLAIN_TOOL_META,
      argsSchema: z.object({ tool_name: z.string().describe(TOOL_NAME_DESCRIPTION) }),
    },
    async (args): Promise<GetPromptResult> => {
      const name = args.tool_name?.trim() ?? '';
      if (!name) {
        return requiredArgumentStub(
          'tool_name',
          'Provide tool_name, e.g. items_update_price.\n\n— Русский / Russian —\n\nУкажи tool_name, например items_update_price.',
        );
      }
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw invalidPromptArgument(
          'tool_name',
          'must be a tool name: lowercase letters, digits and underscores, ' +
            '3 to 64 characters, starting with a letter',
        );
      }
      return explainToolResult(promptSafeText('tool_name', name));
    },
  );
}

/** `avito_promote_item` — a digits-only listing id on both protocol eras. */
function registerPromoteItem(server: McpServer, era: ProtocolEra): void {
  if (era === 'modern') {
    server.registerPrompt(
      'avito_promote_item',
      {
        ...PROMOTE_ITEM_META,
        argsSchema: z.object({
          item_id: z
            .string()
            .regex(
              ITEM_ID_PATTERN,
              'item_id must be an Avito listing id: 1 to 19 digits, no leading zero',
            )
            .describe(ITEM_ID_DESCRIPTION),
        }),
      },
      // This prompt names four tools by name and explains the confirmation flow
      // that guards the money ones, so text smuggled through `item_id` would be
      // read by the model as part of that briefing. The pattern above leaves
      // nothing but digits; the sweep is the second opinion.
      async (args): Promise<GetPromptResult> =>
        promoteItemResult(promptSafeText('item_id', args.item_id)),
    );
    return;
  }
  server.registerPrompt(
    'avito_promote_item',
    {
      ...PROMOTE_ITEM_META,
      argsSchema: z.object({ item_id: z.string().describe(ITEM_ID_DESCRIPTION) }),
    },
    async (args): Promise<GetPromptResult> => {
      const itemId = args.item_id?.trim() ?? '';
      if (!itemId) {
        return requiredArgumentStub(
          'item_id',
          'Provide item_id.\n\n— Русский / Russian —\n\nУкажи item_id.',
        );
      }
      if (!ITEM_ID_PATTERN.test(itemId)) {
        throw invalidPromptArgument(
          'item_id',
          'must be an Avito listing id: 1 to 19 digits, no leading zero',
        );
      }
      return promoteItemResult(promptSafeText('item_id', itemId));
    },
  );
}

/** `avito_safety_report` takes no arguments, so the split has nothing to decide. */
function registerSafetyReport(server: McpServer): void {
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
    async (): Promise<GetPromptResult> => safetyReportResult(),
  );
}

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  const era = toolContextEra(ctx);

  // THE ORDER IS THE 1.3.3 ORDER, and it is part of the frozen wire: step
  // `05-prompts-list` of the reference bench compares this array element by
  // element against a captured 1.3.3 process.
  registerDailyOverview(server, era);
  registerUnreadChats(server, era);
  registerSafetyReport(server);
  registerExplainTool(server, era);
  registerPromoteItem(server, era);

  logger.info({ promptCount: 5, era }, 'MCP prompts registered');
}
