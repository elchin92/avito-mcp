import { logger } from '../logger.js';
import type { Config } from '../config.js';
import { USER_AGENT } from '../version.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import {
  AvitoApiError,
  AvitoTransportError,
  MissingCredentialsError,
  type RequestInfo,
} from './errors.js';
import { TokenStore } from './token-store.js';
import { RateLimiter, sleep } from './rate-limiter.js';
import { buildUrl, type Primitive, type QueryValue } from './url.js';
import { hasConfiguredCredentials } from './credentials.js';
import { runtimeNamespace, runtimeStateDirectory } from './runtime-state.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export type BodyContentType =
  'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
export type SafeStaticHeaderName = 'X-Source';
export type SafeStaticHeaders = Partial<Record<SafeStaticHeaderName, string>>;

export interface RequestOptions {
  method: HttpMethod;
  /** Path template with {placeholders}, e.g. "/core/v1/accounts/{user_id}/balance/" */
  path: string;
  pathParams?: Record<string, Primitive>;
  query?: Record<string, QueryValue>;
  /** Body — an object (for JSON / multipart) or a string (for an already serialized body). */
  body?: unknown;
  bodyContentType?: BodyContentType;
  /** If false, the Authorization header is not added. Used for /token and autoload-public. */
  auth?: boolean;
  /** Logical name for the rate-limiter (defaults to the first path segment). */
  domain?: string;
  /** Request timeout. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Explicitly allow status-code retries for a non-GET operation. */
  retry?: boolean;
  /** Code-owned headers. Runtime-enforced allowlist prevents forwarding arbitrary model input. */
  staticHeaders?: SafeStaticHeaders;
  /** Explicit code-owned opt-in for Swagger operations that require a GET JSON body. */
  allowGetBody?: boolean;
}

export interface RequestResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

/**
 * Body accepted by the native fetch in Node 22+ — not exported by @types/node as FetchBody.
 * Covers all serializations used in the project.
 */
type FetchBody = string | URLSearchParams | FormData | Uint8Array | Blob | null;

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RetryConfig {
  /** Base backoff for 429 in milliseconds. Effective backoff = base * 2^retry. */
  retry429BaseMs: number;
  /** Maximum number of retries on 429. */
  max429Retries: number;
  /** Backoff for a single 5xx retry in milliseconds. */
  retry5xxBackoffMs: number;
  /** Maximum number of retries on 5xx. */
  max5xxRetries: number;
  /** Upper bound for a server-provided Retry-After delay. */
  maxRetryAfterMs: number;
  /** Random spread applied to retry delays (0.2 means +/-20%). */
  retryJitterRatio: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  retry429BaseMs: 1000,
  max429Retries: 3,
  retry5xxBackoffMs: 500,
  max5xxRetries: 1,
  maxRetryAfterMs: 30_000,
  retryJitterRatio: 0.2,
};

export class AvitoClient {
  readonly rateLimiter: RateLimiter;
  readonly tokenStore: TokenStore;
  private readonly retry: RetryConfig;

  constructor(
    private readonly config: Config,
    opts: { retry?: Partial<RetryConfig> } = {},
  ) {
    this.rateLimiter = new RateLimiter({
      stateDir: runtimeStateDirectory(config),
      namespace: runtimeNamespace(config),
      lockTimeoutMs: config.tokenLockTimeoutMs,
    });
    this.tokenStore = new TokenStore(
      config.tokenFile,
      () => this.fetchTokenViaClientCredentials(),
      config.tokenLockTimeoutMs,
      {
        baseUrl: config.baseUrl,
        clientId: config.clientId,
        profileId: config.profileId,
      },
    );
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
  }

  async request<T = unknown>(opts: RequestOptions): Promise<RequestResponse<T>> {
    const url = buildUrl(this.config.baseUrl, opts.path, opts.pathParams, opts.query);
    const domain = opts.domain ?? extractDomain(opts.path);
    const rateKey = `${domain}:${opts.method}:${opts.path}`;
    const reqInfo: RequestInfo = { method: opts.method, url, domain };
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    await this.awaitBeforeDeadline(this.rateLimiter.waitIfNeeded(rateKey), deadline, reqInfo);

    return this.doRequest<T>(opts, url, reqInfo, deadline, rateKey);
  }

  private async doRequest<T>(
    opts: RequestOptions,
    url: string,
    reqInfo: RequestInfo,
    deadline: number,
    rateKey: string,
  ): Promise<RequestResponse<T>> {
    let allowRefresh = true;
    let retries429 = 0;
    let retries5xx = 0;
    const retryableMethod = opts.retry ?? opts.method === 'GET';

    while (true) {
      const { headers, body } = await this.buildHeadersAndBody(opts, deadline, reqInfo);
      const remainingMs = this.assertBeforeDeadline(deadline, reqInfo);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), remainingMs);

