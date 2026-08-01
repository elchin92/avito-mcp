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
  PROTOCOL_VERSION_META_KEY,
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
}

const rigs: Rig[] = [];

export async function startRig(
  protocolEra?: ProtocolEraMode,
  configure?: (config: Config) => void,
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
  const handle = await startHttpServer(ctx, cfg);
  const rig: Rig = {
    handle,
    base: `http://127.0.0.1:${handle.port}`,
    host: `127.0.0.1:${handle.port}`,
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
