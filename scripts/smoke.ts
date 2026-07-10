/**
 * Smoke check without MCP: obtains a token and calls READ-ONLY methods only.
 * Production requires an explicit opt-in:
 *   AVITO_MCP_SMOKE_ALLOW_PRODUCTION=true npm run smoke
 *
 * DO NOT RUN WITH WRITE METHODS — this is a live (production) account.
 */
import { AvitoClient } from '../src/core/client.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

async function main() {
  const apiHost = new URL(config.baseUrl).hostname;
  const production = apiHost === 'api.avito.ru';
  const productionAllowed = ['1', 'true'].includes(
    (process.env.AVITO_MCP_SMOKE_ALLOW_PRODUCTION ?? '').trim().toLowerCase(),
  );
  if (production && !productionAllowed) {
    throw new Error(
      'Refusing to smoke-test production without AVITO_MCP_SMOKE_ALLOW_PRODUCTION=true',
    );
  }

  logger.info({ apiHost, production }, 'read-only smoke starting');
  // Smoke runs against the live account — credentials are required here (unlike the
  // MCP server itself, which since v0.7.4 starts without them for introspection).
  if (config.profileId === undefined || !config.clientId || !config.clientSecret) {
    process.stderr.write(
      'SMOKE requires credentials: set Client_id, Client_secret and Profile_id in .env.\n',
    );
    process.exit(1);
  }
  const profileId: number = config.profileId;
  const client = new AvitoClient(config);

  await runStep('GET /core/v1/accounts/self', () =>
    client.request({ method: 'GET', path: '/core/v1/accounts/self' }),
  );

  await runStep('GET /core/v1/accounts/{user_id}/balance/', () =>
    client.request({
      method: 'GET',
      path: '/core/v1/accounts/{user_id}/balance/',
      pathParams: { user_id: profileId },
    }),
  );

  await runStep('GET /core/v1/items (первые 5)', () =>
    client.request({
      method: 'GET',
      path: '/core/v1/items',
      query: { per_page: 5, page: 1 },
    }),
  );

  process.stdout.write(
    `PASS: read-only smoke completed (${client.rateLimiter.getStatus().length} rate-limit snapshots)\n`,
  );
}

async function runStep<T>(label: string, fn: () => Promise<T>) {
  await fn();
  process.stdout.write(`PASS: ${label}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSMOKE FAILED:\n${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
