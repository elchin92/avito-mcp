/**
 * M3.9 — the era-2026 test seam.
 *
 * WHY THIS EXISTS. `InMemoryTransport` covers the 2025 era only. There is no
 * in-memory entry point for 2026-07-28 at all: the modern era is served by
 * `createMcpHandler` (a `Request`→`Response` face) and by `serveStdio` (which
 * owns a child process's stdio), and neither can be driven by an in-process
 * client pair. So a suite that "tests the modern era" through an SDK `Client`
 * over `InMemoryTransport` is testing the legacy era with modern-sounding names.
 * Every modern assertion in this repository goes through this file instead.
 *
 * WHY RAW `fetch` AND RAW JSON-RPC. What matters here is the bytes a real client
 * sees: HTTP status, response headers, and the exact JSON-RPC frame. An SDK
 * `Client` would paper over a wrong status, a missing `Allow`, or a stripped
 * `resultType` — the last one especially, because v2 removed `resultType` from
 * the public result types while keeping it mandatory on the wire.
 *
 * The rig starts the REAL `startHttpServer` on a loopback port, so everything
 * under test is the production path: the rebinding guard, `express.json()`, the
 * era dispatcher in `src/http/mcp-http.ts`, and the SDK entry behind it.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
} from '@modelcontextprotocol/server';

import { AvitoClient } from '../../src/core/client.js';
import { PendingActionStore } from '../../src/core/pending-actions.js';
import { IdempotencyStore } from '../../src/core/idempotency.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/app.js';
import type { ToolContext } from '../../src/core/tool-factory.js';
import type { Config, HttpConfig, ProtocolEraMode } from '../../src/config.js';
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from '../../src/version.js';

/**
 * The reserved `_meta` envelope keys, taken from the SDK rather than spelled
 * out: if a key ever moves, these suites must move with it instead of quietly
 * testing a name nobody reads any more.
 */
export const META = {
  protocolVersion: PROTOCOL_VERSION_META_KEY,
  clientCapabilities: CLIENT_CAPABILITIES_META_KEY,
  clientInfo: CLIENT_INFO_META_KEY,
  logLevel: LOG_LEVEL_META_KEY,
  subscriptionId: SUBSCRIPTION_ID_META_KEY,
} as const;

export const MODERN_REVISION = MODERN_PROTOCOL_VERSION;
export const LEGACY_REVISION = LEGACY_PROTOCOL_VERSION;

export function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://mcp.example.com',
    auth: 'none',
    authTokens: [],
    allowNoAuth: true,
    allowedHosts: [],
    allowedOrigins: [],
    maxSessions: 100,
    sessionIdleSec: 1800,
    oauthTokenTtlSec: 3600,
    ...overrides,
  };
}

export function makeConfig(protocolEra?: ProtocolEraMode): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345678,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: false,
    allowedUploadDirs: [],
    maxUploadMb: 15,
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    confirmationSecret: undefined,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    // Deliberately assigned rather than spread from an overrides bag: `undefined`
    // here is the "operator never set the variable" case, which must behave as
    // `legacy`.
    protocolEra,
    http: makeHttpConfig(),
    webhook: { enabled: false, publicUrl: 'https://mcp.example.com', path: '/x', bufferSize: 10 },
  } as Config;
}

export interface Rig {
  handle: HttpServerHandle;
  base: string;
  host: string;
  /**
   * The very `ToolContext` the running server was built from. Exposed because
   * the subscription suites have to make the server's own state CHANGE
   * (`pendingStore.createPersistent`, `webhookStore.add`) and then assert what
   * appeared on an open stream — driving that through tool calls instead would
   * test the tools, not the notification routing.
   */
  ctx: ToolContext;
}

const rigs: Rig[] = [];

export async function startRig(
  protocolEra?: ProtocolEraMode,
  configure?: (config: Config) => void,
  decorate?: (ctx: ToolContext) => void,
): Promise<Rig> {
  const cfg = makeConfig(protocolEra);
  configure?.(cfg);
  // The rebinding allowlists are derived before listen(), so the port has to be
  // known up front for the derived Host entry to match the request we send.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  cfg.http.port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));

  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
    idempotencyStore: new IdempotencyStore(cfg.idempotencyTtlSec * 1000),
  };
  decorate?.(ctx);
  const handle = await startHttpServer(ctx, cfg);
  const rig: Rig = {
    handle,
    base: `http://127.0.0.1:${handle.port}`,
    host: `127.0.0.1:${handle.port}`,
    ctx,
  };
  rigs.push(rig);
  return rig;
}

