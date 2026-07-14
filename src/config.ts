import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const envFile = process.env.AVITO_ENV_FILE ?? resolve(process.cwd(), '.env');
loadDotenv({ path: envFile, quiet: true });

/**
 * Default OAuth token cache location — per-user, persistent, OS-appropriate.
 *
 *   - Linux:   $XDG_STATE_HOME/avito-mcp/token.json  (defaults to ~/.local/state/avito-mcp/token.json)
 *   - macOS:   ~/Library/Application Support/avito-mcp/token.json
 *   - Windows: %APPDATA%\avito-mcp\token.json
 *
 * Avoids writing secrets into `process.cwd()`, which is unpredictable when the
 * server is launched from an IDE, MCP client, or via `npx`.
 */
function defaultTokenFile(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'avito-mcp', 'token.json');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'avito-mcp', 'token.json');
  }
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(stateHome, 'avito-mcp', 'token.json');
}

export type SafetyMode = 'read_only' | 'guarded' | 'full_access';
export type ConfirmationMode = 'off' | 'money_public' | 'all_destructive';
export type ApprovalMode = 'self' | 'external';

// ───────────────────────── v0.9.0: HTTP transport + webhook ─────────────────────────

/** Which MCP transport(s) to run. `both` = stdio + HTTP in one process. */
export type TransportMode = 'stdio' | 'http' | 'both';
/** Auth scheme guarding the remote `/mcp` endpoint. */
export type HttpAuthMode = 'oauth' | 'bearer' | 'none';

/**
 * v0.9.0: configuration of the optional remote HTTP transport (Streamable HTTP).
 * Inert unless `transport` is `http`/`both`. Security is enforced at HTTP-start
 * time (config load stays permissive so stdio users are never blocked).
 */
export interface HttpConfig {
  transport: TransportMode;
  /** Bind address. Default 127.0.0.1 — put a TLS reverse-proxy in front for a domain. */
  host: string;
  port: number;
  /** Public base URL (e.g. https://mcp.example.com) for OAuth issuer/resource metadata. No trailing slash. */
  publicUrl: string;
  auth: HttpAuthMode;
  /** Bearer-mode shared secrets (AVITO_MCP_HTTP_AUTH_TOKEN, comma-separated). */
  authTokens: string[];
  /** Allow `auth=none` on a non-loopback host (otherwise fail-closed). */
  allowNoAuth: boolean;
  /**
   * DNS-rebinding protection allowlists. Empty → derived from publicUrl + the
   * bind host/port in src/http/mcp-http.ts. An under-specified wildcard bind
   * fails startup because no meaningful allowlist can be derived.
   */
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Max concurrent Streamable HTTP MCP sessions; initialize beyond this → 503. */
  maxSessions: number;
  /** Sessions idle longer than this are reaped (a crashed client never DELETEs). */
  sessionIdleSec: number;
  /** OAuth owner password gating the /authorize consent step (oauth mode). */
  oauthOwnerPassword?: string;
  /** Access-token TTL in seconds (oauth mode). */
  oauthTokenTtlSec: number;
  /** Optional JSON file to persist OAuth clients/tokens across restarts. */
  oauthStoreFile?: string;
}

/**
 * v0.9.0: configuration of the Avito webhook receiver. Enabled when a secret is
 * set (or AVITO_MCP_WEBHOOK_ENABLED is truthy). The receiver can run even in pure
 * stdio mode — Avito needs a public URL, the MCP client does not.
 */
export interface WebhookConfig {
  enabled: boolean;
  /** Secret path segment: POST {path}/{secret}. Constant-time compared. */
  secret?: string;
  /** Public base URL Avito should POST to (defaults to http.publicUrl). No trailing slash. */
  publicUrl: string;
  /** Mount path prefix (the secret is appended). Default /avito/webhook. */
  path: string;
  /** Ring-buffer size of retained events. */
  bufferSize: number;
  /** Optional JSONL file to append every received event to (durability). */
  logFile?: string;
}

/**
 * Parses a comma- or whitespace-separated list from env into a deduplicated array.
 * `"a, b , ,c"` → `["a", "b", "c"]`.
 */
function parseToolList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

