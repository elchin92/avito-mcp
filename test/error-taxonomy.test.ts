/**
 * Tests for the structured error taxonomy (v0.7.0).
 */
import { describe, it, expect } from 'vitest';
import { errorToMcpContent, AvitoApiError, AvitoTransportError } from '../src/core/errors.js';

function makeApiErr(status: number, body: unknown = { msg: 'x' }, retryAfter?: number) {
  return new AvitoApiError({
    status,
    body,
    request: { method: 'GET', url: 'https://api.test/x' },
    retryAfter,
  });
}

describe('error taxonomy', () => {
  it('400 → AVITO_BAD_REQUEST, retryable=false', () => {
    const res = errorToMcpContent(makeApiErr(400));
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      error: { type: 'AVITO_BAD_REQUEST', retryable: false, httpStatus: 400 },
      error_kind: 'avito_api_error',
    });
  });

  it('401 → AVITO_UNAUTHORIZED, retryable=false', () => {
    const res = errorToMcpContent(makeApiErr(401));
    expect(res.structuredContent).toMatchObject({
      error: { type: 'AVITO_UNAUTHORIZED', retryable: false },
    });
  });

  it('403 → AVITO_FORBIDDEN', () => {
    expect(errorToMcpContent(makeApiErr(403)).structuredContent).toMatchObject({
      error: { type: 'AVITO_FORBIDDEN', retryable: false },
    });
  });

  it('404 → AVITO_NOT_FOUND', () => {
    expect(errorToMcpContent(makeApiErr(404)).structuredContent).toMatchObject({
      error: { type: 'AVITO_NOT_FOUND', retryable: false },
    });
  });

  it('429 → AVITO_RATE_LIMIT, retryable=true, propagates retryAfter', () => {
    expect(errorToMcpContent(makeApiErr(429, {}, 30)).structuredContent).toMatchObject({
      error: { type: 'AVITO_RATE_LIMIT', retryable: true, retryAfter: 30, httpStatus: 429 },
    });
  });

  it('5xx → AVITO_SERVER_ERROR, retryable=true', () => {
    expect(errorToMcpContent(makeApiErr(502)).structuredContent).toMatchObject({
      error: { type: 'AVITO_SERVER_ERROR', retryable: true, httpStatus: 502 },
    });
  });

  it('transport error (network) → NETWORK_ERROR, retryable=true', () => {
    const t = new AvitoTransportError(
      { method: 'GET', url: 'http://x' },
      new Error('ECONNREFUSED'),
    );
    expect(errorToMcpContent(t).structuredContent).toMatchObject({
      error: { type: 'NETWORK_ERROR', retryable: true },
    });
  });

  it('transport error (abort/timeout) → TIMEOUT', () => {
    const cause = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const t = new AvitoTransportError({ method: 'GET', url: 'http://x' }, cause);
    expect(errorToMcpContent(t).structuredContent).toMatchObject({
      error: { type: 'TIMEOUT', retryable: true },
    });
  });

  it('plain Error → INTERNAL_ERROR', () => {
    expect(errorToMcpContent(new Error('boom')).structuredContent).toMatchObject({
      error: { type: 'INTERNAL_ERROR', retryable: false },
    });
  });

  it('text content is preserved for backwards-compat', () => {
    const res = errorToMcpContent(makeApiErr(429, { reason: 'slow down' }));
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('429');
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('slow down');
  });
});
