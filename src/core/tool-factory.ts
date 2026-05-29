import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { AvitoClient, BodyContentType, HttpMethod } from './client.js';
import { errorToMcpContent } from './errors.js';
import { hashArgs, type IdempotencyStore, IdempotencyConflictError } from './idempotency.js';
import type { PendingActionStore } from './pending-actions.js';
import { evaluatePolicy, requiresConfirmation } from './policy.js';
import type { Primitive, QueryValue } from './url.js';

/** Имена служебных полей, автоматически добавляемых к destructive tools. */
const META_PARAMS = ['dryRun', 'idempotencyKey'] as const;

function isDestructive(risk: ToolRisk): boolean {
  return risk === 'write' || risk === 'money' || risk === 'public';
}

/** Чистые args для tool — без служебных meta-параметров. */
function stripMeta(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!(META_PARAMS as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Контекст, передаваемый в register-функции доменов.
 * Объединяет всё, что нужно tool-handler'у: HTTP-клиент, конфиг и pending-store
 * для confirmation flow. С v0.6.0 также пробрасывается McpServer — нужен resources/
 * prompts/sendLoggingMessage, регистрируемым в src/resources.ts и src/prompts.ts.
 * Поле `server` опционально, чтобы существующие тесты не пришлось править.
 */
export interface ToolContext {
  client: AvitoClient;
  config: Config;
  pendingStore: PendingActionStore;
  server?: McpServer;
  /**
   * v0.7.0: opt-in idempotency ledger. Если не передан — параметр
   * idempotencyKey всё равно разрешён в schema (агент может его передать),
   * но дедуп не выполняется. Это упрощает миграцию: existing tests могут
   * не передавать idempotencyStore.
   */
  idempotencyStore?: IdempotencyStore;
}

export type ProfileIdKey = 'user_id' | 'userId';

/**
 * Семантика воздействия tool на боевой аккаунт. Используется для:
 *   - AVITO_MCP_MODE — блокирует категории на этапе регистрации
 *   - AVITO_MCP_CONFIRMATION_MODE — требует подтверждения на runtime
 *   - MCP ToolAnnotations (readOnlyHint / destructiveHint / idempotentHint)
 *
 * Категории:
 *   - `sensitive` — возвращает credentials / tokens / секреты. Скрыт по default
 *                   даже в full_access. Включается через AVITO_MCP_EXPOSE_AUTH_TOOLS=1.
 *                   Примеры: auth_get_access_token, auth_refresh_*.
 *   - `read`      — только чтение, без побочных эффектов и без секретов в ответе.
 *                   GET и POST-as-query (analytics, balance, info, list).
 *   - `write`     — меняет данные пользователя, без денежных затрат и без visibility клиентам.
 *                   Drafts, settings, internal stock, отметка прочитанного.
 *   - `money`     — тратит деньги с баланса (VAS, promotion, CPA bids).
 *   - `public`    — видно клиентам или третьим сторонам (сообщения, ответы на отзывы,
 *                   смена цены/статуса/трекинга).
 *
 * Default if omitted: `write` (fail-closed для safe-mode).
 */
export type ToolRisk = 'sensitive' | 'read' | 'write' | 'money' | 'public';

/**
 * Декларативное описание одного MCP tool, обёртывающего HTTP-вызов Avito API.
 *
 * @template I — zod-shape входных параметров (объект `{ key: z.ZodType }`)
 */
export interface ToolSpec<I extends ZodRawShape = ZodRawShape> {
  /** Полное имя tool (с префиксом домена). Должно быть snake_case. */
  name: string;
  /**
   * Опциональное человекочитаемое имя (MCP 2025-11-25 — поле `title` у Tool).
   * Display-приоритет на клиенте: title → annotations.title → name. Если не задан,
   * клиент показывает name (snake_case). Для русскоязычных пользователей сильно
   * улучшает UX в Inspector / Claude Desktop.
   */
  title?: string;
  /** Описание для LLM. Пишется на русском, кратко и явно (как в swagger summary). */
  description: string;
  method: HttpMethod;
  /** Шаблон пути с {placeholders}, например "/core/v1/accounts/{user_id}/balance/". */
  path: string;
  /** Zod-shape входных параметров. {} если параметров нет. */
  input?: I;
  /** Имена ключей из `input`, которые идут в path. Остальные — в query или body. */
  pathParams?: readonly string[];
  /** Имена ключей из `input`, которые идут в query. */
  queryParams?: readonly string[];
  /**
   * Описание тела запроса.
   *   - `contentType` — определяет сериализацию.
   *   - `fields` — если указано, в body попадут только эти ключи из input.
   *     Если не указано — все ключи input, кроме path/query.
   *   - `defaults` — постоянные поля, всегда добавляемые в body (можно перекрыть через input).
   *     Может быть объектом или функцией от контекста (для credentials из .env).
   *   - `transform` — финальная трансформация body перед сериализацией. Применяется
   *     ПОСЛЕ слияния defaults+input. Используется для nested-body (например `{message:{text}}`
   *     из плоского `{text}`).
   *   - Если `body` не задано — тело не отправляется.
   */
  body?: {
    contentType: BodyContentType;
    fields?: readonly string[];
    defaults?: Record<string, unknown> | ((ctx: ToolContext) => Record<string, unknown>);
    /**
     * Финальная трансформация. Может вернуть объект (по умолчанию JSON-сериализуется как объект)
     * или массив — для endpoints, где Avito ждёт top-level JSON array как body.
     */
    transform?: (body: Record<string, unknown>) => Record<string, unknown> | unknown[];
  };
  /** false → запрос без Authorization (для /token и autoload-public). Default: true. */
  auth?: boolean;
  /**
   * Если задано — отсутствующий path-параметр с этим именем подставится из config.profileId.
   * Покрывает {user_id} и {userId} формы. Резко снижает галлюцинации агента.
   */
  injectProfileId?: ProfileIdKey;
  /** Имя для группировки в rate-limiter (по умолчанию — первый сегмент пути). */
  domain?: string;
  /**
   * Семантика воздействия. См. {@link ToolRisk}. Default — `'write'` (fail-closed для safe-mode).
   * Все GET-tool'ы и POST-as-query (analytics, статистика) должны быть явно `'read'`.
   */
  risk?: ToolRisk;
  /**
   * Явный override MCP-аннотации `destructiveHint`. По умолчанию destructiveHint
   * выводится из risk (money/public → true, остальное → false). Но risk описывает
   * политику безопасности, а destructiveHint — семантику необратимости для клиента.
   * Они расходятся для отмен/удалений (cancel/delete/remove/prohibit/blacklist):
   * это `write` по политике (не тратит деньги, не публично), но необратимо по сути.
   * Для таких tools укажите `destructiveHint: true`, чтобы аннотация была честной.
   */
  destructiveHint?: boolean;
  /**
   * v0.5.0: дополнительные safety-измерения, ортогональные risk.
   * Выводятся в `_meta` и в `dist/manifest.json` для UI клиента и для аудита.
   * Не влияют на policy/confirmation решения — это аналитика, не enforcement.
   */
  accessesLocalFiles?: boolean;
  environment?: 'prod' | 'sandbox' | 'local';
}

/** MCP ToolAnnotations выводятся из ToolRisk детерминированно. */
function riskToAnnotations(risk: ToolRisk): ToolAnnotations {
  switch (risk) {
    case 'sensitive':
      // Read-only на стороне Avito, но возвращает секреты — для клиента это тоже
      // важный сигнал. Сама защита secrets — в policy.ts (hidden by default).
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    case 'read':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    case 'write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    case 'money':
    case 'public':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
}

/**
 * Регистрирует один tool в McpServer. Превращает декларативный ToolSpec в работающий
 * server.registerTool(name, config, handler).
 *
 * Handler:
 *   1. Разбивает args по pathParams / queryParams / body fields
 *   2. При необходимости подставляет config.profileId в отсутствующий path-параметр
 *   3. Вызывает client.request(...)
 *   4. Сериализует data в text content (агент сам распарсит JSON)
 *   5. Ошибки Avito API → isError content (агент видит код и текст ошибки и может среагировать)
 */
export function defineTool<I extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<I>,
): void {
  const inputSchema = spec.input ?? ({} as I);
  const risk: ToolRisk = spec.risk ?? 'write';
  const annotations = riskToAnnotations(risk);
  // Honest destructiveHint override: cancellations/deletions are policy-`write`
  // but irreversible, so the derived hint (false) would understate them. See ToolSpec.
  if (spec.destructiveHint !== undefined) {
    annotations.destructiveHint = spec.destructiveHint;
  }

  // Policy gate: hide tools that violate mode / allowlist / denylist BEFORE registration.
  // Hiding (rather than blocking at call time) means the agent never sees the tool in
  // tools/list — removes the temptation entirely.
  const decision = evaluatePolicy(spec.name, risk, ctx.config);
  if (!decision.allowed) {
    logger.info(
      { tool: spec.name, risk, reason: decision.reason },
      'tool hidden by policy',
    );
    return;
  }

  // Реальный исполнитель — отделён от обёртки, чтобы переиспользовать его
  // при подтверждении через meta_confirm_action.
  // ВАЖНО: принимает чистые args (без dryRun/idempotencyKey) — meta-параметры
  // обрабатываются в handler выше.
  const execute = async (cleanArgs: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      const { pathParams, query, body } = splitArgs(cleanArgs, spec, ctx);
      const response = await ctx.client.request({
        method: spec.method,
        path: spec.path,
        pathParams,
        query,
        body,
        bodyContentType: spec.body?.contentType,
        auth: spec.auth ?? true,
        domain: spec.domain,
      });
      const result: CallToolResult = {
        content: [
          {
            type: 'text',
            text: formatResponse(response.status, response.data),
          },
        ],
      };
      // v0.6.0: structuredContent — поле MCP 2025-11-25 для клиентов, умеющих парсить JSON.
      // Дублирует text, но без необходимости в regex/parse на стороне агента. Не задаём
      // outputSchema → клиент валидирует не строго, поэтому смело отдаём любую форму.
      const structured = toStructuredContent(response.status, response.data);
      if (structured !== undefined) result.structuredContent = structured;
      return result;
    } catch (err) {
      return errorToMcpContent(err);
    }
  };

  const destructive = isDestructive(risk);

  const handler = async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
    const args = rawArgs ?? {};
    const cleanArgs = destructive ? stripMeta(args) : args;

    // v0.7.0: dry-run на destructive tools. Если args.dryRun === true ИЛИ
    // конфиг включает dryRunDefault, возвращаем preview запроса без HTTP-вызова.
    // dry-run обходит confirmation и idempotency — preview безопасен и не имеет
    // эффекта, поэтому ни confirm, ни dedup не нужны.
    const dryRunRequested = args.dryRun === true;
    const effectiveDryRun =
      destructive && (dryRunRequested || ctx.config.dryRunDefault === true);
    if (effectiveDryRun) {
      return dryRunPreview(spec, cleanArgs, ctx, dryRunRequested);
    }

    // v0.7.0: idempotency. Если агент передал idempotencyKey И сервер имеет store,
    // проверяем (toolName, key, hash(args)).
    //   - hit + matching args → возвращаем кэш с пометкой idempotent_replay=true
    //   - hit + different args → возвращаем структурированную ошибку (conflict)
    //   - miss → выполняем, потом запоминаем
    const idempotencyKey =
      destructive && typeof args.idempotencyKey === 'string' && args.idempotencyKey.length > 0
        ? args.idempotencyKey
        : undefined;
    const argsHash = idempotencyKey ? hashArgs(cleanArgs) : undefined;

    if (idempotencyKey && ctx.idempotencyStore && argsHash) {
      try {
        const cached = ctx.idempotencyStore.lookup(idempotencyKey, spec.name, argsHash);
        if (cached) {
          logger.info(
            { tool: spec.name, idempotencyKey, ageMs: Date.now() - cached.createdAt },
            'idempotent replay served from ledger',
          );
          return annotateReplay(cached.result);
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          return errorToMcpContent(err);
        }
        throw err;
      }
    }

    if (requiresConfirmation(risk, ctx.config)) {
      const pending = ctx.pendingStore.create({
        toolName: spec.name,
        risk,
        summary: summarisePending(spec, cleanArgs),
        args: cleanArgs,
        execute: async () => {
          const r = await execute(cleanArgs);
          if (idempotencyKey && ctx.idempotencyStore && argsHash) {
            ctx.idempotencyStore.remember(idempotencyKey, spec.name, argsHash, r);
          }
          return r;
        },
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                requires_confirmation: true,
                confirmation_id: pending.id,
                tool: spec.name,
                risk,
                summary: pending.summary,
                expires_at: new Date(pending.expiresAt).toISOString(),
                next_step:
                  'Call meta_confirm_action with this confirmation_id ONLY after explicit human approval. ' +
                  'Confirmation flow is a server-side two-step safety guard against accidental one-shot execution; ' +
                  'it is not a cryptographic human-approval mechanism by itself.',
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          requires_confirmation: true,
          confirmation_id: pending.id,
          tool: spec.name,
          risk,
          expires_at: new Date(pending.expiresAt).toISOString(),
        },
      };
    }

    const result = await execute(cleanArgs);
    if (idempotencyKey && ctx.idempotencyStore && argsHash) {
      ctx.idempotencyStore.remember(idempotencyKey, spec.name, argsHash, result);
    }
    return result;
  };

  // SDK типизирует callback через internal BaseToolCallback с собственными inferred CallToolResult,
  // несовместимым с публичным CallToolResult-типом. Касаемся только сигнатуры — runtime OK.
  // Build _meta with optional extra safety dimensions. Default environment='prod'
  // unless overridden (delivery sandbox tools, meta_*).
  const metaRecord: Record<string, unknown> = {
    risk,
    environment: spec.environment ?? 'prod',
  };
  if (spec.accessesLocalFiles) metaRecord.accessesLocalFiles = true;

  // v0.7.0: destructive tools получают опциональные dryRun + idempotencyKey
  // в inputSchema. Read/sensitive — нет (для них эти параметры бессмысленны).
  const finalInputSchema: ZodRawShape = destructive
    ? {
        ...(inputSchema as ZodRawShape),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'v0.7.0: если true — возвращает preview HTTP-запроса без вызова Avito API. ' +
              'Безопасно для просмотра, что именно будет сделано. Default: значение ' +
              'AVITO_MCP_DRY_RUN_DEFAULT (обычно false).',
          ),
        idempotencyKey: z
          .string()
          .min(8)
          .optional()
          .describe(
            'v0.7.0: опциональный ключ для защиты от дублей. Повторный вызов с тем же ключом ' +
              'в течение AVITO_MCP_IDEMPOTENCY_TTL_SEC возвращает закешированный результат. ' +
              'Тот же ключ с другими args вернёт ошибку conflict — это безопасно по дизайну.',
          ),
      }
    : inputSchema;

  if (destructive) {
    metaRecord.supportsDryRun = true;
    metaRecord.supportsIdempotency = true;
  }

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: finalInputSchema,
      annotations,
      _meta: metaRecord,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler as any,
  );
}

