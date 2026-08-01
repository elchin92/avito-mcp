/**
 * M5 — the authorization requirements of revision 2026-07-28, asserted over a
 * real HTTP listener rather than against the provider object.
 *
 * Everything here is a claim a client can actually observe on the wire:
 *
 *  • M5.1 — RFC 9207: `iss` is present on every authorization response, success
 *    and error alike, and is BYTE-identical to the `issuer` of the metadata
 *    document. `publicUrl` is one byte away from that value and comparing
 *    against it is exactly the mistake this suite exists to catch.
 *  • M5.6 — the security invariants that hold today and would break the auth
 *    contour silently if they regressed: no `offline_access`, refresh rotation,
 *    no token passthrough to Avito, PKCE S256 only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { createOAuthSubsystem } from '../src/http/oauth/index.js';
import type { HttpConfig } from '../src/config.js';

const OWNER_PASSWORD = 'oauth-conformance-owner-password';
const REDIRECT_URI = 'https://client.example/callback';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://mcp.example.com',
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
    ...overrides,
  };
}

interface Rig {
  base: string;
  close(): Promise<void>;
}

/** Mounts just the OAuth router (no /mcp) on an ephemeral loopback port. */
async function startOAuthRig(overrides: Partial<HttpConfig> = {}): Promise<Rig> {
  const express = (await import('express')).default;
  const subsystem = createOAuthSubsystem(makeHttpConfig(overrides));
  const app = express();
  app.use(subsystem.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await subsystem.close();
    },
  };
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

interface RegisteredClient {
  client_id: string;
}

async function register(base: string): Promise<RegisteredClient> {
  const response = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Conformance Client',
      scope: 'avito:mcp',
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as RegisteredClient;
}

function authorizeUrl(
  base: string,
  clientId: string,
  verifier: string,
  overrides: Record<string, string> = {},
): URL {
  const url = new URL(`${base}/authorize`);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
    scope: 'avito:mcp',
    resource: 'https://mcp.example.com/mcp',
    state: 'conformance-state',
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function consentTokenFor(base: string, clientId: string, verifier: string): Promise<string> {
  const page = await fetch(authorizeUrl(base, clientId, verifier));
  expect(page.status).toBe(200);
  const token = /name="consent_token" value="([^"]+)"/.exec(await page.text())?.[1];
  expect(token).toBeTruthy();
  return token!;
}

