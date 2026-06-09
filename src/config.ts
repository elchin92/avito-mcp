import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
   * bind host/port in src/http/mcp-http.ts (protection stays ON; it is only
   * skipped for a wildcard bind without an explicit public URL, where no
   * meaningful allowlist can be derived).
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

export function parseBool(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  profileId: z.coerce.number().int().positive('Profile_id must be a positive integer').optional(),
  baseUrl: z.string().url().default('https://api.avito.ru'),
  tokenFile: z.string().default(defaultTokenFile()),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  mode: z.enum(['read_only', 'guarded', 'full_access']).default('full_access'),
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([]),
  exposeAuthTools: z.boolean().default(false),
  allowedUploadDirs: z.array(z.string()).default([]),
  maxUploadMb: z.number().int().positive().default(15),
  confirmationMode: z.enum(['off', 'money_public', 'all_destructive']).default('money_public'),
  confirmationTtlSec: z.number().int().positive().default(900),
  confirmationSecret: z.string().optional(),
  maxBinaryMb: z.number().int().positive().default(20),
  // v0.7.0 ───────────────────────────────────────────────────
  /** Default for `dryRun` parameter on write/money/public tools. */
  dryRunDefault: z.boolean().default(false),
  /** TTL for idempotency ledger entries, seconds. */
  idempotencyTtlSec: z.number().int().positive().default(3600),
  /** Max wait for cross-process token file lock, ms. */
  tokenLockTimeoutMs: z.number().int().positive().default(30_000),
});

/** Strips a trailing slash so URLs concatenate predictably. */
function stripTrailingSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

function resolveTransport(): TransportMode {
  const raw = (process.env.AVITO_MCP_TRANSPORT ?? 'stdio').trim().toLowerCase();
  if (raw === 'http' || raw === 'both' || raw === 'stdio') return raw;
  return 'stdio';
}

function resolveHttpAuth(): HttpAuthMode {
  const raw = (process.env.AVITO_MCP_HTTP_AUTH ?? 'oauth').trim().toLowerCase();
  if (raw === 'oauth' || raw === 'bearer' || raw === 'none') return raw;
  return 'oauth';
}

function buildHttpConfig(): HttpConfig {
  const host = process.env.AVITO_MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const port = parsePositiveInt(process.env.AVITO_MCP_HTTP_PORT, 3000);
  const publicUrl = stripTrailingSlash(
    process.env.AVITO_MCP_HTTP_PUBLIC_URL?.trim() || `http://${host}:${port}`,
  );
  return {
    transport: resolveTransport(),
    host,
    port,
    publicUrl,
    auth: resolveHttpAuth(),
    authTokens: parseToolList(process.env.AVITO_MCP_HTTP_AUTH_TOKEN),
    allowNoAuth: parseBool(process.env.AVITO_MCP_HTTP_ALLOW_NO_AUTH),
    allowedHosts: parseToolList(process.env.AVITO_MCP_HTTP_ALLOWED_HOSTS),
    allowedOrigins: parseToolList(process.env.AVITO_MCP_HTTP_ALLOWED_ORIGINS),
    maxSessions: parsePositiveInt(process.env.AVITO_MCP_HTTP_MAX_SESSIONS, 100),
    sessionIdleSec: parsePositiveInt(process.env.AVITO_MCP_HTTP_SESSION_IDLE_SEC, 1800),
    oauthOwnerPassword: process.env.AVITO_MCP_OAUTH_OWNER_PASSWORD || undefined,
    oauthTokenTtlSec: parsePositiveInt(process.env.AVITO_MCP_OAUTH_TOKEN_TTL_SEC, 3600),
    oauthStoreFile: process.env.AVITO_MCP_OAUTH_STORE_FILE || undefined,
  };
}

function buildWebhookConfig(httpPublicUrl: string): WebhookConfig {
  const secret = process.env.AVITO_MCP_WEBHOOK_SECRET?.trim() || undefined;
  // A secret is REQUIRED for the receiver to do anything (without one every
  // request 404s), so ENABLED without a secret stays disabled — server.ts warns
  // about that combo at startup. With a secret present, the explicit flag wins:
  // AVITO_MCP_WEBHOOK_ENABLED=0 turns the receiver off without unsetting the secret.
  const rawEnabled = process.env.AVITO_MCP_WEBHOOK_ENABLED?.trim() || undefined;
  const enabled = secret !== undefined && (rawEnabled === undefined ? true : parseBool(rawEnabled));
  const publicUrl = stripTrailingSlash(
    process.env.AVITO_MCP_WEBHOOK_PUBLIC_URL?.trim() || httpPublicUrl,
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
    bufferSize: parsePositiveInt(process.env.AVITO_MCP_WEBHOOK_BUFFER, 100),
    logFile: process.env.AVITO_MCP_WEBHOOK_LOG_FILE || undefined,
  };
}

export type Config = z.infer<typeof ConfigSchema> & {
  http: HttpConfig;
  webhook: WebhookConfig;
};

function load(): Config {
  const raw = {
    clientId: process.env.Client_id ?? process.env.CLIENT_ID,
    clientSecret: process.env.Client_secret ?? process.env.CLIENT_SECRET,
    profileId: process.env.Profile_id ?? process.env.PROFILE_ID,
    baseUrl: process.env.AVITO_BASE_URL,
    tokenFile: process.env.AVITO_TOKEN_FILE,
    logLevel: process.env.LOG_LEVEL,
    mode: resolveMode(),
    allowTools: parseToolList(process.env.AVITO_MCP_ALLOW_TOOLS),
    denyTools: parseToolList(process.env.AVITO_MCP_DENY_TOOLS),
    exposeAuthTools: parseBool(process.env.AVITO_MCP_EXPOSE_AUTH_TOOLS),
    allowedUploadDirs: parseToolList(process.env.AVITO_MCP_ALLOWED_UPLOAD_DIRS),
    maxUploadMb: parsePositiveInt(process.env.AVITO_MCP_MAX_UPLOAD_MB, 15),
    confirmationMode: (process.env.AVITO_MCP_CONFIRMATION_MODE as ConfirmationMode | undefined) ?? 'money_public',
    confirmationTtlSec: parsePositiveInt(process.env.AVITO_MCP_CONFIRMATION_TTL_SEC, 900),
    confirmationSecret: process.env.AVITO_MCP_CONFIRMATION_SECRET,
    maxBinaryMb: parsePositiveInt(process.env.AVITO_MCP_MAX_BINARY_MB, 20),
    // v0.7.0 ───────────────────────────────────────────────────
    dryRunDefault: parseBool(process.env.AVITO_MCP_DRY_RUN_DEFAULT),
    idempotencyTtlSec: parsePositiveInt(process.env.AVITO_MCP_IDEMPOTENCY_TTL_SEC, 3600),
    tokenLockTimeoutMs: parsePositiveInt(process.env.AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS, 30_000),
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    process.stderr.write(
      `Invalid .env (${envFile}):\n${issues}\n\nSee .env.example for the expected format.\n`,
    );
    process.exit(1);
  }
  // v0.9.0: HTTP + webhook config are computed in JS (cross-field defaults like
  // publicUrl depending on host/port don't fit zod cleanly). They stay permissive
  // here; the hard fail-closed checks (oauth needs an owner password, none needs a
  // loopback host) run at HTTP-start time, so stdio users are never blocked.
  const http = buildHttpConfig();
  const webhook = buildWebhookConfig(http.publicUrl);
  return { ...parsed.data, http, webhook };
}

export const config = load();
