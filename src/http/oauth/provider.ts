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
import type {
  AuthInfo,
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
// Authorization-Server-side errors. mcpAuthRouter (server-legacy) maps these to
// their OAuth status codes by `instanceof` against its own class hierarchy, so
// the AS endpoints must keep throwing THESE classes.
//
// The Resource-Server side is the other brand: see verifyAccessToken, which must
// throw the v2 `OAuthError` above — @modelcontextprotocol/express does not
// recognise the legacy classes and turns them into 500 instead of 401. The two
// hierarchies do not overlap (`new InvalidTokenError() instanceof OAuthError` is
// false in both directions), so the split has to be maintained by hand.
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  ServerError,
  redirectUriMatches,
} from '@modelcontextprotocol/server-legacy/auth';
import type {
  AuthorizationParams,
  OAuthServerProvider,
  OAuthRegisteredClientsStore,
} from '@modelcontextprotocol/server-legacy/auth';
import { isLoopbackHostname, type HttpConfig } from '../../config.js';
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

/**
 * M5.3 — the `redirect_uri` MUST that open registration made load-bearing.
 *
 * Registration is unauthenticated, so the redirect target of any client is
 * chosen by a stranger, and until now the only checks on it were "there are
 * between 1 and 10 of them" and "each is under 2 KiB". That accepted
 * `http://evil.example.com/cb`: a cleartext callback the owner is then invited
 * to approve on a consent screen, after which the authorization code travels
 * over the network in the clear to a host the deployment never heard of.
 *
 * So: `https:` anywhere, or `http:` restricted to loopback (RFC 8252 §7.3, the
 * native-app case where no network hop exists to intercept). A fragment is
 * rejected outright — OAuth 2.1 forbids one in a redirect URI, and a client that
 * registers one is telling us something is wrong with its URI construction.
 *
 * Private-use URI schemes (`com.example.app:/cb`) are NOT accepted, which is a
 * deliberate narrowing: honouring them safely means enforcing the reverse-domain
 * ownership rule of RFC 8252 §7.1, and an unauthenticated registration endpoint
 * cannot establish that. Native clients use the loopback redirect instead, which
 * this deployment has supported since v0.9.1.
 */
function assertRegistrableRedirectUri(uri: string, applicationType?: ApplicationType): URL {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`redirect_uri must be an absolute URI: ${uri}`);
  }
  if (parsed.hash) {
    throw new InvalidClientMetadataError(`redirect_uri must not contain a fragment: ${uri}`);
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) {
    // A `web` client, by definition, runs on a server the user reaches over the
    // network; a loopback callback there means the redirect resolves on whatever
    // machine the browser happens to be, which is not the client that registered.
    if (applicationType === 'web' && (loopback || parsed.protocol !== 'https:')) {
      throw new InvalidClientMetadataError(
        `application_type "web" requires an https redirect_uri on a non-loopback host: ${uri}`,
      );
    }
    return parsed;
  }
  throw new InvalidClientMetadataError(
    `redirect_uri must use https, or http on a loopback address (localhost / 127.0.0.1 / [::1]): ${uri}`,
  );
}

/**
 * M5.4 — `application_type`, read rather than ignored.
 *
 * The MUST in the spec is addressed to clients, so registration WITHOUT the
 * field stays acceptable and is the common case. What the AS owes is to honour
 * it when it is there, because it changes two things that matter: a `web` client
 * cannot have a loopback callback (see above), and a `native` client is a public
 * client by construction — it ships to end-user devices and cannot hold a
 * secret, so handing it a `client_secret` would manufacture a credential that is
 * guaranteed to leak while making it look like a confidential client to
 * everything downstream.
 */
type ApplicationType = 'native' | 'web';

function readApplicationType(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
): ApplicationType | undefined {
  const value = (client as { application_type?: unknown }).application_type;
  if (value === undefined) return undefined;
  if (value !== 'native' && value !== 'web') {
    throw new InvalidClientMetadataError('application_type must be "native" or "web"');
  }
  return value;
}

function assertStringLimit(label: string, value: string | undefined, max: number): void {
  if (value !== undefined && Buffer.byteLength(value, 'utf8') > max) {
    throw new InvalidClientMetadataError(`${label} exceeds ${max} bytes`);
  }
}

