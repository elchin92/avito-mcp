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
 */
export function errorToMcpContent(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof AvitoApiError) {
    const bodyStr = typeof err.body === 'string' ? err.body : JSON.stringify(err.body, null, 2);
    text =
      `Avito API error ${err.status}\n` +
      `request: ${err.request.method} ${err.request.url}\n` +
      `response body: ${bodyStr}`;
  } else if (err instanceof AvitoTransportError) {
    text = `Transport error: ${err.message}`;
  } else if (err instanceof Error) {
    text = `Unexpected error: ${err.name}: ${err.message}`;
  } else {
    text = `Unexpected error: ${String(err)}`;
  }
  return { isError: true, content: [{ type: 'text', text }] };
}
