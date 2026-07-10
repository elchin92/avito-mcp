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
import {
  lstatSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HttpConfig } from '../src/config.js';

type ProviderCtor = typeof import('../src/http/oauth/provider.js').AvitoOAuthProvider;
type Provider = import('../src/http/oauth/provider.js').AvitoOAuthProvider;
type OAuthClientInformationFull =
  import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationFull;

let AvitoOAuthProvider: ProviderCtor;
let createOAuthSubsystem:
  typeof import('../src/http/oauth/index.js').createOAuthSubsystem | undefined;

const OWNER_PASSWORD = 'correct-horse-battery-staple';
const RESOURCE = new URL('https://mcp.example.com/mcp');

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
    maxSessions: 100,
    sessionIdleSec: 1800,
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
type SynchronousClientsStore = {
  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull;
  getClient(clientId: string): OAuthClientInformationFull | undefined;
};

function synchronousClientsStore(provider: Provider): SynchronousClientsStore {
  // AvitoOAuthProvider deliberately implements an in-process synchronous store.
  // The SDK interface is wider and also permits Promise-returning adapters.
  return provider.clientsStore as SynchronousClientsStore;
}

function registerClient(
  provider: Provider,
  redirectUri = 'https://client.example/callback',
): OAuthClientInformationFull {
  const store = synchronousClientsStore(provider);
  const reg = store.registerClient.bind(store);
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
  headers: Map<string, string>;
}

function fakeRes(): CapturedRes {
  const redirects: string[] = [];
  const statusCodes: number[] = [];
  const bodies: unknown[] = [];
  const headers = new Map<string, string>();
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
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
  } as unknown as import('express').Response;
  return { res, redirects, statusCodes, bodies, headers };
}

/** Starts consent and builds the minimal transaction-bound approval body. */
async function approveBody(
  provider: Provider,
  client: OAuthClientInformationFull,
  codeVerifier: string,
  ownerPassword: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const cap = fakeRes();
  const redirectUri =
    typeof extra.redirect_uri === 'string' ? extra.redirect_uri : client.redirect_uris[0]!;
  const scopes =
    typeof extra.scope === 'string' ? extra.scope.split(' ').filter(Boolean) : ['avito:mcp'];
  const resource = typeof extra.resource === 'string' ? new URL(extra.resource) : RESOURCE;
  await provider.authorize(
    client,
    {
      redirectUri,
      codeChallenge: s256(codeVerifier),
      state: 'xyz-state',
      scopes,
      resource,
    },
    cap.res,
  );
  const html = String(cap.bodies.at(-1) ?? '');
  const token = /name="consent_token" value="([^"]+)"/.exec(html)?.[1];
  expect(token).toBeTruthy();
  return {
    consent_token: token,
    owner_password: ownerPassword,
  };
}

/** Extracts ?code= from the redirect URL produced by approveConsent. */
function extractCode(redirectUrl: string): string | null {
  const u = new URL(redirectUrl);
  return u.searchParams.get('code');
}

async function issueGrant(
  provider: Provider,
  client: OAuthClientInformationFull,
): Promise<import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens> {
  const verifier = randomBytes(32).toString('base64url');
  const cap = fakeRes();
  await provider.approveConsent(
    {
      body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
    } as import('express').Request,
    cap.res,
  );
  const code = extractCode(cap.redirects[0]!)!;
  return provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    RESOURCE,
  );
}

