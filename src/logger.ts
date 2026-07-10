import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The pino logger writes to stderr (fd=2). The MCP stdio transport uses stdout for JSON-RPC,
 * so any write to stdout would break the protocol. All logs go to stderr only.
 *
 * v0.6.0: after the server starts, bindMcpLogger(server) is called so that the same events
 * are also delivered to the client as `notifications/message` (MCP logging). The client can
 * filter them via `logging/setLevel`. The pino output to stderr stays as it was — for
 * local debugging and for cases where the client does not support logging.
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
const SENSITIVE_KEY_RE =
  /(authorization|secret|password|token|bearer|cookie|api[_-]?key)s?$/i;
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

/** MCP logging severities (RFC-5424). Pino → MCP mapping. */
const PINO_TO_MCP: Record<string, 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical'> =
  {
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
