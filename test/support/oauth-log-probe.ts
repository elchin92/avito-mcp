/**
 * M5.6 — a child process that runs one complete OAuth flow with the logger at
 * its most talkative level, so the suite can assert on the REAL stderr stream.
 *
 * It has to be a separate process for two reasons. `logger` is a module-level
 * pino instance bound to `pino.destination(2)`, which writes with `writeSync`
 * on the file descriptor and never passes through `process.stderr.write`, so an
 * in-process spy sees nothing. And `LOG_LEVEL` is read once at import, so the
 * only way to observe `debug` output is a process that started with it set.
 *
 * Every secret the flow produces is printed to STDOUT as JSON. The parent then
 * greps STDERR for those exact values. Not a redaction-list test — a test that
 * the values are absent however they might have got there.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';

import { createOAuthSubsystem } from '../../src/http/oauth/index.js';
import type { HttpConfig } from '../../src/config.js';

const OWNER_PASSWORD = 'log-probe-owner-password-strong-enough';
const PUBLIC_URL = 'https://mcp.example.com';
const REDIRECT_URI = 'https://client.example/callback';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const httpConfig: HttpConfig = {
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
  publicUrl: PUBLIC_URL,
  auth: 'oauth',
  authTokens: [],
  allowNoAuth: false,
  allowedHosts: [],
  allowedOrigins: [],
  maxSessions: 100,
  sessionIdleSec: 1800,
  maxInflight: 64,
  maxStreams: 32,
  oauthOwnerPassword: OWNER_PASSWORD,
  oauthTokenTtlSec: 3600,
  oauthStoreFile: undefined,
};

async function main(): Promise<void> {
  const subsystem = createOAuthSubsystem(httpConfig);
  const app = express();
  app.use(subsystem.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const registration = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Log Probe Client',
        scope: 'avito:mcp',
      }),
    });
    const client = (await registration.json()) as { client_id: string; client_secret: string };

    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/authorize`);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: 'avito:mcp',
      resource: `${PUBLIC_URL}/mcp`,
      state: 'log-probe-state',
    })) {
      authorize.searchParams.set(key, value);
    }
    const consentPage = await fetch(authorize);
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(await consentPage.text())![1]!;

    const approval = await fetch(`${base}/authorize/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        consent_token: consentToken,
        owner_password: OWNER_PASSWORD,
      }),
    });
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;

    const tokenResponse = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: `${PUBLIC_URL}/mcp`,
      }),
    });
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };

    // Exercise the failure paths too: a wrong owner password, an unknown bearer
    // token and a replayed refresh token are the three places most likely to
    // "helpfully" log the value that failed.
    // A fresh transaction: the one above was consumed by the successful
    // approval, and a spent consent token never reaches the password check.
    const secondPage = await fetch(authorize);
    const secondConsent = /name="consent_token" value="([^"]+)"/.exec(await secondPage.text())![1]!;
    await fetch(`${base}/authorize/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        consent_token: secondConsent,
        owner_password: 'log-probe-wrong-password-canary',
      }),
    });
    await subsystem.provider.verifyAccessToken('log-probe-unknown-token-canary').catch(() => {});

    const refresh = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
      resource: `${PUBLIC_URL}/mcp`,
    });
    const rotated = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refresh,
    });
    const rotatedTokens = (await rotated.json()) as {
      access_token: string;
      refresh_token: string;
    };
    // Replay of the now-consumed refresh token.
    await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refresh,
    });

    process.stdout.write(
      JSON.stringify({
        secrets: {
          client_secret: client.client_secret,
          consent_token: consentToken,
          second_consent_token: secondConsent,
          owner_password: OWNER_PASSWORD,
          code,
          code_verifier: verifier,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          rotated_access_token: rotatedTokens.access_token,
          rotated_refresh_token: rotatedTokens.refresh_token,
          wrong_password: 'log-probe-wrong-password-canary',
          unknown_token: 'log-probe-unknown-token-canary',
        },
        clientId: client.client_id,
      }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await subsystem.close();
  }
}

await main();