describe('AvitoOAuthProvider — DCR', () => {
  it('registerClient mints a client_id and getClient round-trips it', () => {
    const provider = newProvider();
    const client = registerClient(provider);
    expect(client.client_id).toBeTruthy();
    expect(client.client_id_issued_at).toBeGreaterThan(0);
    expect(client.redirect_uris).toContain('https://client.example/callback');

    const fetched = synchronousClientsStore(provider).getClient(client.client_id);
    expect(fetched).toBeDefined();
    expect(fetched!.client_id).toBe(client.client_id);
    expect(fetched!.client_name).toBe('Test Client');
  });

  it('getClient returns undefined for an unknown id', () => {
    const provider = newProvider();
    expect(synchronousClientsStore(provider).getClient('does-not-exist')).toBeUndefined();
  });

  it('rejects persistable software statements and oversized metadata', () => {
    const provider = newProvider();
    const register = provider.clientsStore.registerClient!.bind(provider.clientsStore);
    const base = {
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'avito:mcp',
    } as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>;
    expect(() => register({ ...base, software_statement: 'unsigned-statement' })).toThrow(
      /software_statement/i,
    );
    expect(() => register({ ...base, client_name: 'x'.repeat(129) })).toThrow(/client_name/i);
  });

  it('normalizes the omitted token auth method and rejects unsupported methods', () => {
    const provider = newProvider();
    const clientStore = synchronousClientsStore(provider);
    const register = clientStore.registerClient.bind(clientStore);
    const base = {
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'avito:mcp',
    } as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>;

    const confidential = register(base);
    expect(confidential.token_endpoint_auth_method).toBe('client_secret_post');
    expect(confidential.client_secret).toBeTruthy();
    expect(() => register({ ...base, token_endpoint_auth_method: 'client_secret_basic' })).toThrow(
      /token_endpoint_auth_method/i,
    );
    expect(() => register({ ...base, token_endpoint_auth_method: 'private_key_jwt' })).toThrow(
      /token_endpoint_auth_method/i,
    );
  });

  it('evicts the oldest inactive DCR client instead of wedging at capacity', async () => {
    const { OAuthStore, OAUTH_MAX_CLIENTS } = await import('../src/http/oauth/store.js');
    const store = new OAuthStore();
    const issuedAt = Math.floor(Date.now() / 1000);
    const makeClient = (clientId: string): OAuthClientInformationFull => ({
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    });
    for (let index = 0; index < OAUTH_MAX_CLIENTS; index += 1) {
      store.putClient(makeClient(`inactive-${index}`));
    }
    store.putClient(makeClient('replacement'));

    expect(store.getClient('inactive-0')).toBeUndefined();
    expect(store.getClient('replacement')).toBeTruthy();
    await store.close();
  });
});

describe('AvitoOAuthProvider — authorization-code happy path', () => {
  it('approveConsent (correct owner password) redirects with a code, then exchange yields tokens', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
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
      RESOURCE,
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
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;

    // First redemption succeeds.
    await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      RESOURCE,
    );
    // Second redemption of the same code must fail (single-use).
    await expect(
      provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], RESOURCE),
    ).rejects.toThrow();
  });

  it('exchange rejects a mismatched PKCE verifier', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;

    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        randomBytes(32).toString('base64url'), // wrong verifier
        client.redirect_uris[0],
        RESOURCE,
      ),
    ).rejects.toThrow();
  });
});

