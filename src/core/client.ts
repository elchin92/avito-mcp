import { logger } from '../logger.js';
import type { Config } from '../config.js';
import { USER_AGENT } from '../version.js';
import { AvitoApiError, AvitoTransportError, type RequestInfo } from './errors.js';
import { TokenStore } from './token-store.js';
import { RateLimiter, sleep } from './rate-limiter.js';
import { buildUrl, type Primitive, type QueryValue } from './url.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export type BodyContentType =
  | 'application/json'
  | 'application/x-www-form-urlencoded'
  | 'multipart/form-data';

export interface RequestOptions {
  method: HttpMethod;
  /** Шаблон пути с {placeholders}, например "/core/v1/accounts/{user_id}/balance/" */
  path: string;
  pathParams?: Record<string, Primitive>;
  query?: Record<string, QueryValue>;
  /** Тело — объект (для JSON / multipart) или string (для уже сериализованного body). */
  body?: unknown;
  bodyContentType?: BodyContentType;
  /** Если false — Authorization header не добавляется. Для /token и autoload-public. */
  auth?: boolean;
  /** Логическое имя для rate-limiter (по умолчанию — первый сегмент пути). */
  domain?: string;
  /** Таймаут запроса. По умолчанию 30 сек. */
  timeoutMs?: number;
}

export interface RequestResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

/**
 * Тело, принимаемое нативным fetch в Node 22+ — не экспортируется @types/node как FetchBody.
 * Покрывает все используемые в проекте сериализации.
 */
type FetchBody = string | URLSearchParams | FormData | Uint8Array | Blob | null;

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RetryConfig {
  /** Базовый backoff для 429 в миллисекундах. Реальный backoff = base * 2^retry. */
  retry429BaseMs: number;
  /** Максимальное число retry на 429. */
  max429Retries: number;
  /** Backoff для одного 5xx retry в миллисекундах. */
  retry5xxBackoffMs: number;
  /** Максимальное число retry на 5xx. */
  max5xxRetries: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  retry429BaseMs: 1000,
  max429Retries: 3,
  retry5xxBackoffMs: 500,
  max5xxRetries: 1,
};

export class AvitoClient {
  readonly rateLimiter = new RateLimiter();
  readonly tokenStore: TokenStore;
  private readonly retry: RetryConfig;

  constructor(
    private readonly config: Config,
    opts: { retry?: Partial<RetryConfig> } = {},
  ) {
    this.tokenStore = new TokenStore(
      config.tokenFile,
      () => this.fetchTokenViaClientCredentials(),
      config.tokenLockTimeoutMs,
    );
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
  }

  async request<T = unknown>(opts: RequestOptions): Promise<RequestResponse<T>> {
    const url = buildUrl(this.config.baseUrl, opts.path, opts.pathParams, opts.query);
    const domain = opts.domain ?? extractDomain(opts.path);
    const reqInfo: RequestInfo = { method: opts.method, url, domain };

    await this.rateLimiter.waitIfNeeded(domain);

    return this.doRequest<T>(opts, url, reqInfo, /*allowRefresh=*/ true, 0, 0);
  }

  private async doRequest<T>(
    opts: RequestOptions,
    url: string,
    reqInfo: RequestInfo,
    allowRefresh: boolean,
    retries429: number,
    retries5xx: number,
  ): Promise<RequestResponse<T>> {
    const { headers, body } = await this.buildHeadersAndBody(opts);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: opts.method,
        headers,
        body: body as FetchBody | null,
        signal: ctl.signal,
      });
    } catch (err) {
      throw new AvitoTransportError(reqInfo, err);
    } finally {
      clearTimeout(timer);
    }

    this.rateLimiter.observe(reqInfo.domain ?? 'default', resp.headers);

    // 401: один автоматический refresh + повторный запрос
    if (resp.status === 401 && allowRefresh && opts.auth !== false) {
      logger.info({ url }, '401 from avito, refreshing token and retrying once');
      await this.tokenStore.invalidate();
      await this.tokenStore.refresh();
      return this.doRequest<T>(opts, url, reqInfo, false, retries429, retries5xx);
    }

    // 429: экспоненциальный backoff
    if (resp.status === 429 && retries429 < this.retry.max429Retries) {
      const retryAfterSec = parseRetryAfterSec(resp.headers.get('retry-after'));
      const backoffMs =
        retryAfterSec !== undefined
          ? retryAfterSec * 1000
          : this.retry.retry429BaseMs * Math.pow(2, retries429);
      logger.warn({ url, retries429, backoffMs }, '429 rate-limited, backing off');
      await sleep(backoffMs);
      return this.doRequest<T>(opts, url, reqInfo, allowRefresh, retries429 + 1, retries5xx);
    }

    // 5xx: один retry
    if (resp.status >= 500 && resp.status < 600 && retries5xx < this.retry.max5xxRetries) {
      logger.warn({ url, status: resp.status }, '5xx from avito, retrying once');
      await sleep(this.retry.retry5xxBackoffMs);
      return this.doRequest<T>(opts, url, reqInfo, allowRefresh, retries429, retries5xx + 1);
    }

    // Парсим body — для бинарей применяется лимит из config.maxBinaryMb.
    const maxBinaryBytes = (this.config.maxBinaryMb ?? 20) * 1024 * 1024;
    const data = await safeParseResponse<T>(resp, maxBinaryBytes);

    if (!resp.ok) {
      throw new AvitoApiError({
        status: resp.status,
        body: data,
        request: reqInfo,
        retryAfter: parseRetryAfterSec(resp.headers.get('retry-after')),
      });
    }

    return { status: resp.status, data: data as T, headers: resp.headers };
  }

  private async buildHeadersAndBody(opts: RequestOptions): Promise<{
    headers: Record<string, string>;
    body: FetchBody | null;
  }> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };

    if (opts.auth !== false) {
      const token = await this.tokenStore.getToken();
      headers.Authorization = `Bearer ${token}`;
    }

    if (opts.body === undefined || opts.body === null) {
      return { headers, body: null };
    }

    const contentType = opts.bodyContentType ?? 'application/json';
    if (contentType === 'application/json') {
      headers['Content-Type'] = 'application/json';
      return { headers, body: JSON.stringify(opts.body) };
    }
    if (contentType === 'application/x-www-form-urlencoded') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.body as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        params.append(k, String(v));
      }
      return { headers, body: params.toString() };
    }
    if (contentType === 'multipart/form-data') {
      // browser/node fetch сам выставит boundary; Content-Type НЕ ставим вручную
      const form = opts.body instanceof FormData ? opts.body : objectToFormData(opts.body);
      return { headers, body: form };
    }
    throw new Error(`Unsupported bodyContentType: ${contentType}`);
  }

  /**
   * OAuth 2.0 client_credentials. Эта же ручка — endpoint POST /token.
   * Делаем без auth-токена (его как раз нет), напрямую через fetch.
   */
  private async fetchTokenViaClientCredentials(): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: params.toString(),
        signal: ctl.signal,
      });
    } catch (err) {
      throw new AvitoTransportError({ method: 'POST', url }, err);
    } finally {
      clearTimeout(timer);
    }
    const data = (await safeParseResponse<TokenResponse>(resp)) as TokenResponse;
    if (!resp.ok) {
      throw new AvitoApiError({
        status: resp.status,
        body: data,
        request: { method: 'POST', url },
        message: `Token fetch failed: ${resp.status}`,
      });
    }
    if (!data || typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
      throw new AvitoApiError({
        status: resp.status,
        body: data,
        request: { method: 'POST', url },
        message: 'Token response shape invalid',
      });
    }
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

