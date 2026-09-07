import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs real stdio calls against fictional data while ignoring live environment configuration', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../src/server.ts', import.meta.url)),
      '--demo',
      '--json',
    ],
    {
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        // Each of these would fail startup or make a real call if demo inherited it.
        AVITO_ENV_FILE: '/does-not-exist/demo.env',
        AVITO_MCP_TRANSPORT: 'invalid',
        AVITO_MCP_PROTOCOL_ERA: 'invalid',
        AVITO_BASE_URL: 'https://must-never-be-contacted.invalid',
        Client_id: 'do-not-use',
        Client_secret: 'do-not-use',
      },
    },
  );
  expect(JSON.parse(stdout)).toEqual({
    fixture: true,
    externalNetwork: false,
    tools: 7,
    balanceRubles: 5000,
    activeListings: 53,
    listingPages: 2,
    unreadChats: 2,
    dryRunMutations: 0,
    beforeConfirmationMutations: 0,
    confirmedMutations: 1,
    idempotentReplay: true,
  });
}, 35_000);
