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

const ConfigSchema = z.object({
  clientId: z.string().min(1, 'Client_id is required in .env'),
  clientSecret: z.string().min(1, 'Client_secret is required in .env'),
  profileId: z.coerce.number().int().positive('Profile_id must be a positive integer'),
  baseUrl: z.string().url().default('https://api.avito.ru'),
  tokenFile: z.string().default(defaultTokenFile()),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
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
