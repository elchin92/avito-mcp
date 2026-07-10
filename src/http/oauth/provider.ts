/**
 * v0.9.0: self-hosted, single-tenant OAuth 2.1 Authorization + Resource server
 * for the remote MCP endpoint. Implements the MCP SDK's OAuthServerProvider so
 * `mcpAuthRouter` can mount /authorize, /token, /register and /revoke around it,
 * and `requireBearerAuth` can verify access tokens against it.
 *
 * Security invariant (single tenant): Dynamic Client Registration is OPEN — any
 * client may register and start an authorization request — but NO token is ever
 * minted until the deployment OWNER proves possession of the shared owner
 * password at POST /authorize/approve. authorize() only renders a login form; it
 * deliberately does NOT issue a code. The owner password is compared in
 * constant time (crypto.timingSafeEqual).
 *
 * PKCE: code_challenge_method=S256 only. The SDK's token handler performs the
 * S256 verification locally (skipLocalPkceValidation is left false/undefined),
 * calling challengeForAuthorizationCode() for the stored challenge. We ALSO
 * verify defensively inside exchangeAuthorizationCode() when a code_verifier is
 * passed through (it only is if local validation was skipped — belt and braces).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { HttpConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { OAuthStore } from './store.js';

/** Computes the PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)). */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time string compare that is safe for unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still compare against a same-length buffer so the timing doesn't leak
    // the length, then return false.
    timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Minimal HTML-escape for values interpolated into the consent page. */
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REQUIRED_SCOPE = 'avito:mcp';
const MAX_DCR_BYTES = 32 * 1024;

function assertStringLimit(label: string, value: string | undefined, max: number): void {
  if (value !== undefined && Buffer.byteLength(value, 'utf8') > max) {
    throw new InvalidClientMetadataError(`${label} exceeds ${max} bytes`);
  }
}

/** Rejects large/unneeded DCR metadata before it reaches the persistent store. */
function sanitizeClientMetadata(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
): Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> {
  const tokenAuthMethod = client.token_endpoint_auth_method ?? 'client_secret_post';
  if (tokenAuthMethod !== 'client_secret_post' && tokenAuthMethod !== 'none') {
    throw new InvalidClientMetadataError(
      'token_endpoint_auth_method must be client_secret_post or none',
    );
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(client);
  } catch {
    throw new InvalidClientMetadataError('Client metadata must be JSON serializable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_DCR_BYTES) {
    throw new InvalidClientMetadataError(`Client metadata exceeds ${MAX_DCR_BYTES} bytes`);
  }
  if (client.redirect_uris.length === 0 || client.redirect_uris.length > 10) {
    throw new InvalidClientMetadataError('redirect_uris must contain between 1 and 10 entries');
  }
  for (const uri of client.redirect_uris) assertStringLimit('redirect_uri', uri, 2048);
  assertStringLimit('client_name', client.client_name, 128);
  assertStringLimit('client_uri', client.client_uri, 2048);
  assertStringLimit('logo_uri', client.logo_uri, 2048);
  assertStringLimit('scope', client.scope, 256);
  assertStringLimit('tos_uri', client.tos_uri, 2048);
  assertStringLimit('policy_uri', client.policy_uri, 2048);
  assertStringLimit('jwks_uri', client.jwks_uri, 2048);
  assertStringLimit('software_id', client.software_id, 128);
  assertStringLimit('software_version', client.software_version, 128);
  if (
    client.contacts &&
    (client.contacts.length > 10 || client.contacts.some((v) => v.length > 320))
  ) {
    throw new InvalidClientMetadataError('contacts contains too many or oversized values');
  }
  if (
    client.grant_types &&
    client.grant_types.some((v) => !['authorization_code', 'refresh_token'].includes(v))
  ) {
    throw new InvalidClientMetadataError(
      'Only authorization_code and refresh_token grants are supported',
    );
  }
  if (client.response_types && client.response_types.some((v) => v !== 'code')) {
    throw new InvalidClientMetadataError('Only the code response type is supported');
  }
  if (client.scope) {
    const scopes = client.scope.split(/\s+/).filter(Boolean);
    if (scopes.some((scope) => scope !== REQUIRED_SCOPE)) {
      throw new InvalidClientMetadataError(`Only the ${REQUIRED_SCOPE} scope is supported`);
    }
  }
  const extended = client as typeof client & { jwks?: unknown; software_statement?: string };
  if (extended.jwks !== undefined || extended.software_statement !== undefined) {
    throw new InvalidClientMetadataError(
      'Inline jwks and software_statement metadata are not supported',
    );
  }
  return { ...structuredClone(client), token_endpoint_auth_method: tokenAuthMethod };
}

/**
 * Renders the self-submitting consent/login page. A single password field plus
 * hidden inputs carry the authorization request to POST /authorize/approve.
 */
function renderConsentPage(
  params: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    resource: string;
    clientName?: string;
    consentToken: string;
  },
  errorMessage?: string,
): string {
  const who = params.clientName ? esc(params.clientName) : esc(params.clientId);
  const redirect = new URL(params.redirectUri);
  const errorBlock = errorMessage ? `<p class="error" role="alert">${esc(errorMessage)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Avito MCP — authorize</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  .client { font-weight: 600; }
  form { display: flex; flex-direction: column; gap: .75rem; margin-top: 1.25rem; }
  label { font-size: .9rem; }
  input[type=password] { padding: .55rem .65rem; font-size: 1rem; border: 1px solid #8888; border-radius: .375rem; }
  button { padding: .6rem 1rem; font-size: 1rem; border: 0; border-radius: .375rem; cursor: pointer;
           background: #1565c0; color: #fff; }
  dl { display: grid; grid-template-columns: 7rem 1fr; gap: .45rem .75rem; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { background: #8881; padding: .1rem .3rem; border-radius: .25rem; }
  .error { color: #c62828; font-weight: 600; }
  .muted { color: #8a8a8a; font-size: .8rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>Authorize access to Avito MCP</h1>
<p>The client <span class="client">${who}</span> is requesting access to this Avito MCP server.</p>
<dl>
  <dt>Registration</dt><dd>Dynamically registered client</dd>
  <dt>Client ID</dt><dd><code>${esc(params.clientId)}</code></dd>
  <dt>Redirect host</dt><dd><strong>${esc(redirect.origin)}</strong></dd>
  <dt>Redirect URI</dt><dd><code>${esc(params.redirectUri)}</code></dd>
  <dt>Resource</dt><dd><code>${esc(params.resource)}</code></dd>
  <dt>Scopes</dt><dd><code>${esc(params.scopes.join(' '))}</code></dd>
</dl>
${errorBlock}
<form method="POST" action="/authorize/approve" autocomplete="off">
  <label for="owner_password">Owner password</label>
  <input id="owner_password" name="owner_password" type="password" required autofocus
         autocomplete="current-password">
  <input type="hidden" name="consent_token" value="${esc(params.consentToken)}">
  <button type="submit">Approve</button>
</form>
<p class="muted">This is a single-tenant server. Only the deployment owner can approve access.</p>
</body>
</html>`;
}