/**
 * Возвращает preview HTTP-запроса без реального вызова Avito API.
 * v0.7.0: используется когда dryRun=true или AVITO_MCP_DRY_RUN_DEFAULT=true.
 *
 * Cодержит pathParams, query, body и итоговый method+path — агент может убедиться,
 * что параметры собрались правильно, перед боевым вызовом.
 */
function dryRunPreview(
  spec: ToolSpec,
  cleanArgs: Record<string, unknown>,
  ctx: ToolContext,
  explicit: boolean,
): CallToolResult {
  let preview: { pathParams: Record<string, unknown>; query: Record<string, unknown>; body: unknown };
  try {
    const split = splitArgs(cleanArgs, spec, ctx);
    preview = split as typeof preview;
  } catch (err) {
    return errorToMcpContent(err);
  }
  const payload = {
    dryRun: true,
    explicit_request: explicit,
    operation: {
      tool: spec.name,
      method: spec.method,
      path: spec.path,
      domain: spec.domain ?? null,
    },
    request_preview: preview,
    notice:
      'No HTTP request was made. To execute for real, call again with dryRun: false ' +
      '(or unset AVITO_MCP_DRY_RUN_DEFAULT).',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Добавляет к закешированному idempotency-результату пометку, что это replay.
 * Так агент видит "это не свежий результат, я уже выполнял этот ключ".
 */
function annotateReplay(result: CallToolResult): CallToolResult {
  const cloned: CallToolResult = {
    ...result,
    structuredContent: {
      ...(result.structuredContent ?? {}),
      idempotent_replay: true,
    },
  };
  return cloned;
}

/**
 * Превращает HTTP-ответ Avito в structuredContent для CallToolResult.
 *
 * MCP-2025-11-25 требует, чтобы structuredContent был JSON-объектом (top-level).
 * - object → как есть
 * - array  → {items: array, count, status} (объект-обёртка)
 * - binary → {mimeType, sizeBytes, base64, status} (без __binary флага)
 * - null / string → undefined (только text-content имеет смысл)
 */
function toStructuredContent(status: number, data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data === 'string') return undefined;
  if (
    typeof data === 'object' &&
    (data as { __binary?: unknown }).__binary === true
  ) {
    const b = data as { mimeType: string; sizeBytes: number; base64: string };
    return {
      status,
      mimeType: b.mimeType,
      sizeBytes: b.sizeBytes,
      base64: b.base64,
    };
  }
  if (Array.isArray(data)) {
    return { status, items: data, count: data.length };
  }
  if (typeof data === 'object') {
    return { status, ...(data as Record<string, unknown>) };
  }
  return undefined;
}

function splitArgs(
  args: Record<string, unknown>,
  spec: ToolSpec,
  ctx: ToolContext,
): {
  pathParams: Record<string, Primitive>;
  query: Record<string, QueryValue>;
  body: Record<string, unknown> | unknown[] | undefined;
} {
  const pathSet = new Set(spec.pathParams ?? []);
  const querySet = new Set(spec.queryParams ?? []);
  const explicitBodyFields = spec.body?.fields ? new Set(spec.body.fields) : undefined;

  const pathParams: Record<string, Primitive> = {};
  const query: Record<string, QueryValue> = {};
  const body: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (pathSet.has(key)) {
      pathParams[key] = value as Primitive;
    } else if (querySet.has(key)) {
      query[key] = value as QueryValue;
    } else if (spec.body) {
      if (!explicitBodyFields || explicitBodyFields.has(key)) {
        body[key] = value;
      }
    }
  }

  // Auto-inject Profile_id для отсутствующего path-параметра.
  // v0.7.4: profileId опционален — инжектим только если он задан. Если нет и tool
  // требует path-параметр, запрос уйдёт с незаполненным {user_id} и Avito вернёт
  // понятную ошибку; до этого момента tools/list работает без кредов.
  if (
    spec.injectProfileId &&
    pathParams[spec.injectProfileId] === undefined &&
    ctx.config.profileId !== undefined
  ) {
    pathParams[spec.injectProfileId] = ctx.config.profileId;
  }

  // Подмешиваем body.defaults (constant fields, credentials из .env и т.п.) ПЕРЕД user-args,
  // чтобы пользовательский ввод имел приоритет. Затем — опциональный transform.
  let finalBody: Record<string, unknown> | unknown[] | undefined;
  if (spec.body) {
    const defaults =
      typeof spec.body.defaults === 'function'
        ? spec.body.defaults(ctx)
        : (spec.body.defaults ?? {});
    finalBody = { ...defaults, ...body };
    if (spec.body.transform) {
      finalBody = spec.body.transform(finalBody as Record<string, unknown>);
    }
  }

  return {
    pathParams,
    query,
    body: finalBody,
  };
}

