/**
 * M2 (SDK v2): end-to-end contract of the Resource-Server half of the OAuth
 * subsystem, over a real HTTP listener.
 *
 * Three things are proven here that nothing else in the suite could see, because
 * every other MCP test runs over InMemoryTransport with no HTTP request at all:
 *
 *  1. An invalid or expired Bearer token is answered with 401 and a usable
 *     `WWW-Authenticate` challenge — NOT 500. Under SDK v2 the resource-server
 *     middleware (`requireBearerAuth` from @modelcontextprotocol/express)
 *     recognises only the v2 `OAuthError` brand; the server-legacy OAuth error
 *     classes, which the authorization-server half still uses, fall through its
 *     `instanceof` check and land on the 500 branch. A verifier left throwing
 *     the legacy class would therefore turn every bad token into an opaque
 *     500 and strip clients of the discovery mechanism they need to re-auth,
 *     while every existing test stayed green.
 *
 *  2. `callerPrincipal()` still resolves an authenticated caller to
 *     `oauth:<client_id>`. SDK v2 moved the verified token from v1's flat
 *     `extra.authInfo` to `ctx.http.authInfo`; because `CallerExtra` is a weak
 *     type, the stale v1 shape kept compiling and silently degraded every
 *     principal to `session:<id>`. That would quietly change who is allowed to
 *     confirm money/public actions and how the confirmation rate limit is
 *     counted, so it is asserted on the real value stored with a pending action.
 *
 *  3. The hard-confirmation rate limit is metered on that principal, so two MCP
 *     sessions opened on one access token share one budget. Under the degraded
 *     principal each new `initialize` handed the caller a fresh budget, turning
 *     a brute-force guard into a formality — the consequence that makes the
 *     shape of `CallerExtra` a security property and not a cosmetic one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { WebhookStore } from '../src/core/webhook-store.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/app.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config, HttpConfig } from '../src/config.js';

const OWNER_PASSWORD = 'bearer-http-owner-password-strong';
const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const REDIRECT_URI = 'https://client.example/callback';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

interface Rig {
  handle: HttpServerHandle;
  base: string;
  pendingStore: PendingActionStore;
}

async function startRig(
  httpOverrides: Partial<HttpConfig> = {},
  configOverrides: Partial<Config> = {},
): Promise<Rig> {
  const port = await reservePort();
  const http: HttpConfig = {
    transport: 'http',
    host: '127.0.0.1',
    port,
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
    oauthTokenTtlSec: 3600,
    oauthOwnerPassword: OWNER_PASSWORD,
    ...httpOverrides,
  };
  const cfg = {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345678,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: false,
    allowedUploadDirs: [],
    maxUploadMb: 15,
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    confirmationSecret: undefined,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http,
    webhook: {
      enabled: false,
      secret: undefined,
      publicUrl: PUBLIC_URL,
      path: '/avito/webhook',
      bufferSize: 100,
    },
    ...configOverrides,
  } as unknown as Config;

  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const ctx: ToolContext = {
    client: new AvitoClient(cfg),
    config: cfg,
    pendingStore,
    idempotencyStore: new IdempotencyStore(cfg.idempotencyTtlSec * 1000),
    webhookStore: new WebhookStore(100),
  };
  const handle = await startHttpServer(ctx, cfg);
  return { handle, base: `http://127.0.0.1:${handle.port}`, pendingStore };
}

/** Drives the full authorization-code + PKCE flow over real HTTP and returns an access token. */
async function mintAccessToken(base: string): Promise<{ token: string; clientId: string }> {
  const registration = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'avito:mcp',
    }),
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('code_challenge', s256(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', 'avito:mcp');
  authorizeUrl.searchParams.set('resource', RESOURCE);
  authorizeUrl.searchParams.set('state', 'bearer-http-state');
  const consentPage = await fetch(authorizeUrl);
  expect(consentPage.status).toBe(200);
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(await consentPage.text())?.[1];
  expect(consentToken).toBeTruthy();

  const approval = await fetch(`${base}/authorize/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      consent_token: consentToken!,
      owner_password: OWNER_PASSWORD,
    }),
  });
  expect(approval.status).toBe(302);
  const code = new URL(approval.headers.get('location')!).searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenResponse = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as { access_token: string };
  expect(tokens.access_token).toBeTruthy();
  return { token: tokens.access_token, clientId: client.client_id };
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'oauth-bearer-http-test', version: '1' },
    },
  });
}

function mcpHeaders(token: string, sessionId?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

/** Initializes a fresh MCP session on the given token and returns its session id. */
async function openSession(base: string, token: string): Promise<string> {
  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(token),
    body: initializeBody(),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  await init.text();
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(token, sessionId!),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId!;
}

/** Reads a JSON-RPC result out of either a plain JSON or an SSE-framed response. */
async function readRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const line = text
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5)
      .trim();
    return JSON.parse(line ?? '{}') as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('OAuth bearer auth over HTTP (SDK v2 resource-server path)', () => {
  it('answers an unknown Bearer token with 401 and a discoverable challenge, never 500', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const response = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders('definitely-not-a-real-token'),
      body: initializeBody(),
    });

    // The whole point: the v2 middleware must have recognised the verifier's
    // error. A legacy-branded error would surface here as 500.
    expect(response.status).not.toBe(500);
    expect(response.status).toBe(401);

    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="invalid_token"');
    // resource_metadata is what lets a client find the authorization server.
    expect(challenge).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="avito:mcp"');
    expect(await response.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('answers a missing Authorization header with 401, not 500', async () => {
    const rig = await startRig();
    handle = rig.handle;

    const response = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: initializeBody(),
    });

    expect(response.status).not.toBe(500);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');
  });

  it('answers an expired but genuinely issued token with 401, not 500', async () => {
    const rig = await startRig({ oauthTokenTtlSec: 1 });
    handle = rig.handle;
    const { token } = await mintAccessToken(rig.base);

    // The token is valid right now …
    const before = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(token),
      body: initializeBody(),
    });
    expect(before.status).toBe(200);

    // … and expired a second later. Same verifier, different branch: the record
    // has aged out of the store, which is the path an operator actually hits.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const after = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(token),
      body: initializeBody(),
    });

    expect(after.status).not.toBe(500);
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate') ?? '').toContain('error="invalid_token"');
  });

  it('accepts a valid token and attributes the pending action to oauth:<client_id>', async () => {
    const rig = await startRig();
    handle = rig.handle;
    const { token, clientId } = await mintAccessToken(rig.base);

    const init = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(token),
      body: initializeBody(),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(token, sessionId!),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // A `public`-risk tool under confirmation_mode=money_public parks a pending
    // action before any network call, stamping it with the caller's principal.
    const call = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(token, sessionId!),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'items_update_price',
          arguments: { item_id: 123456789, price: 4200 },
        },
      }),
    });
    expect(call.status).toBe(200);
    const rpc = await readRpc(call);
    const structured = (rpc.result as { structuredContent?: Record<string, unknown> } | undefined)
      ?.structuredContent;
    expect(structured?.requires_confirmation).toBe(true);

    const pending = await rig.pendingStore.listPersistent();
    expect(pending).toHaveLength(1);
    // Under the stale v1 CallerExtra shape this read `session:<uuid>`.
    expect(pending[0]!.initiator).toBe(`oauth:${clientId}`);
  });

  it('falls back to bearer:<token fingerprint> when the shared-secret guard is in use', async () => {
    // AVITO_MCP_HTTP_AUTH=bearer never populates req.auth, so this exercises the
    // OTHER half of callerPrincipal: reading the Authorization header off
    // ctx.http.req. v1 read it from `extra.requestInfo.headers.authorization`
    // (a plain object); v2 hands over a web-standard `Headers`, where that
    // bracket access silently yields undefined and the principal collapses.
    const sharedToken = 'shared-secret-token-0123456789abcdef';
    const rig = await startRig({ auth: 'bearer', authTokens: [sharedToken] });
    handle = rig.handle;

    const init = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(sharedToken),
      body: initializeBody(),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id')!;

    await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(sharedToken, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const call = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(sharedToken, sessionId),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'items_update_price',
          arguments: { item_id: 987654321, price: 1500 },
        },
      }),
    });
    expect(call.status).toBe(200);

    const pending = await rig.pendingStore.listPersistent();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.initiator).toBe(
      `bearer:${createHash('sha256').update(sharedToken).digest('base64url')}`,
    );
  });

  it('meters the hard-confirmation rate limit per OAuth principal, not per MCP session', async () => {
    // The downstream consequence of the principal, and the reason the shape of
    // CallerExtra is a security property rather than a cosmetic one:
    // meta_confirm_action budgets confirmation attempts by
    // pendingStore.checkConfirmationRateLimit(callerPrincipal(...)). Keyed on the
    // OAuth client the budget is a property of the *caller*; keyed on the MCP
    // session id it becomes a property of the connection, and any caller can mint
    // a fresh budget by re-running `initialize` — which is exactly what the stale
    // v1 CallerExtra shape did, silently, to a brute-force guard.
    const rig = await startRig(
      {},
      { confirmationSecret: 'hard-confirmation-secret-of-at-least-32-chars' },
    );
    handle = rig.handle;
    const { token } = await mintAccessToken(rig.base);

    // Two independent MCP sessions on ONE issued token, i.e. one principal.
    const sessionA = await openSession(rig.base, token);
    const sessionB = await openSession(rig.base, token);
    expect(sessionA).not.toBe(sessionB);

    const confirm = async (
      sessionId: string,
      id: number,
    ): Promise<{ error?: { kind?: string } } | undefined> => {
      const response = await fetch(`${rig.base}/mcp`, {
        method: 'POST',
        headers: mcpHeaders(token, sessionId),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'meta_confirm_action',
            arguments: { confirmation_id: 'nonexistent-confirmation-id-0000' },
          },
        }),
      });
      expect(response.status).toBe(200);
      const rpc = await readRpc(response);
      return (rpc.result as { structuredContent?: { error?: { kind?: string } } } | undefined)
        ?.structuredContent;
    };

    // Burn the whole 20-attempt window on session A. Each attempt is answered
    // "not found" (no structuredContent), so the budget is spent, not the ids.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await confirm(sessionA, 100 + attempt))?.error?.kind).toBeUndefined();
    }

    // Session B is a different connection but the same authenticated caller, so
    // it must inherit the exhausted budget. With a session-derived principal it
    // would get a pristine one and the guard would be trivially bypassable.
    expect((await confirm(sessionB, 200))?.error?.kind).toBe('RATE_LIMITED');
    // …and the original session stays blocked too.
    expect((await confirm(sessionA, 201))?.error?.kind).toBe('RATE_LIMITED');
  });
});
