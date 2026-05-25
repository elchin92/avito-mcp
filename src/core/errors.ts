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
 * Формирует payload для MCP-tool ответа из ошибки.
 * SDK ожидает isError + content[].text для пользовательского сообщения.
 * v0.6.0: добавлен structuredContent — клиенты могут парсить error_kind/status/url
 * без regex по тексту.
 */
export function errorToMcpContent(err: unknown): CallToolResult {
  let text: string;
  let structured: Record<string, unknown>;
  if (err instanceof AvitoApiError) {
    const bodyStr = typeof err.body === 'string' ? err.body : JSON.stringify(err.body, null, 2);
    text =
      `Avito API error ${err.status}\n` +
      `request: ${err.request.method} ${err.request.url}\n` +
      `response body: ${bodyStr}`;
    structured = {
      error_kind: 'avito_api_error',
      status: err.status,
      request: err.request,
      body: err.body,
    };
    if (err.retryAfter !== undefined) structured.retry_after_sec = err.retryAfter;
  } else if (err instanceof AvitoTransportError) {
    text = `Transport error: ${err.message}`;
    structured = {
      error_kind: 'transport_error',
      request: err.request,
      message: err.message,
    };
  } else if (err instanceof Error) {
    text = `Unexpected error: ${err.name}: ${err.message}`;
    structured = { error_kind: 'internal_error', name: err.name, message: err.message };
  } else {
    text = `Unexpected error: ${String(err)}`;
    structured = { error_kind: 'internal_error', message: String(err) };
  }
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}