export function parseBool(
  raw: string | undefined,
  fallback = false,
  name = 'boolean environment value',
): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new EnvValidationError(
    `${name} must be one of: true, false, 1, 0, yes, no, on, off (received ${JSON.stringify(raw)})`,
  );
}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name = 'positive integer environment value',
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new EnvValidationError(
      `${name} must be a positive base-10 integer (received ${JSON.stringify(raw)})`,
    );
  }
  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n > max) {
    throw new EnvValidationError(
      `${name} must be at most ${max} (received ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

export function parseChoice<const T extends readonly string[]>(
  raw: string | undefined,
  fallback: T[number],
  name: string,
  allowed: T,
): T[number] {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T[number];
  throw new EnvValidationError(
    `${name} must be one of: ${allowed.join(', ')} (received ${JSON.stringify(raw)})`,
  );
}

export function requireStrongSecret(value: string | undefined, name: string): void {
  if (value !== undefined && Buffer.byteLength(value, 'utf8') < 32) {
    throw new EnvValidationError(`${name} must contain at least 32 bytes`);
  }
}

function parseHttpUrl(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvValidationError(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvValidationError(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new EnvValidationError(`${name} must not contain embedded credentials`);
  }
  return stripTrailingSlash(parsed.href);
}

/**
 * Backward compatibility: `AVITO_SAFE_MODE=read-only` (v0.2.x) maps to
 * `AVITO_MCP_MODE=read_only` (v0.3.x). If both are set, the newer wins
 * and we emit a stderr deprecation note (logger isn't initialised yet at
 * config-load time, so we write directly).
 */
function resolveMode(): SafetyMode {
  const modern = process.env.AVITO_MCP_MODE;
  const legacy = process.env.AVITO_SAFE_MODE;
  if (modern) return modern as SafetyMode; // zod validates below
  if (legacy === 'read-only' || legacy === 'read_only') {
    process.stderr.write(
      'avito-mcp: AVITO_SAFE_MODE is deprecated since v0.3.0 — use AVITO_MCP_MODE=read_only.\n',
    );
    return 'read_only';
  }
  if (legacy !== undefined && legacy.trim() !== '') {
    throw new EnvValidationError(
      `AVITO_SAFE_MODE is deprecated and only accepts read-only (received ${JSON.stringify(legacy)})`,
    );
  }
  return 'full_access';
}

const ConfigSchema = z.object({
  // v0.7.4: credentials are OPTIONAL at load time so the server can start and serve
  // tools/list, resources and prompts WITHOUT credentials (introspection-only mode —
  // needed by registry indexers like Glama, by inspectors, and for `npx avito-mcp` to
  // preview the catalogue before configuring). Credentials are enforced lazily: the
  // first tool call that hits Avito fails with a clear CONFIG_ERROR if they're absent.
  // If Profile_id is provided but malformed, that's still a hard error below.
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  profileId: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().positive('Profile_id must be a positive integer').optional(),
  ),
  baseUrl: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//.test(value), 'AVITO_BASE_URL must use http or https')
    .default('https://api.avito.ru'),
  cpaSource: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[A-Za-z0-9._-]+$/,
      'AVITO_MCP_CPA_SOURCE may contain only letters, digits, dot, underscore and dash',
    )
    .default('avito-mcp'),
  tokenFile: z.string().default(defaultTokenFile()),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  mode: z.enum(['read_only', 'guarded', 'full_access']).default('full_access'),
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([]),
  exposeAuthTools: z.boolean().default(false),
  allowedUploadDirs: z.array(z.string()).default([]),
  maxUploadMb: z.number().int().positive().default(15),
  confirmationMode: z.enum(['off', 'money_public', 'all_destructive']).default('money_public'),
  confirmationTtlSec: z.number().int().positive().default(900),
  confirmationSecret: z
    .string()
    .min(32, 'AVITO_MCP_CONFIRMATION_SECRET must be at least 32 characters')
    .optional(),
  approvalMode: z.enum(['self', 'external']).default('self'),
  maxBinaryMb: z.number().int().positive().default(20),
  // v0.7.0 ───────────────────────────────────────────────────
  /** Default for `dryRun` parameter on write/money/public tools. */
  dryRunDefault: z.boolean().default(false),
  /** TTL for idempotency ledger entries, seconds. */
  idempotencyTtlSec: z.number().int().positive().default(3600),
  runtimeStateDir: z.string().min(1),
  /** Max wait for cross-process token file lock, ms. */
  tokenLockTimeoutMs: z.number().int().positive().default(30_000),
});

/** Strips a trailing slash so URLs concatenate predictably. */
function stripTrailingSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

function resolveTransport(): TransportMode {
  return parseChoice(process.env.AVITO_MCP_TRANSPORT, 'stdio', 'AVITO_MCP_TRANSPORT', [
    'stdio',
    'http',
    'both',
  ] as const);
}

function resolveHttpAuth(): HttpAuthMode {
  return parseChoice(process.env.AVITO_MCP_HTTP_AUTH, 'oauth', 'AVITO_MCP_HTTP_AUTH', [
    'oauth',
    'bearer',
    'none',
  ] as const);
}

function buildHttpConfig(): HttpConfig {
  const host = process.env.AVITO_MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const port = parsePositiveInt(
    process.env.AVITO_MCP_HTTP_PORT,
    3000,
    'AVITO_MCP_HTTP_PORT',
    65_535,
  );
  const publicUrl = parseHttpUrl(
    process.env.AVITO_MCP_HTTP_PUBLIC_URL?.trim() || `http://${host}:${port}`,
    'AVITO_MCP_HTTP_PUBLIC_URL',
  );
  const transport = resolveTransport();
  const auth = resolveHttpAuth();
  const authTokens = parseToolList(process.env.AVITO_MCP_HTTP_AUTH_TOKEN);
  const oauthOwnerPassword = process.env.AVITO_MCP_OAUTH_OWNER_PASSWORD || undefined;
  if (transport === 'http' || transport === 'both') {
    if (auth === 'oauth') requireStrongSecret(oauthOwnerPassword, 'AVITO_MCP_OAUTH_OWNER_PASSWORD');
    if (auth === 'bearer') {
      if (authTokens.length === 0) {
        throw new EnvValidationError(
          'AVITO_MCP_HTTP_AUTH_TOKEN is required when AVITO_MCP_HTTP_AUTH=bearer',
        );
      }
      for (const token of authTokens) requireStrongSecret(token, 'AVITO_MCP_HTTP_AUTH_TOKEN');
    }
  }
  return {
    transport,
    host,
    port,
    publicUrl,
    auth,
    authTokens,
    allowNoAuth: parseBool(
      process.env.AVITO_MCP_HTTP_ALLOW_NO_AUTH,
      false,
      'AVITO_MCP_HTTP_ALLOW_NO_AUTH',
    ),
    allowedHosts: parseToolList(process.env.AVITO_MCP_HTTP_ALLOWED_HOSTS),
    allowedOrigins: parseToolList(process.env.AVITO_MCP_HTTP_ALLOWED_ORIGINS),
    maxSessions: parsePositiveInt(
      process.env.AVITO_MCP_HTTP_MAX_SESSIONS,
      100,
      'AVITO_MCP_HTTP_MAX_SESSIONS',
      10_000,
    ),
    sessionIdleSec: parsePositiveInt(
      process.env.AVITO_MCP_HTTP_SESSION_IDLE_SEC,
      1800,
      'AVITO_MCP_HTTP_SESSION_IDLE_SEC',
      86_400,
    ),
    oauthOwnerPassword,
    oauthTokenTtlSec: parsePositiveInt(
      process.env.AVITO_MCP_OAUTH_TOKEN_TTL_SEC,
      3600,
      'AVITO_MCP_OAUTH_TOKEN_TTL_SEC',
      86_400,
    ),
    oauthStoreFile: process.env.AVITO_MCP_OAUTH_STORE_FILE || undefined,
  };
}

