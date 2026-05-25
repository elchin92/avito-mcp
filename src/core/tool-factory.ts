import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { AvitoClient, BodyContentType, HttpMethod } from './client.js';
import { errorToMcpContent } from './errors.js';
import type { PendingActionStore } from './pending-actions.js';
import { evaluatePolicy, requiresConfirmation } from './policy.js';
import type { Primitive, QueryValue } from './url.js';

/**
 * Контекст, передаваемый в register-функции доменов.
 * Объединяет всё, что нужно tool-handler'у: HTTP-клиент, конфиг и pending-store
 * для confirmation flow.
 */
export interface ToolContext {
  client: AvitoClient;
  config: Config;
  pendingStore: PendingActionStore;
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
  const execute = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      const { pathParams, query, body } = splitArgs(args, spec, ctx);
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
      return {
        content: [
          {
            type: 'text',
            text: formatResponse(response.status, response.data),
          },
        ],
      };
    } catch (err) {
      return errorToMcpContent(err);
    }
  };

  const handler = async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
    const args = rawArgs ?? {};
    if (requiresConfirmation(risk, ctx.config)) {
      const pending = ctx.pendingStore.create({
        toolName: spec.name,
        risk,
        summary: summarisePending(spec, args),
        args,
        execute: () => execute(args),
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
      };
    }
    return execute(args);
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
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema, annotations, _meta: metaRecord },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler as any,
  );
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

  // Auto-inject Profile_id для отсутствующего path-параметра
  if (spec.injectProfileId && pathParams[spec.injectProfileId] === undefined) {
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