describe('AvitoOAuthProvider — authorization boundary', () => {
  it('renders redirect/resource/client details with anti-clickjacking headers and no trusted hidden fields', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const cap = fakeRes();
    await provider.authorize(
      client,
      {
        redirectUri: client.redirect_uris[0]!,
        codeChallenge: s256(randomBytes(32).toString('base64url')),
        state: 'state-is-server-side',
        scopes: ['avito:mcp'],
        resource: RESOURCE,
      },
      cap.res,
    );

    const html = String(cap.bodies[0]);
    expect(html).toContain('https://client.example/callback');
    expect(html).toContain('https://mcp.example.com/mcp');
    expect(html).toContain(client.client_id);
    expect(html).toContain('Dynamically registered client');
    expect(html).toContain('name="consent_token"');
    expect(html).not.toContain('name="redirect_uri"');
    expect(html).not.toContain('name="code_challenge"');
    expect(cap.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(cap.headers.get('x-frame-options')).toBe('DENY');
    expect(cap.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('allows a consent transaction to mint at most one authorization code', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const body = await approveBody(
      provider,
      client,
      randomBytes(32).toString('base64url'),
      OWNER_PASSWORD,
    );
    const first = fakeRes();
    const replay = fakeRes();
    await provider.approveConsent({ body } as import('express').Request, first.res);
    await provider.approveConsent({ body } as import('express').Request, replay.res);
    expect(first.redirects).toHaveLength(1);
    expect(replay.redirects).toHaveLength(0);
    expect(replay.statusCodes).toContain(400);
  });

  it('rejects unknown scopes and a missing or cross-resource indicator', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const base = {
      redirectUri: client.redirect_uris[0]!,
      codeChallenge: s256(randomBytes(32).toString('base64url')),
      state: 's',
    };
    await expect(
      provider.authorize(
        client,
        { ...base, scopes: ['bogus:scope'], resource: RESOURCE },
        fakeRes().res,
      ),
    ).rejects.toThrow(/scope/i);
    await expect(
      provider.authorize(client, { ...base, scopes: ['avito:mcp'] }, fakeRes().res),
    ).rejects.toThrow(/resource/i);
    await expect(
      provider.authorize(
        client,
        {
          ...base,
          scopes: ['avito:mcp'],
          resource: new URL('https://other.example/mcp'),
        },
        fakeRes().res,
      ),
    ).rejects.toThrow(/resource/i);
  });

  it('requires the exact resource again at the token endpoint', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');
    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    await expect(
      provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]),
    ).rejects.toThrow(/resource/i);
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
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      RESOURCE,
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
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const first = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      RESOURCE,
    );
    expect(first.refresh_token).toBeTruthy();

    // Rotate.
    const second = await provider.exchangeRefreshToken(
      client,
      first.refresh_token!,
      undefined,
      RESOURCE,
    );
    expect(second.access_token).toBeTruthy();
    expect(second.refresh_token).toBeTruthy();
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The new access token verifies.
    await expect(provider.verifyAccessToken(second.access_token)).resolves.toBeTruthy();

    // The OLD refresh token is now invalid (rotated out).
    await expect(
      provider.exchangeRefreshToken(client, first.refresh_token!, undefined, RESOURCE),
    ).rejects.toThrow();

    // The NEW refresh token still works.
    const third = await provider.exchangeRefreshToken(
      client,
      second.refresh_token!,
      undefined,
      RESOURCE,
    );
    expect(third.access_token).toBeTruthy();
  });

  it('refresh cannot widen scopes beyond the original grant', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');
    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const first = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      RESOURCE,
    );
    await expect(
      provider.exchangeRefreshToken(
        client,
        first.refresh_token!,
        ['avito:mcp', 'extra:scope'],
        RESOURCE,
      ),
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
      {
        body: await approveBody(provider, client, verifier, 'wrong-password'),
      } as import('express').Request,
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
      { body: await approveBody(provider, client, verifier, '') } as import('express').Request,
      cap.res,
    );
    // Misconfiguration → server_error (500), never a redirect/code.
    expect(cap.redirects.length).toBe(0);
    expect(cap.statusCodes).toContain(500);
  });
});

describe('AvitoOAuthProvider — RFC 8252 loopback redirect_uri (v0.9.1)', () => {
  it('approveConsent accepts a loopback redirect on a different (ephemeral) port', async () => {
    // Native clients register http://127.0.0.1:<port>/callback but authorize from
    // whatever ephemeral port they bound at runtime — RFC 8252 §7.3 requires the
    // AS to accept the port variance, and the SDK's GET /authorize already does.
    const provider = newProvider();
    const client = registerClient(provider, 'http://127.0.0.1:8765/callback');
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD, {
          redirect_uri: 'http://127.0.0.1:49152/callback',
        }),
      } as import('express').Request,
      cap.res,
    );

    expect(cap.redirects.length).toBe(1);
    expect(cap.redirects[0]).toContain('http://127.0.0.1:49152/callback');
    expect(extractCode(cap.redirects[0]!)).toBeTruthy();
  });

  it('still rejects a redirect_uri mismatch on a non-loopback host', async () => {
    const provider = newProvider();
    const client = registerClient(provider, 'https://client.example/callback');
    const verifier = randomBytes(32).toString('base64url');

    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD, {
          redirect_uri: 'https://evil.example/callback',
        }),
      } as import('express').Request,
      cap.res,
    );

    expect(cap.redirects.length).toBe(0);
    expect(cap.statusCodes).toContain(400);
  });
});