/** For `afterEach`. Closes every rig this module started and forgets them. */
export async function closeRigs(): Promise<void> {
  await Promise.allSettled(rigs.splice(0).map((rig) => rig.handle.close()));
}

export interface Answer {
  status: number;
  sessionId: string | null;
  allow: string | null;
  body: Record<string, unknown> | null;
}

/** Reads either a plain JSON body or the last SSE `data:` frame. */
export async function readAnswer(res: Response): Promise<Answer['body']> {
  const text = await res.text();
  if (!text) return null;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    return frames.length
      ? (JSON.parse(frames[frames.length - 1]!) as Record<string, unknown>)
      : null;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function toAnswer(res: Response): Promise<Answer> {
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    allow: res.headers.get('allow'),
    body: await readAnswer(res),
  };
}

/**
 * The escape hatch the negative matrices need: full control over the HTTP
 * method, the headers and the body, with nothing added implicitly.
 */
export async function rawRequest(
  rig: Rig,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Answer> {
  const res = await fetch(`${rig.base}/mcp`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: rig.host,
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return toAnswer(res);
}

/** A 2025-era POST: no envelope, no SEP-2243 headers beyond the session id. */
export async function legacyPost(
  rig: Rig,
  message: unknown,
  sessionId?: string | null,
): Promise<Answer> {
  return rawRequest(rig, {
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    body: message,
  });
}

export interface ModernPostOptions {
  /** Extra or overriding HTTP headers (a value of `null` deletes the default). */
  headers?: Record<string, string | null>;
  /** Extra or overriding `_meta` envelope keys (a value of `undefined` deletes). */
  meta?: Record<string, unknown>;
  /** `Mcp-Name`; sent verbatim. Omit to have the rig derive it from the body. */
  name?: string;
  id?: string | number;
}

/**
 * A well-formed 2026-07-28 POST: the per-request envelope in `params._meta`
 * plus the three SEP-2243 standard headers, with `Mcp-Name` derived from
 * `params.name` / `params.uri` exactly as the revision's table prescribes.
 */
export async function modernPost(
  rig: Rig,
  method: string,
  params: Record<string, unknown> = {},
  options: ModernPostOptions = {},
): Promise<Answer> {
  const derivedName =
    options.name ??
    (typeof params.name === 'string'
      ? params.name
      : typeof params.uri === 'string'
        ? params.uri
        : undefined);

  const headers: Record<string, string> = {
    'MCP-Protocol-Version': MODERN_REVISION,
    'Mcp-Method': method,
    ...(derivedName !== undefined ? { 'Mcp-Name': derivedName } : {}),
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }

  const meta: Record<string, unknown> = {
    [META.protocolVersion]: MODERN_REVISION,
    [META.clientCapabilities]: {},
    [META.clientInfo]: { name: 'modern-rig', version: '1.0.0' },
    ...(options.meta ?? {}),
  };
  for (const [key, value] of Object.entries(options.meta ?? {})) {
    if (value === undefined) delete meta[key];
  }

  return rawRequest(rig, {
    headers,
    body: {
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: { ...params, _meta: meta },
    },
  });
}

/** One JSON-RPC message read off an open SSE stream. */
export interface Frame {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A `subscriptions/listen` stream (or any other long-lived SSE response), read
 * frame by frame.
 *
 * `rawRequest` cannot serve these: it does `await res.text()`, which on a
 * listen stream never resolves — the whole point of the stream is that it stays
 * open. And the assertions this era needs are ORDERING assertions ("the ack is
 * the first message", "no unrequested type ever appears", "the graceful close
 * arrives before the stream ends"), which a whole-body read cannot express at
 * all.
 *
 * `abort()` closes the client end WITHOUT a graceful shutdown — which is also
 * the fixture for item 11: on this era, closing the response stream IS the
 * cancellation signal.
 */
export interface ModernStream {
  status: number;
  contentType: string | null;
  /** Resolves with the next frame, or rejects when the stream ends first. */
  next(timeoutMs?: number): Promise<Frame>;
  /** Every frame received so far, in arrival order. */
  received(): Frame[];
  /** Resolves once the server closed the stream. */
  ended(): Promise<void>;
  /** Client-side hang-up: the server sees the response stream close. */
  abort(): void;
}

export async function openModernStream(
  rig: Rig,
  method: string,
  params: Record<string, unknown> = {},
  options: ModernPostOptions = {},
): Promise<ModernStream> {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    host: rig.host,
    'MCP-Protocol-Version': MODERN_REVISION,
    'Mcp-Method': method,
    ...(options.name !== undefined ? { 'Mcp-Name': options.name } : {}),
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  const meta: Record<string, unknown> = {
    [META.protocolVersion]: MODERN_REVISION,
    [META.clientCapabilities]: {},
    [META.clientInfo]: { name: 'modern-rig', version: '1.0.0' },
    ...(options.meta ?? {}),
  };
  for (const [key, value] of Object.entries(options.meta ?? {})) {
    if (value === undefined) delete meta[key];
  }

  const res = await fetch(`${rig.base}/mcp`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: { ...params, _meta: meta },
    }),
  });

  const frames: Frame[] = [];
  /** How many of `frames` `next()` has already handed out. */
  let delivered = 0;
  const waiters: Array<{ resolve: (frame: Frame) => void; reject: (err: Error) => void }> = [];
  let done = false;
  let endResolve!: () => void;
  const endPromise = new Promise<void>((resolve) => {
    endResolve = resolve;
  });

  const streaming = (res.headers.get('content-type') ?? '').includes('text/event-stream');

  void (async (): Promise<void> => {
    try {
      if (res.body === null) return;
      // A modern exchange upgrades to SSE only when the handler emits something
      // before its result (`responseMode: 'auto'`). A plain JSON answer is the
      // same exchange with one frame, and the suites must be able to assert
      // "exactly one frame, and it is the result" — so both shapes land in the
      // same frame list rather than one of them being unreadable here.
      if (!streaming) {
        const text = await res.text();
        if (text) frames.push(JSON.parse(text) as Frame);
        while (waiters.length > 0 && delivered < frames.length) {
          waiters.shift()!.resolve(frames[delivered++]!);
        }
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE events are separated by a blank line; keepalives are `:` comments.
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            frames.push(JSON.parse(line.slice(5).trim()) as Frame);
          }
          split = buffer.indexOf('\n\n');
        }
        while (waiters.length > 0 && delivered < frames.length) {
          waiters.shift()!.resolve(frames[delivered++]!);
        }
      }
    } catch {
      // Aborted by us, or the connection dropped: both end the stream.
    } finally {
      done = true;
      while (waiters.length > 0) {
        waiters.shift()!.reject(new Error('stream ended before the next frame arrived'));
      }
      endResolve();
    }
  })();

  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    received: () => [...frames],
    ended: () => endPromise,
    abort: () => controller.abort(),
    next: (timeoutMs = 5_000): Promise<Frame> =>
      new Promise<Frame>((resolve, reject) => {
        if (delivered < frames.length) {
          resolve(frames[delivered++]!);
          return;
        }
        if (done) {
          reject(new Error('stream ended before the next frame arrived'));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`no frame within ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      }),
  };
}

/** The JSON-RPC `result` of an answer, or `undefined` when it carried an error. */
export function resultOf(answer: Answer): Record<string, unknown> | undefined {
  return (answer.body as { result?: Record<string, unknown> } | null)?.result;
}

/** The JSON-RPC `error` of an answer, or `undefined` when it carried a result. */
export function errorOf(
  answer: Answer,
): { code: number; message: string; data?: unknown } | undefined {
  return (answer.body as { error?: { code: number; message: string; data?: unknown } } | null)
    ?.error;
}

export function initializeMessage(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LEGACY_REVISION,
      capabilities: {},
      clientInfo: { name: 'modern-rig', version: '1.0.0' },
    },
  };
}
