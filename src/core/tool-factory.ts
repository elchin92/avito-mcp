import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

import type { Config } from '../config.js';
import type { AvitoClient, BodyContentType, HttpMethod } from './client.js';
import { errorToMcpContent } from './errors.js';
import type { Primitive, QueryValue } from './url.js';

/**
 * Контекст, передаваемый в register-функции доменов.
 * Объединяет всё, что нужно tool-handler'у: HTTP-клиент и конфиг (для autoinject).
 */
export interface ToolContext {
  client: AvitoClient;
  config: Config;
}

export type ProfileIdKey = 'user_id' | 'userId';

/**
 * Семантика воздействия tool на боевой аккаунт. Используется для:
 *   - AVITO_SAFE_MODE=read-only — блокирует всё, что не `read`
 *   - MCP ToolAnnotations (readOnlyHint / destructiveHint / idempotentHint) — клиенты типа
 *     Claude Desktop / Cursor показывают эти подсказки в UI и могут спросить подтверждение
 *
 * Категории:
 *   - `read`   — только чтение, без побочных эффектов. GET и POST-as-query (analytics).
 *   - `write`  — меняет данные пользователя, но без денежных затрат и без visibility клиентам.
 *                Drafts, settings, internal stock, разрешения и пр.
 *   - `money`  — тратит деньги с баланса (VAS, promotion, CPA bids).
 *   - `public` — видно клиентам или внешним сторонам: отправка сообщения, ответ на отзыв,
 *                смена цены/статуса объявления.
 *
 * Default if omitted: `write` (fail-closed для safe-mode).
 */
export type ToolRisk = 'read' | 'write' | 'money' | 'public';

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
}

/** MCP ToolAnnotations выводятся из ToolRisk детерминированно. */
function riskToAnnotations(risk: ToolRisk): ToolAnnotations {
  switch (risk) {
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

  const handler = async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
    if (process.env.AVITO_SAFE_MODE === 'read-only' && risk !== 'read') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `Tool '${spec.name}' (risk=${risk}) blocked by AVITO_SAFE_MODE=read-only. ` +
              `Unset AVITO_SAFE_MODE or set it to a different value to allow non-read tools.`,
          },
        ],
      };
    }
    try {
      const args = rawArgs ?? {};
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

  // SDK типизирует callback через internal BaseToolCallback с собственными inferred CallToolResult,
  // несовместимым с публичным CallToolResult-типом. Касаемся только сигнатуры — runtime OK.
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema, annotations },
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
  return `status=${status}\n${JSON.stringify(data, null, 2)}`;
}

/** Регистрационная функция домена. Каждый файл в src/domains/ экспортирует одну. */
export type DomainRegister = (server: McpServer, ctx: ToolContext) => void;
