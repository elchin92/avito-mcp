export interface RequestInfo {
  method: string;
  url: string;
  domain?: string;
}

/**
 * Доменная ошибка Avito API (4xx/5xx). Используется для маппинга в MCP isError content,
 * чтобы LLM-агент мог прочитать и среагировать.
 */
export class AvitoApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly request: RequestInfo;
  readonly retryAfter?: number;

  constructor(args: {
    status: number;
    body: unknown;
    request: RequestInfo;
    message?: string;
    retryAfter?: number;
  }) {
    super(args.message ?? `Avito API ${args.status} for ${args.request.method} ${args.request.url}`);
    this.name = 'AvitoApiError';
    this.status = args.status;
    this.body = args.body;
    this.request = args.request;
    this.retryAfter = args.retryAfter;
  }
}

/**
 * v0.7.4: креды Avito не сконфигурированы. Бросается лениво — только когда tool
 * реально пытается обратиться к Avito (получить токен). До этого момента сервер
 * спокойно отдаёт tools/list / resources / prompts без кредов (introspection mode).
 */
export class MissingCredentialsError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'Avito credentials are not configured. Set Client_id, Client_secret and Profile_id ' +
          '(env vars or .env) to make API calls. The server runs in introspection-only mode until then.',
    );
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Сетевая ошибка (DNS, таймаут, обрыв). Отличаем от доменных, чтобы агент видел разницу.
 */
export class AvitoTransportError extends Error {
  readonly request: RequestInfo;
  readonly cause: unknown;
  constructor(request: RequestInfo, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Transport error on ${request.method} ${request.url}: ${msg}`);
    this.name = 'AvitoTransportError';
    this.request = request;
    this.cause = cause;
  }
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Структурированная таксономия ошибок (v0.7.0).
 * type — машинно-читаемая категория, retryable + retryAfter — подсказки для агента
 * стоит ли пробовать ещё раз и через сколько секунд. httpStatus сохраняется для
 * совместимости с предыдущими версиями. Эти типы попадают в structuredContent.error.
 */
export type ErrorType =
  | 'CONFIG_ERROR'
  | 'AVITO_UNAUTHORIZED'
  | 'AVITO_FORBIDDEN'
  | 'AVITO_NOT_FOUND'
  | 'AVITO_BAD_REQUEST'
  | 'AVITO_RATE_LIMIT'
  | 'AVITO_SERVER_ERROR'
  | 'AVITO_API_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export interface ErrorEnvelope {
  type: ErrorType;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  httpStatus?: number;
  request?: RequestInfo;
  body?: unknown;
}

function classifyApiError(err: AvitoApiError): ErrorEnvelope {
  const s = err.status;
  if (s === 400) return { type: 'AVITO_BAD_REQUEST', message: err.message, retryable: false, httpStatus: s };
  if (s === 401) return { type: 'AVITO_UNAUTHORIZED', message: err.message, retryable: false, httpStatus: s };
  if (s === 403) return { type: 'AVITO_FORBIDDEN', message: err.message, retryable: false, httpStatus: s };
  if (s === 404) return { type: 'AVITO_NOT_FOUND', message: err.message, retryable: false, httpStatus: s };
  if (s === 429) return { type: 'AVITO_RATE_LIMIT', message: err.message, retryable: true, retryAfter: err.retryAfter, httpStatus: s };
  if (s >= 500 && s < 600) return { type: 'AVITO_SERVER_ERROR', message: err.message, retryable: true, retryAfter: err.retryAfter, httpStatus: s };
  return { type: 'AVITO_API_ERROR', message: err.message, retryable: false, httpStatus: s };
}

/**
 * Формирует payload для MCP-tool ответа из ошибки.
 * SDK ожидает isError + content[].text для пользовательского сообщения.
 * v0.6.0: добавлен structuredContent с error_kind.
 * v0.7.0: structuredContent.error содержит формальный таксономический тип
 * (см. ErrorType), retryable, retryAfter — агент может принимать решение
 * программно без regex по тексту.
 */
export function errorToMcpContent(err: unknown): CallToolResult {
  let text: string;
  let envelope: ErrorEnvelope;
  if (err instanceof AvitoApiError) {
    const bodyStr = typeof err.body === 'string' ? err.body : JSON.stringify(err.body, null, 2);
    text =
      `Avito API error ${err.status}\n` +
      `request: ${err.request.method} ${err.request.url}\n` +
      `response body: ${bodyStr}`;
    envelope = { ...classifyApiError(err), request: err.request, body: err.body };
  } else if (err instanceof MissingCredentialsError) {
    text = err.message;
    envelope = { type: 'CONFIG_ERROR', message: err.message, retryable: false };
  } else if (err instanceof AvitoTransportError) {
    text = `Transport error: ${err.message}`;
    const isTimeout = /abort|timeout/i.test(String((err.cause as Error)?.message ?? ''));
    envelope = {
      type: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: err.message,
      retryable: true,
      request: err.request,
    };
  } else if (err instanceof Error) {
    text = `Unexpected error: ${err.name}: ${err.message}`;
    envelope = { type: 'INTERNAL_ERROR', message: err.message, retryable: false };
  } else {
    text = `Unexpected error: ${String(err)}`;
    envelope = { type: 'INTERNAL_ERROR', message: String(err), retryable: false };
  }
  return {
    isError: true,
    content: [{ type: 'text', text }],
    // v0.7.0: новая структура — `error: { type, message, retryable, ... }`.
    // Старое поле error_kind сохраняем для backwards-compat: код, который читал
    // structuredContent.error_kind в v0.6.0, продолжит работать.
    structuredContent: {
      error: envelope,
      error_kind: legacyKindFromType(envelope.type),
    },
  };
}

function legacyKindFromType(t: ErrorType): string {
  if (t === 'NETWORK_ERROR' || t === 'TIMEOUT') return 'transport_error';
  if (t === 'INTERNAL_ERROR' || t === 'CONFIG_ERROR') return 'internal_error';
  return 'avito_api_error';
}