      try {
        const requestInit: RequestInit = {
          method: opts.method,
          headers,
          body: body as FetchBody | null,
          signal: ctl.signal,
        };
        const resp =
          opts.method === 'GET' && body !== null
            ? await fetchGetWithBody(url, requestInit, opts.allowGetBody === true)
            : await fetch(url, requestInit);

        this.rateLimiter.observe(rateKey, resp.headers, reqInfo.domain ?? 'default');

        if (resp.status === 401 && allowRefresh && opts.auth !== false) {
          await discardResponse(resp);
          allowRefresh = false;
          logger.info({ url }, '401 from avito, refreshing token and retrying once');
          await this.awaitBeforeDeadline(
            (async () => {
              await this.tokenStore.invalidate();
              await this.tokenStore.refresh();
            })(),
            deadline,
            reqInfo,
          );
          continue;
        }

        if (retryableMethod && resp.status === 429 && retries429 < this.retry.max429Retries) {
          const retryAfterSec = parseRetryAfterSec(resp.headers.get('retry-after'));
          const rawBackoffMs =
            retryAfterSec !== undefined
              ? Math.min(retryAfterSec * 1000, this.retry.maxRetryAfterMs)
              : this.retry.retry429BaseMs * Math.pow(2, retries429);
          const backoffMs = jitter(rawBackoffMs, this.retry.retryJitterRatio);
          await discardResponse(resp);
          retries429 += 1;
          logger.warn({ url, retries429, backoffMs }, '429 rate-limited, backing off');
          await this.sleepBeforeDeadline(backoffMs, deadline, reqInfo);
          continue;
        }

        if (
          retryableMethod &&
          resp.status >= 500 &&
          resp.status < 600 &&
          retries5xx < this.retry.max5xxRetries
        ) {
          await discardResponse(resp);
          retries5xx += 1;
          const backoffMs = jitter(this.retry.retry5xxBackoffMs, this.retry.retryJitterRatio);
          logger.warn({ url, status: resp.status, retries5xx }, '5xx from avito, retrying');
          await this.sleepBeforeDeadline(backoffMs, deadline, reqInfo);
          continue;
        }

        const maxResponseBytes = (this.config.maxBinaryMb ?? 20) * 1024 * 1024;
        const data = await safeParseResponse<T>(resp, maxResponseBytes, ctl.signal);

        if (!resp.ok) {
          throw new AvitoApiError({
            status: resp.status,
            body: data,
            request: reqInfo,
            retryAfter: parseRetryAfterSec(resp.headers.get('retry-after')),
          });
        }

        return { status: resp.status, data: data as T, headers: resp.headers };
      } catch (err) {
        if (err instanceof AvitoApiError || err instanceof ResponseLimitError) throw err;
        const cause = ctl.signal.aborted
          ? new Error('Request timeout: deadline exceeded while receiving response')
          : err;
        throw new AvitoTransportError(reqInfo, cause);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private assertBeforeDeadline(deadline: number, reqInfo: RequestInfo): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AvitoTransportError(reqInfo, new Error('Request timeout: deadline exceeded'));
    }
    return remaining;
  }

  private async sleepBeforeDeadline(
    delayMs: number,
    deadline: number,
    reqInfo: RequestInfo,
  ): Promise<void> {
    const remaining = this.assertBeforeDeadline(deadline, reqInfo);
    if (delayMs >= remaining) {
      await sleep(remaining);
      throw new AvitoTransportError(reqInfo, new Error('Request timeout: retry deadline exceeded'));
    }
    await sleep(delayMs);
  }

  private async awaitBeforeDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    reqInfo: RequestInfo,
  ): Promise<T> {
    const remaining = this.assertBeforeDeadline(deadline, reqInfo);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AvitoTransportError(
                  reqInfo,
                  new Error('Request timeout: deadline exceeded before network attempt'),
                ),
              ),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async buildHeadersAndBody(
    opts: RequestOptions,
    deadline?: number,
    reqInfo?: RequestInfo,
  ): Promise<{
    headers: Record<string, string>;
    body: FetchBody | null;
  }> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };

    addSafeStaticHeaders(headers, opts.staticHeaders);

    if (opts.auth !== false) {
      this.assertCredentialsConfigured();
      const tokenPromise = this.tokenStore.getToken();
      const token =
        deadline !== undefined && reqInfo
          ? await this.awaitBeforeDeadline(tokenPromise, deadline, reqInfo)
          : await tokenPromise;
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
      // browser/node fetch sets the boundary itself; do NOT set Content-Type manually
      const form = opts.body instanceof FormData ? opts.body : objectToFormData(opts.body);
      return { headers, body: form };
    }
    throw new Error(`Unsupported bodyContentType: ${contentType}`);
  }

  private assertCredentialsConfigured(): void {
    if (!hasConfiguredCredentials(this.config)) {
      throw new MissingCredentialsError();
    }
  }

  /**
   * OAuth 2.0 client_credentials. The same handler backs the POST /token endpoint.
   * Done without an auth token (we don't have one yet), directly via fetch.
   */
  private async fetchTokenViaClientCredentials(): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    // Defense-in-depth: buildHeadersAndBody() already checks this before reading any
    // cached token, but keep the guard here so direct token refreshes and future callers
    // cannot POST partial credentials to Avito.
    this.assertCredentialsConfigured();
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    let resp: Response;
    let data: TokenResponse | string | BinaryResponse | null;
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
      data = await safeParseResponse<TokenResponse>(resp, 1024 * 1024, ctl.signal);
    } catch (err) {
      if (err instanceof ResponseLimitError) throw err;
      const cause = ctl.signal.aborted
        ? new Error('Token request timeout: deadline exceeded while receiving response')
        : err;
      throw new AvitoTransportError({ method: 'POST', url }, cause);
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new AvitoApiError({
        status: resp.status,
        body: data,
        request: { method: 'POST', url },
        message: `Token fetch failed: ${resp.status}`,
      });
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !('access_token' in data) ||
      typeof data.access_token !== 'string' ||
      typeof data.expires_in !== 'number'
    ) {
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
 * Structured binary response from Avito (PDF labels, audio recordings, etc.).
 * Turned into a string via formatResponse — the agent sees mime/size and base64,
 * and can save the bytes to a file through its own client.
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
  if (lower.includes('application/json') || lower.includes('+json')) return false;
  if (lower.startsWith('text/')) return false;
  if (lower.includes('application/xml') || lower.includes('+xml')) return false;
  if (lower.includes('application/x-www-form-urlencoded')) return false;
  // Everything else (application/pdf, audio/*, image/*, application/octet-stream, ...) is binary.
  return true;
}

class ResponseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseLimitError';
  }
}

async function readBodyWithLimit(
  resp: Response,
  maxBytes: number,
  binary: boolean,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(0);

  const cl = resp.headers.get('content-length');
  const declared = cl ? Number.parseInt(cl, 10) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body.cancel().catch(() => undefined);
    throw new ResponseLimitError(responseLimitMessage(binary, declared, maxBytes, true));
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseLimitError(responseLimitMessage(binary, total, maxBytes, false));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function safeParseResponse<T>(
  resp: Response,
  maxBinaryBytes: number = 20 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<T | string | BinaryResponse | null> {
  const ct = resp.headers.get('content-type') ?? '';
  const binary = isBinaryContent(ct);
  const bytes = await readBodyWithLimit(resp, maxBinaryBytes, binary, signal);
  if (bytes.byteLength === 0) return null;
  if (binary) {
    return {
      __binary: true,
      mimeType: ct.split(';')[0]!.trim(),
      sizeBytes: bytes.byteLength,
      base64: Buffer.from(bytes).toString('base64'),
    };
  }
  const text = new TextDecoder().decode(bytes);
  if (ct.toLowerCase().includes('application/json') || ct.toLowerCase().includes('+json')) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text;
    }
  }
  return text;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw new DOMException('Response body read aborted', 'AbortError');
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new DOMException('Response body read aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function responseLimitMessage(
  binary: boolean,
  bytes: number,
  maxBytes: number,
  declared: boolean,
): string {
  const kind = binary ? 'Binary response' : 'Response body';
  const size = declared ? `Content-Length=${bytes}` : `${bytes}`;
  return (
    `${kind} too large: ${size} bytes > AVITO_MCP_MAX_BINARY_MB limit (${maxBytes} bytes). ` +
    'Increase AVITO_MCP_MAX_BINARY_MB or fetch this resource via direct HTTP.'
  );
}

async function discardResponse(resp: Response): Promise<void> {
  await resp.body?.cancel().catch(() => undefined);
}

function jitter(delayMs: number, ratio: number): number {
  if (delayMs <= 0 || ratio <= 0) return Math.max(0, Math.round(delayMs));
  const spread = delayMs * Math.min(ratio, 1);
  return Math.max(0, Math.round(delayMs - spread + Math.random() * spread * 2));
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

const SAFE_STATIC_HEADERS = new Set<string>(['x-source']);

function addSafeStaticHeaders(
  target: Record<string, string>,
  provided: SafeStaticHeaders | undefined,
): void {
  if (!provided) return;
  for (const [name, value] of Object.entries(provided)) {
    if (!SAFE_STATIC_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Static request header is not allowlisted: ${name}`);
    }
    if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
      throw new Error(`Static request header has an invalid value: ${name}`);
    }
    target[name] = value;
  }
}

/**
 * WHATWG fetch deliberately rejects GET bodies. A small number of documented Avito
 * Swagger operations require one, so they use this explicit code-only path.
 */
async function fetchGetWithBody(
  rawUrl: string,
  init: RequestInit,
  explicitlyAllowed: boolean,
): Promise<Response> {
  if (!explicitlyAllowed) {
    throw new Error('GET request body requires the code-owned allowGetBody option');
  }
  const body = init.body;
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
    throw new Error('GET request body transport supports only string or Uint8Array bodies');
  }

  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported GET body URL protocol: ${url.protocol}`);
  }
  const headers = new Headers(init.headers);
  if (!headers.has('content-length')) {
    headers.set(
      'content-length',
      String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength),
    );
  }

  return new Promise<Response>((resolve, reject) => {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      {
        method: 'GET',
        headers: Object.fromEntries(headers.entries()),
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const bodyAllowed = ![204, 205, 304].includes(incoming.statusCode ?? 500);
        const webBody = bodyAllowed
          ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
          : null;
        resolve(
          new Response(webBody, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}
