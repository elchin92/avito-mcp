import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * The pino logger writes to stderr (fd=2). The MCP stdio transport uses stdout for JSON-RPC,
 * so any write to stdout would break the protocol. All logs go to stderr only.
 *
 * v0.6.0: after the server starts, bindMcpLogger(server) is called so that the same events
 * are also delivered to the client as `notifications/message` (MCP logging). The pino output
 * to stderr stays as it was — for local debugging and for cases where the client does not
 * support logging.
 *
 * How a client asks for those events depends on the era it is speaking, and the
 * two mechanisms are not interchangeable:
 *
 *   • 2025-11-25 — `logging/setLevel` sets a CONNECTION-level threshold; the
 *     mirror below drives `server.sendLoggingMessage()`, which consults it.
 *   • 2026-07-28 — `logging/setLevel` is gone (SEP-2577). The level is declared
 *     per request in `_meta["io.modelcontextprotocol/logLevel"]`, and a request
 *     that declares none must receive nothing. That is served by
 *     {@link RequestLogSink} / {@link runWithRequestLogSink} rather than by the
 *     connection-level binding, which cannot express either rule.
 */
/**
 * v0.7.0: pino redact paths. Defence-in-depth — the current code intentionally does not log
 * headers / tokens. But if someone in the future accidentally does logger.info({ headers })
 * or passes a full Response through err.cause, we want any field with a
 * sensitive name to be replaced with '[redacted]' before serialization.
 *
 * NB (v0.9.1): a pino `*` wildcard matches exactly ONE key level — '*.token'
 * does NOT cover {a:{b:{token}}}. Sensitive names are therefore listed at one,
 * two and three levels deep, plus the realistic deep shapes (err.response.headers).
 * If pino does not find a path, it silently ignores it. Feel free to extend.
 */
const SENSITIVE_KEYS = [
  'Authorization',
  'authorization',
  'accessToken',
  'access_token',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'bearer',
  'Bearer',
  'token',
  'secret',
  'password',
  'owner_password',
  'ownerPassword',
  'oauthOwnerPassword',
  'confirmationSecret',
  'confirmation_secret',
  'authTokens',
  'apiKey',
  'api_key',
  'cookie',
  'set-cookie',
  'tokenFile',
  'filePath',
  'storeFile',
  'logFile',
  'lockPath',
];

const REDACT_PATHS = [
  ...SENSITIVE_KEYS,
  ...Array.from({ length: 12 }, (_, depth) =>
    SENSITIVE_KEYS.map((key) => `${'*.'.repeat(depth + 1)}${key}`),
  ).flat(),
  'headers.Authorization',
  'headers.authorization',
  'err.response.headers.authorization',
  'err.response.headers.Authorization',
];

/**
 * Recursive censor for the MCP log mirror: bindMcpLogger sends the ORIGINAL
 * payload object to the client, bypassing pino's redaction entirely — so the
 * same sensitive-key set must be applied here before the payload leaves the
 * process.
 */
const SENSITIVE_KEY_RE = /(authorization|secret|password|token|bearer|cookie|api[_-]?key)s?$/i;
const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

function censorSensitive(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => censorSensitive(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      SENSITIVE_KEY_SET.has(k.toLowerCase()) || SENSITIVE_KEY_RE.test(k)
        ? '[redacted]'
        : censorSensitive(v, depth + 1);
  }
  return out;
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'avito-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
      // remove: false (default) — we keep the keys as is and only censor the value,
      // so the presence of a key in the log still tells us "was Authorization present"
    },
  },
  pino.destination(2),
);

interface McpLogBinding {
  server: McpServer;
  background: boolean;
  active: boolean;
}

const mcpLogBindings = new Map<McpServer, McpLogBinding>();
const mcpLogContext = new AsyncLocalStorage<McpServer>();
let mcpMirrorInstalled = false;

/**
 * M3 item 10 — the request-scoped delivery seam for `notifications/message`.
 *
 * Revision 2026-07-28 turns the log mirror into a per-request feature with two
 * MUST NOTs the shape of this module previously violated by construction:
 *
 *   • nothing may be sent for a request whose `_meta` carries no
 *     `io.modelcontextprotocol/logLevel`;
 *   • nothing may be delivered on a stream other than the one carrying that
 *     request's own response.
 *
 * `server.sendLoggingMessage()` — what {@link bindMcpLogger} drives — can honour
 * neither: it is a connection-level `Protocol.notification()` with no request to
 * scope to, and it does not read the envelope. The per-request context the SDK
 * hands a handler does honour both: `ctx.mcpReq.log()` returns early on a modern
 * request with no envelope log level, and routes through `ctx.mcpReq.notify`,
 * which the per-request transport binds to that request's response stream.
 *
 * So the mirror does not decide anything about the modern era itself. It only
 * has to prefer the sink of the request it is running inside, and that sink is
 * `ctx.mcpReq` verbatim. When one is installed it takes the log line EXCLUSIVELY
 * — falling through to the connection-level bindings afterwards would put the
 * same line on a second stream, which is the second MUST NOT.
 */
