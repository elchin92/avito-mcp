/**
 * v0.9.0: unit tests for the self-hosted single-tenant OAuth 2.1 provider
 * (src/http/oauth/provider.ts, wired by src/http/oauth/index.ts).
 *
 * Covers:
 *   - DCR registerClient + getClient round-trip (client_id is minted),
 *   - the authorization-code happy path: approveConsent (correct owner password)
 *     mints a code via a 302 redirect, then exchangeAuthorizationCode returns an
 *     access + refresh token pair,
 *   - verifyAccessToken returns AuthInfo for a fresh token and THROWS for a bogus one,
 *   - exchangeRefreshToken rotates (old refresh token is then rejected),
 *   - a used auth code cannot be redeemed twice,
 *   - a wrong owner password does NOT mint a usable token.
 *
 * Modules are imported lazily inside beforeAll so a missing/renamed export gives a
 * clear failure here rather than a load crash, and so this file can be written in
 * parallel with the implementation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

import type { HttpConfig } from '../src/config.js';

type ProviderCtor = typeof import('../src/http/oauth/provider.js').AvitoOAuthProvider;
type Provider = import('../src/http/oauth/provider.js').AvitoOAuthProvider;
type OAuthClientInformationFull =
  import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull;

let AvitoOAuthProvider: ProviderCtor;
let createOAuthSubsystem:
  | typeof import('../src/http/oauth/index.js').createOAuthSubsystem
  | undefined;

const OWNER_PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  const providerMod = await import('../src/http/oauth/provider.js');
  AvitoOAuthProvider = providerMod.AvitoOAuthProvider;
  expect(typeof AvitoOAuthProvider).toBe('function');
  // index.ts is optional for these tests but exercised when present.
  try {
    const idxMod = await import('../src/http/oauth/index.js');
    createOAuthSubsystem = idxMod.createOAuthSubsystem;
  } catch {
    createOAuthSubsystem = undefined;
  }
});

function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    transport: 'http',
    host: '127.0.0.1',
    port: 8080,
    publicUrl: 'https://mcp.example.com',
    auth: 'oauth',
    authTokens: [],
    allowNoAuth: false,
    allowedHosts: [],
    allowedOrigins: [],
    oauthOwnerPassword: OWNER_PASSWORD,
    oauthTokenTtlSec: 3600,
    oauthStoreFile: undefined,
    ...overrides,
  };
}

function newProvider(overrides: Partial<HttpConfig> = {}): Provider {
  if (createOAuthSubsystem) {
    return createOAuthSubsystem(makeHttpConfig(overrides)).provider;
  }
  return new AvitoOAuthProvider(makeHttpConfig(overrides));
}

/** PKCE S256 challenge = base64url(SHA-256(verifier)). */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Registers a public PKCE client and returns the full client record. */
function registerClient(
  provider: Provider,
  redirectUri = 'https://client.example/callback',
): OAuthClientInformationFull {
  const store = provider.clientsStore;
  const reg = store.registerClient!.bind(store);
  return reg({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Test Client',
    scope: 'avito:mcp',
  } as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>);
}

/** Minimal express-ish Response capturing redirect/status/send/json/setHeader. */
interface CapturedRes {
  res: import('express').Response;
  redirects: string[];
  statusCodes: number[];
  bodies: unknown[];
}

function fakeRes(): CapturedRes {
  const redirects: string[] = [];
  const statusCodes: number[] = [];
  const bodies: unknown[] = [];
  const res = {
    redirect(...args: unknown[]) {
      // Express signature is redirect(status?, url) — url is the last arg.
      const url = args[args.length - 1];
      redirects.push(String(url));
      return res;
    },
    status(code: number) {
      statusCodes.push(code);
      return res;
    },
    send(body?: unknown) {
      bodies.push(body);
      return res;
    },
    json(body?: unknown) {
      bodies.push(body);
      return res;
    },
    setHeader() {
      return res;
    },
  } as unknown as import('express').Response;
  return { res, redirects, statusCodes, bodies };
}

/** Builds the POST /authorize/approve body for a registered client + verifier. */
function approveBody(
  client: OAuthClientInformationFull,
  codeVerifier: string,
  ownerPassword: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: s256(codeVerifier),
    state: 'xyz-state',
    scope: 'avito:mcp',
    owner_password: ownerPassword,
    ...extra,
  };
}

/** Extracts ?code= from the redirect URL produced by approveConsent. */
function extractCode(redirectUrl: string): string | null {
  const u = new URL(redirectUrl);
  return u.searchParams.get('code');
}

