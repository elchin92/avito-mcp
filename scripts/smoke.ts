/**
 * Smoke-проверка без MCP: получает токен и зовёт только READ-ONLY методы.
 * Запуск: `npm run smoke` или `npx tsx scripts/smoke.ts`.
 *
 * НЕ ЗАПУСКАТЬ С WRITE-МЕТОДАМИ — это боевой аккаунт.
 */
import { AvitoClient } from '../src/core/client.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

async function main() {
  logger.info({ profileId: config.profileId }, 'smoke starting');
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

  process.stderr.write('\n== Rate-limit snapshots ==\n');
  process.stdout.write(JSON.stringify(client.rateLimiter.getStatus(), null, 2) + '\n');
}

async function runStep<T>(label: string, fn: () => Promise<T>) {
  process.stderr.write(`\n== ${label} ==\n`);
  try {
    const res = await fn();
    process.stdout.write(JSON.stringify(res, null, 2).slice(0, 1500) + '\n');
  } catch (err) {
    process.stderr.write(`STEP FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\nSMOKE FAILED:\n${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