export interface RequestLogSink {
  log(level: McpLogLevel, data: unknown, logger?: string): Promise<void>;
}

/** The RFC 5424 severities MCP defines; the subset pino levels map onto. */
export type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

const requestLogContext = new AsyncLocalStorage<RequestLogSink>();

/**
 * Runs `operation` with `sink` as the destination for every MCP log mirror
 * event produced inside it, including asynchronously — the store follows the
 * await chain, which is what makes this correct for a handler that awaits an
 * Avito call and logs from inside it.
 */
export function runWithRequestLogSink<T>(sink: RequestLogSink, operation: () => T): T {
  // The pino→MCP wrapper used to be installed only by `bindMcpLogger`, which a
  // modern-era instance deliberately never calls (see `createServerFactory`).
  // Without this line the request-scoped path would be dead code in exactly the
  // deployment it exists for: every modern log line would go to stderr only,
  // and a client that asked for a log level would receive nothing — silently,
  // because "nothing arrived" is also what correct behaviour looks like for a
  // request that asked for no level. Installation is idempotent.
  installMcpMirror();
  return requestLogContext.run(sink, operation);
}

/** Test/introspection: whether a request-scoped sink is installed right here. */
export function hasRequestLogSink(): boolean {
  return requestLogContext.getStore() !== undefined;
}

/** MCP logging severities (RFC-5424). Pino → MCP mapping. */
const PINO_TO_MCP: Record<string, McpLogLevel> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'critical',
};

interface PinoLogEvent {
  level: number;
  time: string;
  service: string;
  msg: string;
  [key: string]: unknown;
}

/**
 * Wires up pino → MCP mirroring. Must be called AFTER server.connect(),
 * otherwise sendLoggingMessage fails immediately ("not connected").
 *
 * We use pino.multistream via rewriting — pino supports hooks
 * (`logMethod`), but it is simpler to put a thin wrapper over the logger's level methods.
 * We keep it lazy: if the server is absent, we do not break.
 */
function installMcpMirror(): void {
  if (mcpMirrorInstalled) return;
  mcpMirrorInstalled = true;
  const pinoLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  for (const lvl of pinoLevels) {
    const original = logger[lvl].bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any)[lvl] = (...args: unknown[]): void => {
      original(...(args as Parameters<typeof original>));
      // Extract data for MCP separately — pino's args format is:
      //   logger.info({obj}, 'msg', ...rest) OR logger.info('msg', ...rest)
      let data: Record<string, unknown> | undefined;
      let msg: string | undefined;
      if (args.length === 0) return;
      if (typeof args[0] === 'object' && args[0] !== null) {
        data = args[0] as Record<string, unknown>;
        msg = typeof args[1] === 'string' ? args[1] : undefined;
      } else if (typeof args[0] === 'string') {
        msg = args[0];
      }
      const payload: PinoLogEvent = {
        level: pinoLevels.indexOf(lvl),
        time: new Date().toISOString(),
        service: 'avito-mcp',
        msg: msg ?? '',
        ...((censorSensitive(data) as Record<string, unknown> | undefined) ?? {}),
      };
      const message = {
        level: PINO_TO_MCP[lvl] ?? 'info',
        logger: 'avito-mcp',
        data: payload,
      } as const;

      // Request-scoped delivery wins and is EXCLUSIVE. See RequestLogSink: a
      // fall-through would put the same line on a second stream, and the sink
      // itself owns the "was a log level asked for" decision.
      const requestSink = requestLogContext.getStore();
      if (requestSink !== undefined) {
        void requestSink.log(message.level, message.data, message.logger).catch(() => {
          // The stream may already be closed (client hung up mid-request).
        });
        return;
      }

      const contextualServer = mcpLogContext.getStore();
      const contextualBinding = contextualServer ? mcpLogBindings.get(contextualServer) : undefined;
      const targets = contextualServer
        ? contextualBinding?.active
          ? [contextualBinding]
          : []
        : [...mcpLogBindings.values()].filter((binding) => binding.active && binding.background);
      for (const binding of targets) {
        void binding.server.sendLoggingMessage(message).catch(() => {
          // The client may not have enabled logging notifications. The sink
          // remains registered until its transport/session teardown runs.
        });
      }
    };
  }
}

/**
 * Registers one connected MCP session as a log sink and returns its teardown.
 * The global pino methods are wrapped exactly once, regardless of session count.
 */
export function bindMcpLogger(
  server: McpServer,
  options: { background?: boolean } = {},
): () => void {
  installMcpMirror();
  const binding: McpLogBinding = {
    server,
    background: options.background ?? true,
    active: true,
  };
  mcpLogBindings.set(server, binding);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    binding.active = false;
    if (mcpLogBindings.get(server) === binding) mcpLogBindings.delete(server);
  };
}

/** Routes logs created by `operation` only to the owning MCP session. */
export function runWithMcpLogger<T>(server: McpServer, operation: () => T): T {
  return mcpLogContext.run(server, operation);
}