describe('AvitoOAuthProvider — DCR', () => {
  it('registerClient mints a client_id and getClient round-trips it', () => {
    const provider = newProvider();
    const client = registerClient(provider);
    expect(client.client_id).toBeTruthy();
    expect(client.client_id_issued_at).toBeGreaterThan(0);
    expect(client.redirect_uris).toContain('https://client.example/callback');

    const fetched = provider.clientsStore.getClient(client.client_id);
    expect(fetched).toBeDefined();
    expect(fetched!.client_id).toBe(client.client_id);
    expect(fetched!.client_name).toBe('Test Client');
  });

  it('getClient returns undefined for an unknown id', () => {
    const provider = newProvider();
    expect(provider.clientsStore.getClient('does-not-exist')).toBeUndefined();
  });
});

describe('AvitoOAuthProvider — authorization-code happy path', () => {
  it('approveConsent (correct owner password) redirects with a code, then exchange yields tokens', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, OWNER_PASSWORD) } as import('express').Request,
      cap.res,
    );

    // 302 redirect back to the client carrying code + state.
    expect(cap.redirects.length).toBe(1);
    const redirectUrl = cap.redirects[0]!;
    expect(new URL(redirectUrl).searchParams.get('state')).toBe('xyz-state');
    const code = extractCode(redirectUrl);
    expect(code).toBeTruthy();

    // The PKCE challenge stored for the code matches what we sent.
    const challenge = await provider.challengeForAuthorizationCode(client, code!);
    expect(challenge).toBe(s256(verifier));

    // Redeem the code → access + refresh tokens.
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code!,
      verifier,
      client.redirect_uris[0],
    );
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    expect(tokens.expires_in).toBe(3600);

    // The access token verifies and yields AuthInfo bound to this client.
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.token).toBe(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
    expect(info.scopes).toContain('avito:mcp');
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('an authorization code is single-use: a second exchange is rejected', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, OWNER_PASSWORD) } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;

    // First redemption succeeds.
    await provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]);
    // Second redemption of the same code must fail (single-use).
    await expect(
      provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]),
    ).rejects.toThrow();
  });

  it('exchange rejects a mismatched PKCE verifier', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, OWNER_PASSWORD) } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;

    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        randomBytes(32).toString('base64url'), // wrong verifier
        client.redirect_uris[0],
      ),
    ).rejects.toThrow();
  });
});

describe('AvitoOAuthProvider — verifyAccessToken', () => {
  it('throws for a bogus / never-issued token', async () => {
    const provider = newProvider();
    await expect(provider.verifyAccessToken('not-a-real-token')).rejects.toThrow();
  });

  it('throws for an expired token (TTL=0-ish window)', async () => {
    // Issue a token, then exercise expiry through the store by advancing time.
    const provider = newProvider({ oauthTokenTtlSec: 1 });
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');
    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, OWNER_PASSWORD) } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
    );

    // Fresh token verifies now.
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();

    // Past the 1s TTL the store treats it as expired → verify throws.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5000;
      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('AvitoOAuthProvider — refresh rotation', () => {
  it('exchangeRefreshToken rotates: old refresh token is rejected, new one works', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');
    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, OWNER_PASSWORD) } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const first = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
    );
    expect(first.refresh_token).toBeTruthy();

    // Rotate.
    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
    expect(second.access_token).toBeTruthy();
    expect(second.refresh_token).toBeTruthy();
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The new access token verifies.
    await expect(provider.verifyAccessToken(second.access_token)).resolves.toBeTruthy();

    // The OLD refresh token is now invalid (rotated out).
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow();

    // The NEW refresh token still works.
    const third = await provider.exchangeRefreshToken(client, second.refresh_token!);
    expect(third.access_token).toBeTruthy();
  });

  it('refresh cannot widen scopes beyond the original grant', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');
    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, OWNER_PASSWORD) } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const first = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
    );
    await expect(
      provider.exchangeRefreshToken(client, first.refresh_token!, ['avito:mcp', 'extra:scope']),
    ).rejects.toThrow();
  });
});

describe('AvitoOAuthProvider — wrong owner password', () => {
  it('does NOT mint a code (no redirect, no usable token)', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, 'wrong-password') } as import('express').Request,
      cap.res,
    );

    // No redirect (the form is re-rendered with a 401 instead).
    expect(cap.redirects.length).toBe(0);
    expect(cap.statusCodes).toContain(401);

    // challengeForAuthorizationCode for a bogus code throws (no code was minted).
    await expect(
      provider.challengeForAuthorizationCode(client, 'some-bogus-code'),
    ).rejects.toThrow();
  });

  it('fails closed when no owner password is configured', async () => {
    const provider = newProvider({ oauthOwnerPassword: undefined });
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      { body: approveBody(client, verifier, '') } as import('express').Request,
      cap.res,
    );
    // Misconfiguration → server_error (500), never a redirect/code.
    expect(cap.redirects.length).toBe(0);
    expect(cap.statusCodes).toContain(500);
  });
});