function formatResponse(status: number, data: unknown): string {
  if (data === null || data === undefined) {
    return `status=${status}\n(empty response body)`;
  }
  if (typeof data === 'string') {
    return `status=${status}\n${data}`;
  }
  // Binary responses come from client.ts as { __binary: true, mimeType, sizeBytes, base64 }.
  // We pre-format them so the LLM sees a clean structured payload and isn't surprised by a
  // multi-MB base64 string buried inside a regular JSON-stringify.
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { __binary?: unknown }).__binary === true
  ) {
    const b = data as { mimeType: string; sizeBytes: number; base64: string };
    return (
      `status=${status}\n` +
      `Binary response:\n` +
      `  mimeType:  ${b.mimeType}\n` +
      `  sizeBytes: ${b.sizeBytes}\n` +
      `  base64:    ${b.base64}\n`
    );
  }
  return `status=${status}\n${JSON.stringify(data, null, 2)}`;
}

/**
 * Короткое (~100-200 символов) описание pending action для UI/log/list_pending.
 * Не дампит args целиком — выдержки самых типичных идентификаторов.
 */
function summarisePending(spec: ToolSpec, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['item_id', 'itemId', 'order_id', 'chat_id', 'message_id', 'vas_id', 'price']) {
    const v = args[key];
    if (v !== undefined) parts.push(`${key}=${String(v)}`);
  }
  const tail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${spec.method} ${spec.path}${tail}`;
}

/** Регистрационная функция домена. Каждый файл в src/domains/ экспортирует одну. */
export type DomainRegister = (server: McpServer, ctx: ToolContext) => void;
