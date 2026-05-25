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
  clientId: z.string().min(1, 'Client_id is required in .env'),
  clientSecret: z.string().min(1, 'Client_secret is required in .env'),
  profileId: z.coerce.number().int().positive('Profile_id must be a positive integer'),
  baseUrl: z.string().url().default('https://api.avito.ru'),
  tokenFile: z.string().default(defaultTokenFile()),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  mode: z.enum(['read_only', 'guarded', 'full_access']).default('full_access'),
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([]),
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