function buildWebhookConfig(httpPublicUrl: string): WebhookConfig {
  const secret = process.env.AVITO_MCP_WEBHOOK_SECRET?.trim() || undefined;
  requireStrongSecret(secret, 'AVITO_MCP_WEBHOOK_SECRET');
  // A secret is REQUIRED for the receiver to do anything (without one every
  // request 404s), so ENABLED without a secret stays disabled — server.ts warns
  // about that combo at startup. With a secret present, the explicit flag wins:
  // AVITO_MCP_WEBHOOK_ENABLED=0 turns the receiver off without unsetting the secret.
  const rawEnabled = process.env.AVITO_MCP_WEBHOOK_ENABLED?.trim() || undefined;
  const enabledFlag =
    rawEnabled === undefined
      ? undefined
      : parseBool(rawEnabled, false, 'AVITO_MCP_WEBHOOK_ENABLED');
  const enabled = secret !== undefined && (enabledFlag === undefined ? true : enabledFlag);
  const publicUrl = parseHttpUrl(
    process.env.AVITO_MCP_WEBHOOK_PUBLIC_URL?.trim() || httpPublicUrl,
    'AVITO_MCP_WEBHOOK_PUBLIC_URL',
  );
  // Normalize to '/prefix' — Express silently registers an unmatchable route
  // for a path without a leading slash.
  const rawPath = process.env.AVITO_MCP_WEBHOOK_PATH?.trim() || '/avito/webhook';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return {
    enabled,
    secret,
    publicUrl,
    path: stripTrailingSlash(path) || '/avito/webhook',
    bufferSize: parsePositiveInt(
      process.env.AVITO_MCP_WEBHOOK_BUFFER,
      100,
      'AVITO_MCP_WEBHOOK_BUFFER',
      10_000,
    ),
    logFile: process.env.AVITO_MCP_WEBHOOK_LOG_FILE || undefined,
  };
}

