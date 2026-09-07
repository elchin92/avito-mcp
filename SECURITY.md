# Security policy

`avito-mcp` holds credentials for an Avito account and can act on that account through configured tools. This policy covers the local process, remote HTTP/OAuth endpoints, webhook receiver and persistent state.

<a id="how-to-report"></a>

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/elchin92/avito-mcp/security/advisories/new). Include the affected installed version, realistic impact and a minimal reproduction with fictional credentials and identifiers. Do not post tokens, customer data or a working exploit against a live account in a public issue.

Reports are discussed in the advisory thread. Please allow time for a fix before public disclosure. Credit is available unless the reporter prefers anonymity. General questions belong in [Issues](https://github.com/elchin92/avito-mcp/issues).

## Scope and trust boundaries

The supported deployment serves one configured Avito account. MCP clients can supply tool arguments, protocol messages and cancellation requests. Remote callers can reach authentication and registration endpoints before approval. Avito webhook deliveries and upstream responses are external input.

Report credential exposure, unauthorized operations, arbitrary code execution, upload-path escapes, TLS validation bypasses, cross-caller state access, unbounded resource retention and exploitable dependency issues. Include how the affected path is reachable in a supported configuration.

Avito API behavior and defects in an MCP client belong to their respective projects. A user independently publishing a token requires credential rotation; a server defect that causes such a disclosure is in scope.

### Local stdio

stdio has **no authentication**: the peer is the process launched by the local operator, using that process's credentials. It is not a boundary for an untrusted remote caller. A tool being callable by that peer is expected; arbitrary code execution or access outside `AVITO_MCP_ALLOWED_UPLOAD_DIRS` is not.

For remote callers, use `AVITO_MCP_HTTP_AUTH=oauth`. The SDK selects the stdio protocol revision from the opening message; see [the accepted protocol limitation](docs/adr/0001-protocol-era-limitations.md).

### Caller identity

`callerPrincipal()` in `src/core/pending-actions.ts` derives identity in this order:

1. `oauth:<client_id>` — the client ID from a verified token issued by this deployment; stable across both protocol revisions.
2. `bearer:<sha256 of the token>` — a fingerprint of a configured shared secret. Everyone using that secret is the same principal.
3. `session:<Mcp-Session-Id>` — an anonymous legacy HTTP caller on revision **2025-11-25**; a new initialization creates a new principal.
4. `session:local-stdio` — local stdio, or modern HTTP with no authentication; all such callers share the fallback principal.

Misattributing a verified client to another principal or exposing a bearer fingerprint is reportable. Modern HTTP has no protocol session; session hijacking applies to the legacy **2025-11-25** transport.

### State handle hijacking

`confirmation_id` is an explicit handle shared by both protocol revisions. Its controls are:

- **128 bits of entropy**, generated with `randomBytes(16)`.
- **Expiry:** `AVITO_MCP_CONFIRMATION_TTL_SEC`, default 900 seconds, capped at 24 hours.
- **Atomic claims:** one caller claims the action under a file lock before execution.
- **A per-principal budget** enforced by `checkConfirmationRateLimit`. OAuth and bearer principals survive reconnection. An anonymous caller on **2025-11-25** that repeats `initialize` receives a fresh budget because its session principal changes; use authentication when the limit must bind a caller.
- **Optional separate approval:** `AVITO_MCP_CONFIRMATION_SECRET` adds a separate factor. `AVITO_MCP_APPROVAL_MODE=external` requires that secret and records a successful confirmer as `external:secret-provider`; it does not authenticate a second person or require a second OAuth client.

Possession of a handle is not authentication. The ordinary confirmation flow does **not** require the confirming principal to be the initiator. An already-authorized caller who obtains a valid handle may confirm it, including across protocol revisions. Set the separate confirmation secret and external approval mode when that behavior is unsuitable.

Predictable or leaked handles, reuse of expired or consumed actions, bypass of the configured approval factor, and authentication-bound budget bypasses are reportable. The documented ability to confirm a possessed handle in the ordinary mode is the existing design boundary.

## Required controls

| Obligation                       | Implementation                                                        | Reportable failure                                                                             |
| -------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Validate all tool inputs         | Zod schemas in `src/core/tool-factory.ts`; `src/core/upload-guard.ts` | Unvalidated arguments reaching a sensitive sink; traversal or symlink escape from upload roots |
| Implement proper access controls | `src/core/policy.ts` and confirmation checks                          | A denied tool can execute, including through confirmation replay                               |
| Rate limit tool invocations      | `src/core/rate-limiter.ts` and locked shared state                    | Cross-process bypass or unreleased work slots                                                  |
| Sanitize tool outputs            | `src/resources.ts`, `src/logger.ts`, `src/core/client.ts`             | A secret reaches output, logs or an unintended destination                                     |

The upstream client obtains its own Avito token; it must not forward a caller's MCP Authorization header to Avito. Resource cache hints do not authorize access, and account-scoped resources are not public cache entries.

## Modern protocol surface

Revision `2026-07-28` validates request `_meta` before dispatch: malformed inputs use `-32602`, mismatched mirrored claims `-32020`, missing required capabilities `-32021` where applicable, and unsupported versions `-32022`. Unexpected server failures or bypass of these checks are in scope.

`subscriptions/listen` filters are narrowed by `src/core/subscriptions.ts`. Delivery outside the acknowledged filter or across an unauthorized caller boundary is in scope.

`AVITO_MCP_HTTP_MAX_SESSIONS` and `AVITO_MCP_HTTP_SESSION_IDLE_SEC` apply to legacy HTTP only. Modern capacity is bounded by `AVITO_MCP_HTTP_MAX_INFLIGHT` (default 64) and `AVITO_MCP_HTTP_MAX_STREAMS` (default 32). Exceeding a limit returns `503` with `Retry-After`. Slots and streams must be released when the exchange ends.

## Remote authentication

Only `AVITO_MCP_HTTP_AUTH=oauth` implements MCP authorization discovery. `bearer` is a manually configured shared-secret guard; `none` provides no guard. Their lack of OAuth discovery is documented, while accepting an invalid bearer token or bypassing OAuth is reportable.

`AVITO_MCP_HTTP_PUBLIC_URL` is the OAuth issuer identifier and resource URL. OAuth requires HTTPS except on loopback. Development cleartext overrides do not belong in production. Changing the URL resets stored clients and tokens; clients must register and authorize again. Preserve its scheme, host and exact issuer representation through the proxy.

The built-in authorization server retains a transitional SDK helper dependency. Its architecture and exit conditions are recorded in [ADR 0004](docs/adr/0004-own-authorization-server.md). The single `avito:mcp` scope is separate from the tool policy; narrower scopes are planned in [ADR 0005](docs/adr/0005-scopes.md).

### Client registration

Dynamic Client Registration remains supported. Client ID Metadata Documents are not implemented: fetching an unauthenticated caller's URL needs a separate SSRF-resistant design.

Registration controls in `src/http/oauth/provider.ts` and `src/http/oauth/index.ts` include:

- A 32 KiB JSON body and serialized metadata limit, plus field limits.
- `redirect_uris` with between 1 and 10 entries, at most 2048 bytes each; HTTPS or loopback HTTP, no fragments, wildcards or private-use schemes.
- Exact redirect matching at authorization.
- `application_type: web` requires a non-loopback HTTPS redirect; `native` clients receive no client secret.
- Owner approval is rate-limited to 10 attempts per 15 minutes per IP; password comparison is constant-time.

Redirect-rule bypass, an outbound fetch initiated by registration, or a secret issued to a native client is in scope.

### Persistent credentials

`AVITO_MCP_OAUTH_STORE_FILE` contains cleartext access tokens, refresh tokens and registered client secrets. This accepted limitation is documented in [ADR 0006](docs/adr/0006-token-storage.md). Files are created `0600` within a `0700` directory, written atomically and protected by an exclusive process lease.

The service account, host administrator and readers of copied backups can use those credentials. Hashing tokens could reduce file-only exposure; it would not protect a compromised running service. Access tokens expire after one hour by default and refresh tokens after 30 days. Storage outside the private host boundary, multi-tenancy or long-lived machine credentials requires a new storage review.

Wider permissions, another local user's access, credential output or concurrent-store corruption remain reportable. Keep backups private and never commit runtime state.

## Webhooks and uncertain mutations

Webhook authentication uses the configured secret in the receiver URL. Registration must accept only the operator-configured receiver; buffered events and the secret must not become accessible without the required protection. Reverse-proxy access and error logs need separate review because URL paths can contain that secret. See [operations](docs/operations.md#avito-webhook-receiver).

A transport failure after dispatch is not proof of a failed mutation. Idempotency and pending-action claims must remain held where the outcome is unknown; automatic replay must not duplicate the action. Recovery procedures are in [the safety guide](docs/safety.md#lost-responses-after-a-mutation-v21).