/** OAuthRegisteredClientsStore backed by {@link OAuthStore}, with DCR support. */
class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: OAuthStore) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  /** DCR: the SDK strips client_id/client_id_issued_at; we mint them here. */
  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const nowSec = Math.floor(Date.now() / 1000);
    const sanitized = sanitizeClientMetadata(client);
    if (sanitized.token_endpoint_auth_method === 'none' && sanitized.client_secret) {
      throw new InvalidClientMetadataError('Public clients must not include client_secret');
    }
    if (sanitized.token_endpoint_auth_method === 'client_secret_post' && !sanitized.client_secret) {
      sanitized.client_secret = OAuthStore.newSecret();
    }
    const full: OAuthClientInformationFull = {
      ...sanitized,
      client_id: OAuthStore.newId(),
      client_id_issued_at: nowSec,
    };
    // Public clients (PKCE, token_endpoint_auth_method=none) get no secret. For
    // confidential clients the SDK already generated client_secret; we keep it
    // and mark it non-expiring (0) unless one was supplied.
    if (full.client_secret && full.client_secret_expires_at === undefined) {
      full.client_secret_expires_at = 0; // never expires
    }
    if (!this.store.hasClientCapacity()) {
      throw new InvalidClientMetadataError('OAuth client capacity reached');
    }
    this.store.putClient(full);
    logger.info(
      { clientId: full.client_id, name: full.client_name, public: !full.client_secret },
      'oauth: registered client (DCR)',
    );
    return full;
  }
}

export class AvitoOAuthProvider implements OAuthServerProvider {
  private readonly store: OAuthStore;
  private readonly clients: ClientsStore;
  private readonly ttlSec: number;
  private readonly ownerPassword?: string;
  private readonly expectedResource: string;
  /** Scopes this AS supports; tokens default to these when a client asks none. */
  private readonly supportedScopes = [REQUIRED_SCOPE];

  constructor(httpConfig: HttpConfig) {
    // Validate URL-derived state before acquiring the durable store lease. A bad
    // public URL must not leave the next corrected startup locked out.
    this.expectedResource = new URL(`${httpConfig.publicUrl}/mcp`).href;
    this.ttlSec = httpConfig.oauthTokenTtlSec;
    this.ownerPassword = httpConfig.oauthOwnerPassword;
    this.store = new OAuthStore(httpConfig.oauthStoreFile);
    this.clients = new ClientsStore(this.store);
  }