type ParsedConfig = z.infer<typeof ConfigSchema>;
export type Config = Omit<ParsedConfig, 'approvalMode' | 'runtimeStateDir'> & {
  /** Optional in programmatic Config fixtures; environment-loaded config always sets it. */
  approvalMode?: ApprovalMode;
  /** Optional in programmatic Config fixtures; environment-loaded config always sets it. */
  runtimeStateDir?: string;
  http: HttpConfig;
  webhook: WebhookConfig;
};

function loadUnchecked(): Config {
  const tokenFile = process.env.AVITO_TOKEN_FILE?.trim() || defaultTokenFile();
  const raw = {
    clientId: process.env.Client_id ?? process.env.CLIENT_ID,
    clientSecret: process.env.Client_secret ?? process.env.CLIENT_SECRET,
    profileId: process.env.Profile_id ?? process.env.PROFILE_ID,
    baseUrl: process.env.AVITO_BASE_URL,
    cpaSource: process.env.AVITO_MCP_CPA_SOURCE,
    tokenFile,
    logLevel: process.env.LOG_LEVEL,
    mode: resolveMode(),
    allowTools: parseToolList(process.env.AVITO_MCP_ALLOW_TOOLS),
    denyTools: parseToolList(process.env.AVITO_MCP_DENY_TOOLS),
    exposeAuthTools: parseBool(
      process.env.AVITO_MCP_EXPOSE_AUTH_TOOLS,
      false,
      'AVITO_MCP_EXPOSE_AUTH_TOOLS',
    ),
    allowedUploadDirs: parseToolList(process.env.AVITO_MCP_ALLOWED_UPLOAD_DIRS),
    maxUploadMb: parsePositiveInt(
      process.env.AVITO_MCP_MAX_UPLOAD_MB,
      15,
      'AVITO_MCP_MAX_UPLOAD_MB',
      100,
    ),
    confirmationMode:
      (process.env.AVITO_MCP_CONFIRMATION_MODE as ConfirmationMode | undefined) ?? 'money_public',
    confirmationTtlSec: parsePositiveInt(
      process.env.AVITO_MCP_CONFIRMATION_TTL_SEC,
      900,
      'AVITO_MCP_CONFIRMATION_TTL_SEC',
      86_400,
    ),
    confirmationSecret: process.env.AVITO_MCP_CONFIRMATION_SECRET,
    approvalMode: parseChoice(
      process.env.AVITO_MCP_APPROVAL_MODE,
      'self',
      'AVITO_MCP_APPROVAL_MODE',
      ['self', 'external'] as const,
    ),
    maxBinaryMb: parsePositiveInt(
      process.env.AVITO_MCP_MAX_BINARY_MB,
      20,
      'AVITO_MCP_MAX_BINARY_MB',
      100,
    ),
    // v0.7.0 ───────────────────────────────────────────────────
    dryRunDefault: parseBool(
      process.env.AVITO_MCP_DRY_RUN_DEFAULT,
      false,
      'AVITO_MCP_DRY_RUN_DEFAULT',
    ),
    idempotencyTtlSec: parsePositiveInt(
      process.env.AVITO_MCP_IDEMPOTENCY_TTL_SEC,
      3600,
      'AVITO_MCP_IDEMPOTENCY_TTL_SEC',
      604_800,
    ),
    runtimeStateDir:
      process.env.AVITO_MCP_RUNTIME_STATE_DIR?.trim() || join(dirname(tokenFile), 'runtime'),
    tokenLockTimeoutMs: parsePositiveInt(
      process.env.AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS,
      30_000,
      'AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS',
      300_000,
    ),
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(issues);
  }
  if (parsed.data.approvalMode === 'external' && !parsed.data.confirmationSecret) {
    throw new EnvValidationError(
      'AVITO_MCP_APPROVAL_MODE=external requires AVITO_MCP_CONFIRMATION_SECRET (at least 32 characters)',
    );
  }
  // HTTP + webhook config are computed in JS because several defaults depend on
  // other fields. Syntax, bounds, and applicable secret requirements fail here;
  // bind/auth topology checks that require the final app run at HTTP startup.
  const http = buildHttpConfig();
  const webhook = buildWebhookConfig(http.publicUrl);
  return { ...parsed.data, http, webhook };
}

function load(): Config {
  try {
    return loadUnchecked();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Invalid environment (${envFile}):\n${message}\n\nSee .env.example for the expected format.\n`,
    );
    process.exit(1);
  }
}

export const config = load();