/**
 * Структурированный binary-ответ от Avito (PDF labels, audio recordings и т.п.).
 * Превращается в строку через formatResponse — агент видит mime/size и base64,
 * может сохранить байты в файл через свой клиент.
 */
export interface BinaryResponse {
  __binary: true;
  mimeType: string;
  sizeBytes: number;
  base64: string;
}

function isBinaryContent(ct: string): boolean {
  const lower = ct.toLowerCase();
  if (!lower) return false;
  if (lower.includes('application/json')) return false;
  if (lower.startsWith('text/')) return false;
  if (lower.includes('application/xml') || lower.includes('+xml')) return false;
  if (lower.includes('application/x-www-form-urlencoded')) return false;
  // Всё остальное (application/pdf, audio/*, image/*, application/octet-stream, ...) — бинарь.
  return true;
}

async function safeParseResponse<T>(
  resp: Response,
  maxBinaryBytes: number = 20 * 1024 * 1024,
): Promise<T | string | BinaryResponse | null> {
  const ct = resp.headers.get('content-type') ?? '';
  if (isBinaryContent(ct)) {
    // v0.5.1: fail-closed на размере. Сначала проверяем заявленный Content-Length,
    // если есть. Так мы избегаем чтения мегабайт в память впустую.
    const cl = resp.headers.get('content-length');
    const declared = cl ? Number.parseInt(cl, 10) : NaN;
    if (Number.isFinite(declared) && declared > maxBinaryBytes) {
      // drain body чтобы не висел socket
      try { await resp.arrayBuffer(); } catch { /* ignore */ }
      throw new Error(
        `Binary response too large: Content-Length=${declared} bytes > AVITO_MCP_MAX_BINARY_MB limit (${maxBinaryBytes} bytes). ` +
          `Increase AVITO_MCP_MAX_BINARY_MB or fetch this file via direct HTTP (curl).`,
      );
    }
    const ab = await resp.arrayBuffer();
    if (ab.byteLength === 0) return null;
    if (ab.byteLength > maxBinaryBytes) {
      throw new Error(
        `Binary response too large: ${ab.byteLength} bytes > AVITO_MCP_MAX_BINARY_MB limit (${maxBinaryBytes} bytes). ` +
          `Increase AVITO_MCP_MAX_BINARY_MB or fetch this file via direct HTTP (curl).`,
      );
    }
    return {
      __binary: true,
      mimeType: ct.split(';')[0]!.trim(),
      sizeBytes: ab.byteLength,
      base64: Buffer.from(ab).toString('base64'),
    };
  }
  const text = await resp.text();
  if (!text) return null;
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text;
    }
  }
  return text;
}

function parseRetryAfterSec(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const asInt = Number.parseInt(raw, 10);
  if (Number.isFinite(asInt) && asInt > 0) return asInt;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    const diff = Math.ceil((asDate - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

function extractDomain(path: string): string {
  const m = path.match(/^\/?([^/]+)/);
  return m?.[1] ?? 'default';
}

function objectToFormData(obj: unknown): FormData {
  const form = new FormData();
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (v instanceof Blob || v instanceof File) {
        form.append(k, v);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        form.append(k, String(v));
      } else if (v instanceof Uint8Array) {
        form.append(k, new Blob([v as unknown as ArrayBuffer]));
      } else {
        form.append(k, JSON.stringify(v));
      }
    }
  }
  return form;
}
