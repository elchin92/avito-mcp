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

function parseBool(raw: string | undefined, fallback = false): boolean {
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

export type Config = z.infer<typeof ConfigSchema>;

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
  return parsed.data;
}

export const config = load();