describe('AvitoOAuthProvider — revocation ownership and token families', () => {
  it('ignores a foreign client and revokes both tokens for the owning client', async () => {
    const provider = newProvider();
    const owner = registerClient(provider, 'https://owner.example/callback');
    const foreign = registerClient(provider, 'https://foreign.example/callback');
    const tokens = await issueGrant(provider, owner);

    await provider.revokeToken(foreign, {
      token: tokens.refresh_token!,
      token_type_hint: 'refresh_token',
    });
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();

    await provider.revokeToken(owner, {
      token: tokens.refresh_token!,
      token_type_hint: 'refresh_token',
    });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(
      provider.exchangeRefreshToken(owner, tokens.refresh_token!, undefined, RESOURCE),
    ).rejects.toThrow();
  });

  it('revoking an access token also removes its paired refresh token', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const tokens = await issueGrant(provider, client);
    await provider.revokeToken(client, {
      token: tokens.access_token,
      token_type_hint: 'access_token',
    });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!, undefined, RESOURCE),
    ).rejects.toThrow();
  });
});

describe('AvitoOAuthProvider — token housekeeping (v0.9.1)', () => {
  it('refresh rotation revokes the paired old access token', async () => {
    const provider = newProvider();
    const client = registerClient(provider);
    const verifier = randomBytes(32).toString('base64url');
    const cap = fakeRes();
    await provider.approveConsent(
      {
        body: await approveBody(provider, client, verifier, OWNER_PASSWORD),
      } as import('express').Request,
      cap.res,
    );
    const code = extractCode(cap.redirects[0]!)!;
    const first = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      RESOURCE,
    );
    await expect(provider.verifyAccessToken(first.access_token)).resolves.toBeTruthy();

    const second = await provider.exchangeRefreshToken(
      client,
      first.refresh_token!,
      undefined,
      RESOURCE,
    );

    // The abandoned access token must be gone (the client never presents it
    // again, so lazy expiry would never collect it).
    await expect(provider.verifyAccessToken(first.access_token)).rejects.toThrow();
    await expect(provider.verifyAccessToken(second.access_token)).resolves.toBeTruthy();
  });

  it('sweepExpired drops expired tokens (and keeps live ones)', async () => {
    const { OAuthStore } = await import('../src/http/oauth/store.js');
    const store = new OAuthStore();
    try {
      const dead1 = store.createAccessToken({
        clientId: 'c',
        scopes: [],
        expiresAt: Date.now() - 1000,
      });
      const dead2 = store.createRefreshToken({
        clientId: 'c',
        scopes: [],
        expiresAt: Date.now() - 1000,
      });
      const live = store.createAccessToken({
        clientId: 'c',
        scopes: [],
        expiresAt: Date.now() + 60_000,
      });

      const removed = store.sweepExpired();
      expect(removed).toBe(2);
      expect(store.getAccessToken(live)).toBeTruthy();
      expect(store.getAccessToken(dead1)).toBeUndefined();
      expect(store.getRefreshToken(dead2)).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('expires day-old inactive clients but keeps clients with live artifacts', async () => {
    const { OAuthStore } = await import('../src/http/oauth/store.js');
    const store = new OAuthStore();
    const issuedAt = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000);
    const client = (clientId: string): OAuthClientInformationFull => ({
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    });
    try {
      store.putClient(client('inactive'));
      store.putClient(client('active'));
      store.createAccessToken({
        clientId: 'active',
        scopes: ['avito:mcp'],
        resource: RESOURCE.href,
        expiresAt: Date.now() + 60_000,
      });

      expect(store.getClient('inactive')).toBeUndefined();
      expect(store.getClient('active')).toBeTruthy();
    } finally {
      await store.close();
    }
  });
});

describe('OAuthStore — durable serialized shutdown', () => {
  it('awaits the latest snapshot, prevents a second owner and releases the lease', async () => {
    const root = join(tmpdir(), `avito-oauth-durable-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'nested', 'oauth.json');
    const first = newProvider({ oauthStoreFile: storeFile });
    let second: Provider | undefined;
    try {
      const client = registerClient(first);
      const tokens = await issueGrant(first, client);

      expect(() => newProvider({ oauthStoreFile: storeFile })).toThrow(/already owned/i);
      await first.close();
      await expect(fs.access(`${storeFile}.process.lock`)).rejects.toThrow();

      const snapshot = JSON.parse(await fs.readFile(storeFile, 'utf8')) as {
        clients: Record<string, unknown>;
        accessTokens: Record<string, unknown>;
        refreshTokens: Record<string, unknown>;
      };
      expect(snapshot.clients[client.client_id]).toBeTruthy();
      expect(snapshot.accessTokens[tokens.access_token]).toBeTruthy();
      expect(snapshot.refreshTokens[tokens.refresh_token!]).toBeTruthy();
      if (process.platform !== 'win32') {
        expect((await fs.stat(storeFile)).mode & 0o077).toBe(0);
      }

      second = newProvider({ oauthStoreFile: storeFile });
      expect(synchronousClientsStore(second).getClient(client.client_id)).toBeTruthy();
      await expect(second.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();
    } finally {
      await first.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cannot resurrect a revoked token after restart', async () => {
    const root = join(tmpdir(), `avito-oauth-revoke-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    const first = newProvider({ oauthStoreFile: storeFile });
    let second: Provider | undefined;
    try {
      const client = registerClient(first);
      const tokens = await issueGrant(first, client);
      await first.revokeToken(client, { token: tokens.refresh_token! });
      await first.close();

      second = newProvider({ oauthStoreFile: storeFile });
      await expect(second.verifyAccessToken(tokens.access_token)).rejects.toThrow();
      await expect(
        second.exchangeRefreshToken(client, tokens.refresh_token!, undefined, RESOURCE),
      ).rejects.toThrow();
    } finally {
      await first.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails startup on a corrupt persistent snapshot and does not leak its lease', async () => {
    const root = join(tmpdir(), `avito-oauth-corrupt-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(storeFile, '{not valid json', 'utf8');
      expect(() => newProvider({ oauthStoreFile: storeFile })).toThrow(/parse OAuth store/i);
      await expect(fs.access(`${storeFile}.process.lock`)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('treats a fresh incomplete lease as live instead of deleting it', async () => {
    const root = join(tmpdir(), `avito-oauth-fresh-lease-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    const leasePath = `${storeFile}.process.lock`;
    try {
      await fs.mkdir(leasePath, { recursive: true });
      expect(() => newProvider({ oauthStoreFile: storeFile })).toThrow(/being initialized/i);
      expect((await fs.stat(leasePath)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not remove a lease whose ownership marker changed', async () => {
    const root = join(tmpdir(), `avito-oauth-lease-owner-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    const provider = newProvider({ oauthStoreFile: storeFile });
    const leasePath = `${storeFile}.process.lock`;
    try {
      const ownerMarker = (await fs.readdir(leasePath)).find((name) => name.startsWith('owner-'));
      expect(ownerMarker).toBeTruthy();
      await fs.writeFile(
        join(leasePath, ownerMarker!),
        JSON.stringify({ pid: process.pid, id: 'replacement-owner' }),
        'utf8',
      );
      await provider.close();
      await expect(fs.access(leasePath)).resolves.toBeUndefined();
    } finally {
      await provider.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not let a delayed stale cleaner remove a replacement lease', async () => {
    const { OAuthStore } = await import('../src/http/oauth/store.js');
    const root = join(tmpdir(), `avito-oauth-lease-cleaner-race-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    const leasePath = `${storeFile}.process.lock`;
    const prototype = OAuthStore.prototype as unknown as {
      beforeLeaseTransition: (reason: 'reclaim' | 'release', leasePath: string) => void;
    };
    const originalHook = prototype.beforeLeaseTransition;
    let replacement: InstanceType<typeof OAuthStore> | undefined;
    try {
      mkdirSync(leasePath, { recursive: true });
      await fs.writeFile(
        join(leasePath, 'owner-stale-generation.json'),
        JSON.stringify({ pid: 2_147_483_647, id: 'stale-generation' }),
        'utf8',
      );
      let intercepted = false;
      prototype.beforeLeaseTransition = (reason, observedPath) => {
        if (reason !== 'reclaim' || intercepted) return;
        intercepted = true;
        prototype.beforeLeaseTransition = originalHook;
        replacement = new OAuthStore(storeFile);
        expect(observedPath).toBe(leasePath);
      };

      expect(() => new OAuthStore(storeFile)).toThrow(/already owned/i);
      expect(intercepted).toBe(true);
      expect(replacement?.isReady()).toBe(true);
      const replacementMarker = readdirSync(leasePath).find((name) => name.startsWith('owner-'));
      expect(replacementMarker).toBeTruthy();
      expect(
        JSON.parse(readFileSync(join(leasePath, replacementMarker!), 'utf8')) as {
          pid: number;
          id: string;
        },
      ).toMatchObject({ pid: process.pid });
    } finally {
      prototype.beforeLeaseTransition = originalHook;
      await replacement?.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not let a delayed release transition remove a replacement lease', async () => {
    const { OAuthStore } = await import('../src/http/oauth/store.js');
    const root = join(tmpdir(), `avito-oauth-lease-release-race-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    const leasePath = `${storeFile}.process.lock`;
    const displacedPath = `${leasePath}.displaced`;
    const prototype = OAuthStore.prototype as unknown as {
      beforeLeaseTransition: (reason: 'reclaim' | 'release', leasePath: string) => void;
    };
    const originalHook = prototype.beforeLeaseTransition;
    const first = new OAuthStore(storeFile);
    let replacement: InstanceType<typeof OAuthStore> | undefined;
    try {
      prototype.beforeLeaseTransition = (reason, observedPath) => {
        if (reason !== 'release' || replacement) return;
        prototype.beforeLeaseTransition = originalHook;
        renameSync(observedPath, displacedPath);
        replacement = new OAuthStore(storeFile);
      };

      await first.close();
      expect(replacement?.isReady()).toBe(true);
      const replacementMarker = readdirSync(leasePath).find((name) => name.startsWith('owner-'));
      expect(replacementMarker).toBeTruthy();
      expect(
        JSON.parse(readFileSync(join(leasePath, replacementMarker!), 'utf8')) as {
          pid: number;
          id: string;
        },
      ).toMatchObject({ pid: process.pid });
      expect(lstatSync(displacedPath).isDirectory()).toBe(true);
    } finally {
      prototype.beforeLeaseTransition = originalHook;
      await first.close().catch(() => undefined);
      await replacement?.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('releases an acquired lease when OAuth router construction fails', async () => {
    if (!createOAuthSubsystem) return;
    const root = join(tmpdir(), `avito-oauth-router-failure-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    try {
      expect(() =>
        createOAuthSubsystem!(
          makeHttpConfig({ publicUrl: 'ftp://mcp.example.com', oauthStoreFile: storeFile }),
        ),
      ).toThrow();
      await expect(fs.access(`${storeFile}.process.lock`)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('validates the public URL before acquiring a durable lease', async () => {
    const root = join(tmpdir(), `avito-oauth-url-failure-${randomBytes(6).toString('hex')}`);
    const storeFile = join(root, 'oauth.json');
    try {
      expect(
        () =>
          new AvitoOAuthProvider(
            makeHttpConfig({ publicUrl: 'not a valid URL', oauthStoreFile: storeFile }),
          ),
      ).toThrow();
      await expect(fs.access(`${storeFile}.process.lock`)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('OAuth router — /authorize/approve rate limit (v0.9.1)', () => {
  it('returns an explicit supported DCR auth method and rejects client_secret_basic', async () => {
    if (!createOAuthSubsystem) return;
    const express = (await import('express')).default;
    const subsystem = createOAuthSubsystem(makeHttpConfig());
    const app = express();
    app.use(subsystem.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const metadata = {
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'avito:mcp',
    };
    try {
      const defaulted = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      expect(defaulted.status).toBe(201);
      expect(await defaulted.json()).toMatchObject({
        token_endpoint_auth_method: 'client_secret_post',
        client_secret: expect.any(String),
      });

      const unsupported = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...metadata, token_endpoint_auth_method: 'client_secret_basic' }),
      });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({ error: 'invalid_client_metadata' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await subsystem.close();
    }
  });

  it('completes DCR + consent + PKCE token exchange with an exact resource', async () => {
    if (!createOAuthSubsystem) return;
    const express = (await import('express')).default;
    const subsystem = createOAuthSubsystem(makeHttpConfig());
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
          redirect_uris: ['https://client.example/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'HTTP Flow Client',
          scope: 'avito:mcp',
        }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as OAuthClientInformationFull;

      const verifier = randomBytes(32).toString('base64url');
      const authorizeUrl = new URL(`${base}/authorize`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', client.client_id);
      authorizeUrl.searchParams.set('redirect_uri', client.redirect_uris[0]!);
      authorizeUrl.searchParams.set('code_challenge', s256(verifier));
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('scope', 'avito:mcp');
      authorizeUrl.searchParams.set('resource', RESOURCE.href);
      authorizeUrl.searchParams.set('state', 'http-state');
      const authorization = await fetch(authorizeUrl);
      expect(authorization.status).toBe(200);
      const html = await authorization.text();
      const consentToken = /name="consent_token" value="([^"]+)"/.exec(html)?.[1];
      expect(consentToken).toBeTruthy();

      const approval = await fetch(`${base}/authorize/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          consent_token: consentToken!,
          owner_password: OWNER_PASSWORD,
        }),
      });
      expect(approval.status).toBe(302);
      const redirect = new URL(approval.headers.get('location')!);
      expect(redirect.searchParams.get('state')).toBe('http-state');
      const code = redirect.searchParams.get('code');
      expect(code).toBeTruthy();

      const tokenResponse = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: code!,
          code_verifier: verifier,
          redirect_uri: client.redirect_uris[0]!,
          resource: RESOURCE.href,
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = (await tokenResponse.json()) as { access_token: string; scope: string };
      expect(tokens.scope).toBe('avito:mcp');
      const auth = await subsystem.provider.verifyAccessToken(tokens.access_token);
      expect(auth.clientId).toBe(client.client_id);
      expect(auth.resource?.href).toBe(RESOURCE.href);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await subsystem.close();
    }
  });

  it('answers 429 after the per-IP attempt budget is exhausted', async () => {
    if (!createOAuthSubsystem) return; // index.ts not present — covered elsewhere
    const express = (await import('express')).default;
    const subsystem = createOAuthSubsystem(makeHttpConfig());
    const app = express();
    app.use(subsystem.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as import('node:net').AddressInfo;

    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const r = await fetch(`http://127.0.0.1:${port}/authorize/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'owner_password=wrong-guess',
        });
        statuses.push(r.status);
        await r.arrayBuffer(); // drain
      }
      // The first attempts fail with 400 (malformed request) — but they all
      // count, and the budget (10/15 min) trips before the 11th.
      expect(statuses[statuses.length - 1]).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await subsystem.close();
    }
  });

  it('rejects an oversized DCR request before persistence', async () => {
    if (!createOAuthSubsystem) return;
    const express = (await import('express')).default;
    const subsystem = createOAuthSubsystem(makeHttpConfig());
    const app = express();
    app.use(subsystem.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://client.example/callback'],
          token_endpoint_auth_method: 'none',
          software_statement: 'x'.repeat(40 * 1024),
        }),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await subsystem.close();
    }
  });
});