async function approve(base: string, consentToken: string): Promise<Response> {
  return fetch(`${base}/authorize/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consent_token: consentToken, owner_password: OWNER_PASSWORD }),
  });
}

async function metadata(base: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('M5.1 — RFC 9207 issuer identification', () => {
  it('stamps iss on the success redirect, byte-identical to the advertised issuer', async () => {
    rig = await startOAuthRig();
    const meta = await metadata(rig.base);
    const client = await register(rig.base);
    const verifier = randomBytes(32).toString('base64url');

    const approval = await approve(
      rig.base,
      await consentTokenFor(rig.base, client.client_id, verifier),
    );
    expect(approval.status).toBe(302);
    const redirect = new URL(approval.headers.get('location')!);

    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(redirect.searchParams.get('state')).toBe('conformance-state');
    // The load-bearing assertion: simple string comparison, the only one RFC 9207
    // §2.4 permits the client. No normalisation on either side.
    expect(redirect.searchParams.get('iss')).toBe(meta.issuer);
    // …and the trap that makes it load-bearing: `publicUrl` is NOT the issuer.
    expect(meta.issuer).toBe('https://mcp.example.com/');
    expect(meta.issuer).not.toBe('https://mcp.example.com');
  });

  it('stamps iss on the SDK error redirect too', async () => {
    rig = await startOAuthRig();
    const meta = await metadata(rig.base);
    const client = await register(rig.base);
    const verifier = randomBytes(32).toString('base64url');

    // An unsupported scope is rejected inside authorize(), which the SDK turns
    // into an error redirect to the (already validated) redirect_uri.
    const response = await fetch(
      authorizeUrl(rig.base, client.client_id, verifier, { scope: 'avito:mcp offline_access' }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.searchParams.get('error')).toBe('invalid_scope');
    expect(redirect.searchParams.get('iss')).toBe(meta.issuer);
  });

  it('advertises the parameter only because the redirect actually carries it (M5.2)', async () => {
    rig = await startOAuthRig();
    const meta = await metadata(rig.base);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    // The ordering rule, expressed as a test rather than as a comment: the claim
    // above is allowed to be true only while the redirect below carries `iss`.
    // Removing the emission without first retracting the claim leaves the pair
    // in the state that obliges a conformant client to reject a valid response,
    // and this assertion is what stops that landing.
    const client = await register(rig.base);
    const verifier = randomBytes(32).toString('base64url');
    const approval = await approve(
      rig.base,
      await consentTokenFor(rig.base, client.client_id, verifier),
    );
    expect(new URL(approval.headers.get('location')!).searchParams.get('iss')).toBe(meta.issuer);
  });

  it('keeps the explicit port and the trailing slash that a client compares byte-wise', async () => {
    rig = await startOAuthRig({ publicUrl: 'https://mcp.example.com:8443' });
    const meta = await metadata(rig.base);
    expect(meta.issuer).toBe('https://mcp.example.com:8443/');

    const client = await register(rig.base);
    const verifier = randomBytes(32).toString('base64url');
    const page = await fetch(
      authorizeUrl(rig.base, client.client_id, verifier, {
        resource: 'https://mcp.example.com:8443/mcp',
      }),
    );
    expect(page.status).toBe(200);
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(await page.text())?.[1];
    const approval = await approve(rig.base, consentToken!);
    expect(approval.status).toBe(302);
    expect(new URL(approval.headers.get('location')!).searchParams.get('iss')).toBe(meta.issuer);
  });
});

describe('M5.6 — regression guards on the authorization contour', () => {
  it('never publishes offline_access and offers S256 only', async () => {
    rig = await startOAuthRig();
    const meta = await metadata(rig.base);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.scopes_supported).toEqual(['avito:mcp']);
    expect(JSON.stringify(meta)).not.toContain('offline_access');

    const prm = await fetch(`${rig.base}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as Record<string, unknown>;
    expect(prmBody.scopes_supported).toEqual(['avito:mcp']);
    expect(JSON.stringify(prmBody)).not.toContain('offline_access');
  });

  it('rotates a public client refresh token and answers invalid_grant on reuse', async () => {
    rig = await startOAuthRig();
    const client = await register(rig.base);
    const verifier = randomBytes(32).toString('base64url');
    const approval = await approve(
      rig.base,
      await consentTokenFor(rig.base, client.client_id, verifier),
    );
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;

    const first = await fetch(`${rig.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        resource: 'https://mcp.example.com/mcp',
      }),
    });
    expect(first.status).toBe(200);
    const grant = (await first.json()) as { refresh_token: string; scope: string };
    expect(grant.scope).toBe('avito:mcp');
    expect(grant.refresh_token).toBeTruthy();

    const refreshBody = () =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: grant.refresh_token,
        client_id: client.client_id,
        resource: 'https://mcp.example.com/mcp',
      });
    const rotated = await fetch(`${rig.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshBody(),
    });
    expect(rotated.status).toBe(200);
    const rotatedGrant = (await rotated.json()) as { refresh_token: string };
    expect(rotatedGrant.refresh_token).not.toBe(grant.refresh_token);

    const replay = await fetch(`${rig.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshBody(),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('M5.6 — no secret from the flow reaches the log stream', () => {
  it('keeps every code, verifier, secret and token out of stderr at debug level', () => {
    // `logger` binds pino to fd 2 with writeSync and reads LOG_LEVEL once at
    // import, so this is only observable from a process that started noisy.
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'test/support/oauth-log-probe.ts'],
      {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AVITO_ENV_FILE: '/dev/null',
          LOG_LEVEL: 'debug',
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout) as {
      secrets: Record<string, string>;
      clientId: string;
    };

    // The probe really did run and really did log: without this the assertions
    // below would pass just as happily against an empty stream.
    expect(result.stderr).toContain('oauth: registered client (DCR)');
    expect(result.stderr).toContain('oauth: owner password mismatch');
    expect(result.stderr).toContain(probe.clientId);

    const leaked = Object.entries(probe.secrets).filter(
      ([, value]) => value.length > 0 && result.stderr.includes(value),
    );
    expect(leaked.map(([name]) => name)).toEqual([]);
  });
});

/**
 * MUST NOT token passthrough (spec-security). The Avito client is the ONE place
 * that builds an outbound request to api.avito.ru, and the only Authorization
 * header it may ever set is the one minted from this deployment's own Avito
 * credentials. A guard on the text would be defeated by a rename, so this walks
 * the AST and looks for the two shapes that would actually forward a caller's
 * bearer token: any `…authInfo…` access, and any read of the inbound
 * `headers.authorization`.
 */
describe('M5.6 — no caller token ever reaches the Avito client', () => {
  const OUTBOUND_FILES = [
    'src/core/client.ts',
    'src/core/tool-factory.ts',
    'src/core/token-store.ts',
  ];

  it('never mentions authInfo or an inbound Authorization header in outbound code', () => {
    const offenders: string[] = [];
    for (const relative of OUTBOUND_FILES) {
      const path = join(import.meta.dirname, '..', relative);
      const source = ts.createSourceFile(
        relative,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.ESNext,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) {
          const name = node.name.text;
          if (name === 'authInfo') {
            offenders.push(`${relative}: reads .authInfo`);
          }
          if (
            (name === 'authorization' || name === 'Authorization') &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'headers'
          ) {
            offenders.push(`${relative}: reads headers.${name}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(source, visit);
    }
    expect(offenders).toEqual([]);
  });
});
