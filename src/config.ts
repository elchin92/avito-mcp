import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { resolve } from 'node:path';

const envFile = process.env.AVITO_ENV_FILE ?? resolve(process.cwd(), '.env');
loadDotenv({ path: envFile, quiet: true });

const ConfigSchema = z.object({
  clientId: z.string().min(1, 'Client_id is required in .env'),
  clientSecret: z.string().min(1, 'Client_secret is required in .env'),
  profileId: z.coerce.number().int().positive('Profile_id must be a positive integer'),
  baseUrl: z.string().url().default('https://api.avito.ru'),
  tokenFile: z.string().default(resolve(process.cwd(), '.avito-token.json')),
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