/** Rejects large/unneeded DCR metadata before it reaches the persistent store. */
function sanitizeClientMetadata(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
): Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> {
  const applicationType = readApplicationType(client);
  // A native client defaults to `none` instead of `client_secret_post`: it runs
  // on an end-user device, so a secret minted for it is a secret that leaks.
  const tokenAuthMethod =
    client.token_endpoint_auth_method ??
    (applicationType === 'native' ? 'none' : 'client_secret_post');
  if (tokenAuthMethod !== 'client_secret_post' && tokenAuthMethod !== 'none') {
    throw new InvalidClientMetadataError(
      'token_endpoint_auth_method must be client_secret_post or none',
    );
  }
  if (applicationType === 'native' && tokenAuthMethod !== 'none') {
    throw new InvalidClientMetadataError(
      'application_type "native" is a public client: token_endpoint_auth_method must be none',
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
  for (const uri of client.redirect_uris) {
    assertStringLimit('redirect_uri', uri, 2048);
    assertRegistrableRedirectUri(uri, applicationType);
  }
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
 * M5.4 — the one line on the consent screen the spec makes mandatory.
 *
 * Registration is open, so `client_name` is attacker-supplied text and proves
 * nothing; the hostname of the redirect URI is the only field on this page that
 * says where the authorization code will actually go. It therefore gets its own
 * row, in its own right, and is not folded into the full URI where a long path
 * can push it out of view.
 */
function describeRegistration(client: {
  application_type?: unknown;
  client_secret?: string;
  client_id_issued_at?: number;
}): string {
  const kind =
    client.application_type === 'native' || client.application_type === 'web'
      ? `application_type ${client.application_type}`
      : 'application_type not declared';
  const confidentiality = client.client_secret ? 'confidential' : 'public';
  const issued =
    typeof client.client_id_issued_at === 'number' && client.client_id_issued_at > 0
      ? new Date(client.client_id_issued_at * 1000).toISOString().slice(0, 10)
      : 'unknown date';
  return `Self-registered ${confidentiality} client, ${kind}, registered ${issued}`;
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
    registration: string;
    consentToken: string;
  },
  errorMessage?: string,
): string {
  const who = params.clientName ? esc(params.clientName) : esc(params.clientId);
  const redirect = new URL(params.redirectUri);
  const errorBlock = errorMessage ? `<p class="error" role="alert">${esc(errorMessage)}</p>` : '';
  // SHOULD: a loopback callback means the code is handed to whatever process is
  // listening on that port on the machine running the browser. That is the
  // normal shape for a native client and an unverifiable one for everything
  // else, so the owner is told rather than left to infer it from "127.0.0.1".
  const loopbackNote = isLoopbackHostname(redirect.hostname)
    ? `<p class="warn" role="note">This client asks for the code to be delivered to <strong>${esc(
        redirect.hostname,
      )}</strong> — a program running on the machine you are approving from. Nothing here can verify which program that is. Approve only if you started this login yourself.</p>`
    : '';
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
  .warn { background: #f9a82522; border-left: .25rem solid #f9a825; padding: .6rem .75rem;
          border-radius: .25rem; font-size: .9rem; }
  .muted { color: #8a8a8a; font-size: .8rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>Authorize access to Avito MCP</h1>
<p>The client <span class="client">${who}</span> is requesting access to this Avito MCP server.</p>
<dl>
  <dt>Redirect host</dt><dd><strong>${esc(redirect.hostname)}</strong></dd>
  <dt>Client name</dt><dd>${params.clientName ? esc(params.clientName) : '<em>not supplied</em>'}</dd>
  <dt>Registration</dt><dd>${esc(params.registration)}</dd>
  <dt>Client ID</dt><dd><code>${esc(params.clientId)}</code></dd>
  <dt>Redirect URI</dt><dd><code>${esc(params.redirectUri)}</code></dd>
  <dt>Resource</dt><dd><code>${esc(params.resource)}</code></dd>
  <dt>Scopes</dt><dd><code>${esc(params.scopes.join(' '))}</code></dd>
</dl>
${loopbackNote}
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
  /**
   * M5.1 (RFC 9207 §2) — the issuer identifier that goes into `iss` on every
   * authorization response.
   *
   * It is deliberately `new URL(publicUrl).href` and NOT `publicUrl`: that is the
   * exact expression `mcpAuthRouter` evaluates for the `issuer` field of
   * `/.well-known/oauth-authorization-server` (see `createOAuthMetadata`, which
   * does `issuer: issuerUrl.href` on the very `new URL(httpConfig.publicUrl)`
   * built in ./index.ts). The two differ by one byte — `publicUrl` is documented
   * WITHOUT a trailing slash, `href` always has one — and a conformant client
   * compares `iss` to the recorded issuer by simple string comparison, forbidden
   * from folding case, eliding a default port or normalising a trailing slash
   * (spec-authorization requirement 26, RFC 3986 §6.2.2–6.2.3). Deriving `iss`
   * from `publicUrl` would therefore make every correct authorization response
   * look like a mix-up attack.
   */
  private readonly issuer: string;
  /** Scopes this AS supports; tokens default to these when a client asks none. */
  private readonly supportedScopes = [REQUIRED_SCOPE];

  constructor(httpConfig: HttpConfig) {
    // Validate URL-derived state before acquiring the durable store lease. A bad
    // public URL must not leave the next corrected startup locked out.
    this.expectedResource = new URL(`${httpConfig.publicUrl}/mcp`).href;
    this.issuer = new URL(httpConfig.publicUrl).href;
    this.ttlSec = httpConfig.oauthTokenTtlSec;
    this.ownerPassword = httpConfig.oauthOwnerPassword;
    // M5.4: credentials are keyed by the issuer that minted them, so a changed
    // publicUrl cannot resurrect clients and tokens belonging to what is, from
    // any client's point of view, a different authorization server.
    this.store = new OAuthStore(httpConfig.oauthStoreFile, this.issuer);
    this.clients = new ClientsStore(this.store);
  }

  // Local PKCE validation stays ON (SDK verifies via challengeForAuthorizationCode).
  // Leaving this undefined === false.

  /**
   * M5.2 — what `/.well-known/oauth-authorization-server` claims about `iss`.
   *
   * Pinned here rather than left to the SDK's default so the claim lives next to
   * the code that has to back it. The value is readable in exactly one
   * direction:
   *
   *   `true` MEANS `approveConsent()` stamps `iss` on the callback redirect.
   *
   * ⚠️ ORDER IS NOT NEGOTIABLE. Emission ships and reaches production first; the
   * claim follows. Never the reverse and never together in a rollback. By the
   * validation table in the authorization spec, a client that recorded
   * `authorization_response_iss_parameter_supported: true` MUST REJECT an
   * authorization response with no `iss` — so advertising ahead of (or rolling
   * back behind) the emission does not degrade authorization, it stops it
   * outright for every conformant client. If `iss` ever has to be withdrawn,
   * set this to `false`, ship that, and only then remove the emission.
   */
  readonly authorizationResponseIssParameterSupported = true;

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
    // The router hands us its own issuer identifier. It has to be byte-identical
    // to ours, because ours is what approveConsent() will put in `iss` while the
    // router's is what the metadata document advertises — a divergence here is a
    // wiring bug that would make every authorization response fail RFC 9207
    // validation at the client, and it must not reach a browser silently.
    this.assertRouterIssuerMatches(params.issuer);
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
      registration: describeRegistration(client),
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
          registration: describeRegistration(client),
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
    // M5.1 / RFC 9207 §2. The SDK appends `iss` for us only on redirects issued
    // from the response object it handed to authorize(); this final callback
    // redirect comes out of a SEPARATE consent POST, so it is ours to stamp.
    // Without it the metadata claim `authorization_response_iss_parameter_supported`
    // would be a lie and a conformant client would reject the successful response.
    target.searchParams.set('iss', this.issuer);
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
      // requireBearerAuth maps OAuthErrorCode.InvalidToken → 401 + WWW-Authenticate
      // (so MCP clients re-run the OAuth flow); any other OAuth code maps to 400
      // and a non-OAuthError to 500 — both wrong for an unknown bearer token.
      // The server-legacy InvalidTokenError class is NOT interchangeable here: it
      // is a different brand and would land on the 500 branch.
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
    }
    // ⚠️ M5.7 — this is SET EQUALITY, not "has the scope it needs", and that is
    // a migration hazard, not a style choice.
    //
    // The spec says servers MUST honour scope hierarchies; this deployment has
    // exactly one scope, so there is no hierarchy to honour and equality and
    // containment coincide. The moment a second scope exists they stop
    // coinciding, and this line rejects every token that does not carry the new
    // set EXACTLY — including every token already in the field. Splitting
    // `avito:mcp` into `avito:read` / `avito:write` therefore logs out the
    // entire installed base at the instant of deployment, silently, with an
    // `invalid_token` that looks to each client like an expiry it should have
    // been able to refresh through.
    //
    // The decision to keep one scope for this major is recorded in
    // docs/adr/0005-scopes.md. Whoever revisits it: relax this to containment
    // and accept `avito:mcp` as a super-scope FIRST, ship that, and only then
    // start issuing the narrower scopes. See M8.7.
    if (
      !rec.scopes.includes(REQUIRED_SCOPE) ||
      rec.scopes.some((scope) => scope !== REQUIRED_SCOPE)
    ) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has invalid scope');
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

  /**
   * Fails closed when the router's issuer identifier is not the one this provider
   * stamps into `iss`. Both are `new URL(publicUrl).href` today, so the only way
   * to reach this is a future refactor that starts feeding the two halves from
   * different expressions — precisely the change that would silently break RFC
   * 9207 validation for every client.
   */
  private assertRouterIssuerMatches(routerIssuer: string | undefined): void {
    if (routerIssuer === undefined || routerIssuer === this.issuer) return;
    logger.error(
      { routerIssuer, providerIssuer: this.issuer },
      'oauth: issuer identifier mismatch between the auth router and the provider',
    );
    throw new ServerError('Authorization server issuer is misconfigured');
  }

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

  /**
   * `tokenValidation` selects the error BRAND, not just the wording: on the
   * resource-server path (called from verifyAccessToken) it must be the v2
   * OAuthError so requireBearerAuth answers 401; on the authorization-server
   * path it must be the server-legacy class so mcpAuthRouter answers 400.
   */
  private requireExpectedResource(value: string | undefined, tokenValidation = false): string {
    let normalized: string | undefined;
    try {
      if (value !== undefined) {
        const parsed = new URL(value);
        if (parsed.hash) throw new Error('fragment not allowed');
        normalized = parsed.href;
      }
    } catch {
      if (tokenValidation)
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token has invalid resource');
      throw new InvalidRequestError('Invalid resource indicator');
    }
    if (normalized !== this.expectedResource) {
      if (tokenValidation)
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          'Access token was issued for a different resource',
        );
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