  // Local PKCE validation stays ON (SDK verifies via challengeForAuthorizationCode).
  // Leaving this undefined === false.

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clients;
  }

  /**
   * Begins the flow by rendering the owner login/consent page. We do NOT issue a
   * code here — the SDK's authorize handler has already validated client_id,
   * redirect_uri (against the registered set) and PKCE params, so the hidden
   * fields we echo back are trustworthy. A code is only minted at
   * approveConsent() once the owner password checks out.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const scopes = this.normalizeScopes(params.scopes);
    const resource = this.requireExpectedResource(params.resource?.href);
    const consentToken = this.store.createConsent({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource,
    });
    const html = renderConsentPage({
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      scopes,
      resource,
      consentToken,
    });
    this.setConsentHeaders(res);
    res.status(200).send(html);
  }

  /**
   * Express handler for POST /authorize/approve (mounted by the router in
   * ./index.ts). Verifies the owner password in constant time; on success mints
   * a one-time code and 302-redirects to redirect_uri with ?code=&state=. On a
   * bad password it re-renders the form with an error (HTTP 401). On a malformed
   * request or unknown client it redirects with error=access_denied where a
   * redirect_uri is available, else returns 400.
   */
  approveConsent = async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const consentToken = str(body.consent_token);
    const ownerPassword = str(body.owner_password) ?? '';

    if (!consentToken) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'Missing consent transaction' });
      return;
    }
    const consent = this.store.peekConsent(consentToken);
    if (!consent) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Invalid or expired consent transaction',
      });
      return;
    }
    const client = this.store.getClient(consent.clientId);
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    // Re-confirm the redirect_uri is registered for this client (defence in depth).
    // Must use the SDK's matching semantics, not exact equality: GET /authorize
    // already accepted RFC 8252 §7.3 loopback clients (any port on
    // localhost/127.0.0.1/[::1]), so an exact match here would dead-end exactly
    // those flows — after the owner has typed the password.
    if (
      !client.redirect_uris.some((registered) =>
        redirectUriMatches(consent.redirectUri, registered),
      )
    ) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'Unregistered redirect_uri' });
      return;
    }

    if (!this.ownerPassword) {
      // Misconfiguration: oauth mode requires an owner password. Fail closed.
      logger.error('oauth: owner password not configured — refusing to mint a code');
      res
        .status(500)
        .json({ error: 'server_error', error_description: 'Owner password not configured' });
      return;
    }
    if (!safeEqual(ownerPassword, this.ownerPassword)) {
      logger.warn(
        { clientId: consent.clientId },
        'oauth: owner password mismatch at /authorize/approve',
      );
      const html = renderConsentPage(
        {
          clientId: consent.clientId,
          clientName: client.client_name,
          redirectUri: consent.redirectUri,
          scopes: consent.scopes,
          resource: consent.resource,
          consentToken,
        },
        'Incorrect owner password. Please try again.',
      );
      this.setConsentHeaders(res);
      res.status(401).send(html);
      return;
    }

    // Consume after password verification. Concurrent approvals cannot mint two codes.
    const approved = this.store.takeConsent(consentToken);
    if (!approved) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'Consent transaction already used' });
      return;
    }
    const code = this.store.createAuthCode({
      clientId: approved.clientId,
      codeChallenge: approved.codeChallenge,
      redirectUri: approved.redirectUri,
      scopes: approved.scopes,
      resource: approved.resource,
    });
    const target = new URL(approved.redirectUri);
    target.searchParams.set('code', code);
    if (approved.state !== undefined) target.searchParams.set('state', approved.state);
    logger.info(
      { clientId: approved.clientId },
      'oauth: owner approved, authorization code issued',
    );
    res.redirect(302, target.href);
  };

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = this.store.peekAuthCode(authorizationCode);
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.store.takeAuthCode(authorizationCode); // single-use + expiry
    if (!rec) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    // Defensive PKCE check: only reached when the SDK skipped local validation
    // (skipLocalPkceValidation), but verify anyway if a verifier is present.
    if (codeVerifier !== undefined && !safeEqual(s256(codeVerifier), rec.codeChallenge)) {
      throw new InvalidGrantError('code_verifier does not match the challenge');
    }
    // RFC 8707: the resource at token time must match the one bound to the code.
    const boundResource = this.requireExpectedResource(rec.resource);
    const reqResource = this.requireExpectedResource(resource?.href);
    if (boundResource !== reqResource) {
      throw new InvalidRequestError('resource does not match the authorization request');
    }

    return this.issueTokens(client.client_id, this.normalizeScopes(rec.scopes), boundResource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.store.getRefreshToken(refreshToken);
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    // Down-scoping is allowed; requesting NEW scopes is not.
    let grantedScopes = this.normalizeScopes(rec.scopes);
    if (scopes && scopes.length > 0) {
      this.normalizeScopes(scopes);
      const widened = scopes.filter((s) => !rec.scopes.includes(s));
      if (widened.length > 0) {
        throw new InvalidGrantError('Cannot grant scopes beyond the original authorization');
      }
      grantedScopes = scopes;
    }
    const reqResource = this.requireExpectedResource(resource?.href);
    if (this.requireExpectedResource(rec.resource) !== reqResource) {
      throw new InvalidRequestError('resource does not match the original authorization');
    }
    // Rotate: invalidate the presented refresh token AND the access token it was
    // paired with (the client abandons it on refresh, so lazy expiry would never
    // collect it — each refresh would orphan one entry forever), then mint a
    // fresh pair.
    this.store.deleteRefreshToken(refreshToken);
    if (rec.accessToken) this.store.deleteAccessToken(rec.accessToken);
    return this.issueTokens(client.client_id, grantedScopes, reqResource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.store.getAccessToken(token);
    if (!rec) {
      // The bearerAuth middleware maps InvalidTokenError → 401 + WWW-Authenticate
      // (so MCP clients re-run the OAuth flow); a generic OAuthError would map to
      // 400 and a plain Error to 500 — both wrong for an unknown bearer token.
      throw new InvalidTokenError('Invalid or expired access token');
    }
    if (
      !rec.scopes.includes(REQUIRED_SCOPE) ||
      rec.scopes.some((scope) => scope !== REQUIRED_SCOPE)
    ) {
      throw new InvalidTokenError('Access token has invalid scope');
    }
    const resource = this.requireExpectedResource(rec.resource, true);
    const info: AuthInfo = {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000), // seconds since epoch
    };
    info.resource = new URL(resource);
    return info;
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // RFC 7009 requires an unknown or foreign token to remain a no-op, without
    // revealing ownership. A known token revokes its whole access/refresh pair.
    this.store.revokeTokenFamily(client.client_id, request.token);
  }

  close(): Promise<void> {
    return this.store.close();
  }

  /** Releases a just-created store if OAuth router construction fails synchronously. */
  abortStartup(): void {
    this.store.abortStartup();
  }

  isReady(): boolean {
    return this.store.isReady();
  }

  // ───────────────────────────────── internals ───────────────────────────────

  /** Mints + stores an access/refresh token pair and shapes the OAuthTokens. */
  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    if (this.ttlSec <= 0) {
      // Should never happen (config coerces to a positive int), but be explicit.
      throw new ServerError('Invalid token TTL');
    }
    const expiresAt = Date.now() + this.ttlSec * 1000;
    const accessToken = this.store.createAccessToken({ clientId, scopes, resource, expiresAt });
    // Refresh tokens outlive access tokens; give them a generous fixed lifetime.
    // The paired access token is linked so rotation can revoke it eagerly.
    const refreshExpiresAt = Date.now() + Math.max(this.ttlSec, 30 * 24 * 60 * 60) * 1000;
    const refreshToken = this.store.createRefreshToken({
      clientId,
      scopes,
      resource,
      expiresAt: refreshExpiresAt,
      accessToken,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.ttlSec,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  private normalizeScopes(scopes: string[] | undefined): string[] {
    if (!scopes || scopes.length === 0) return [...this.supportedScopes];
    const unique = [...new Set(scopes.filter(Boolean))];
    if (unique.length !== 1 || unique[0] !== REQUIRED_SCOPE) {
      throw new InvalidScopeError(`Only the ${REQUIRED_SCOPE} scope is supported`);
    }
    return unique;
  }

  private requireExpectedResource(value: string | undefined, tokenValidation = false): string {
    let normalized: string | undefined;
    try {
      if (value !== undefined) {
        const parsed = new URL(value);
        if (parsed.hash) throw new Error('fragment not allowed');
        normalized = parsed.href;
      }
    } catch {
      if (tokenValidation) throw new InvalidTokenError('Access token has invalid resource');
      throw new InvalidRequestError('Invalid resource indicator');
    }
    if (normalized !== this.expectedResource) {
      if (tokenValidation)
        throw new InvalidTokenError('Access token was issued for a different resource');
      throw new InvalidRequestError(`resource must be ${this.expectedResource}`);
    }
    return normalized;
  }

  private setConsentHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
}
