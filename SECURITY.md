# Security Policy

`avito-mcp` runs on your machine and holds OAuth credentials for your Avito account. If you find a way that could leak those credentials, execute arbitrary code, or otherwise put a user at risk — please tell us privately before posting it anywhere public.

## How to report

Use **GitHub Private Vulnerability Reporting**:
**https://github.com/elchin92/avito-mcp/security/advisories/new**

Please include:

- Affected version (`npm view avito-mcp version` for latest)
- What the issue is and what an attacker could do
- A minimal reproduction — **do not** paste real `Client_id` / `Client_secret` / tokens. Use placeholders like `EXAMPLE_TOKEN`.

We'll reply on the same advisory thread. Once a fix is released, the advisory becomes public and you get credit (unless you'd rather stay anonymous).

## In scope

- Leakage of `Client_secret`, `access_token`, or the OAuth token cache file (default location is per-user state dir, configurable via `AVITO_TOKEN_FILE`) to logs, stdout, MCP resources, or any endpoint other than `api.avito.ru`.
- Arbitrary code execution from a malicious MCP-client message.
- TLS / certificate-validation bypasses against `api.avito.ru`.
- Race conditions in the OAuth token store that could expose tokens on shared machines.
- **The remote HTTP surface** (`AVITO_MCP_TRANSPORT=http|both`): bypasses of the OAuth 2.1 authorization server or the bearer guard on `/mcp`, leakage of `AVITO_MCP_OAUTH_OWNER_PASSWORD` / issued tokens / `AVITO_MCP_HTTP_AUTH_TOKEN`, DNS-rebinding attacks, and — on the 2025-11-25 leg, which still has sessions — hijacking of a `Mcp-Session-Id`.
- **State handle hijacking** on either leg: a way to obtain, guess or replay a `confirmation_id` that you were not given. See [the 2026-07-28 threat model](#what-revision-2026-07-28-changed-about-the-threat-model) — on that revision handles are what sessions used to be, and they are the thing worth attacking.
- **The webhook receiver**: leakage of `AVITO_MCP_WEBHOOK_SECRET`, or ways to read or forge buffered events without the secret.
- Confirmed vulnerable dependencies (with an exploit path through how we use them).

## Not in scope

- Avito API behaviour itself — rate limits, scope restrictions, deprecations. Report those to Avito support.
- Bugs in the MCP client (Claude Desktop, Cursor, etc.) — report to that project.
- A user accidentally pasting their own token somewhere public — that's a credential rotation problem, rotate it.

## What revision 2026-07-28 changed about the threat model

This server speaks two revisions of MCP on the same endpoint and in the same process
(`AVITO_MCP_PROTOCOL_ERA` — `legacy`, `dual`, `modern`; both READMEs document the selector). The
2025-11-25 leg is unchanged and its threat model is unchanged with it. The 2026-07-28 leg removed
protocol sessions altogether, and that moves several things this file used to take for granted.

### There is no session, so caller identity comes from the request

`initialize`, `Mcp-Session-Id` and session state are gone from the revision. An inbound
`Mcp-Session-Id` is ignored rather than rejected, and the server mints none. Nothing on this leg
identifies a caller by remembering a previous request.

Identity is derived per request, in `callerPrincipal()` (`src/core/pending-actions.ts`), from what
the request itself carries, in this order:

1. `oauth:<client_id>` — the `client_id` of the access token this deployment's own authorization
   server issued and verified for this request (`AVITO_MCP_HTTP_AUTH=oauth`). This is the only
   branch backed by an authentication event.
2. `bearer:<sha256 of the token>` — the shared secret of `AVITO_MCP_HTTP_AUTH=bearer`, fingerprinted
   rather than stored. It separates *this secret* from *another secret*; it does not identify a
   person, and everyone holding the same secret is the same principal.
3. `session:local-stdio` — the fallback when the request carries no credential at all: stdio, and
   HTTP under `AVITO_MCP_HTTP_AUTH=none`. On the 2026 leg the session id that once fed this branch
   is always absent, so the name is now a label for "the operator who started this process", and
   under `none` **every caller shares it**. That is the reason `none` is a development mode.

Consequences worth reporting: a request whose token verifies as one `client_id` being attributed to
another; a request with no credential being attributed to anything other than the local principal;
the `bearer` fingerprint appearing anywhere in a log, a resource or a result.

### State handle hijacking replaces session hijacking

The revision's replacement for session-scoped state is an explicit, server-minted handle passed as
an ordinary tool argument (SEP-2567). This server already worked that way before the revision
required it: the two-step confirmation for money- and public-risk tools mints a `confirmation_id`
and `meta_confirm_action` takes it back as a normal argument. It survives the removal of sessions
without a change, and it is now the object an attacker wants.

What bounds it today:

- **128 bits of entropy**, `randomBytes(16)` (`src/core/pending-actions.ts`) — not derived from the
  tool name, the arguments or a counter.
- **A short life.** `AVITO_MCP_CONFIRMATION_TTL_SEC`, default 900 seconds, capped at 24 hours.
- **One shot.** The pending record is claimed atomically under a file lock before the executor
  runs, so two concurrent callers presenting the same handle produce exactly one operation.
- **A per-principal budget** on hard-confirmation attempts, keyed by `callerPrincipal()` and not by
  a connection, so exhausting it cannot be dodged by reconnecting.
- **An out-of-band factor when configured.** `AVITO_MCP_CONFIRMATION_SECRET` requires a value that
  never travelled over MCP, and `AVITO_MCP_APPROVAL_MODE=external` refuses a confirmation from the
  same identity that created the action.

**Possession of a handle is not authentication, and this server does not pretend otherwise.**
SEP-2567's guidance for authenticated servers is to validate the pair `(handle, auth context)` on
every call; this server validates the handle and re-evaluates the safety policy, but does **not**
require the confirming principal to be the one that minted the handle. That is deliberate and has a
cost: a handle minted on the modern leg is confirmable on the legacy leg of the same process, which
is what makes `dual` a single server rather than two, and a caller who obtains someone else's
`confirmation_id` within its TTL — and who is already authorized to reach `/mcp` at all — can spend
it. The mitigation for a deployment that cannot accept that is not a code change but a
configuration: set `AVITO_MCP_CONFIRMATION_SECRET`, which possession of the handle can never
satisfy.

So a report that a handle leaked into a log, that it is predictable, that a claimed or expired
handle can still be spent, or that the per-principal budget can be reset by reconnecting, is a
vulnerability. A report that "whoever holds the id can confirm" is the documented design above.

### The four server MUSTs, and where each one lives

The revision states four obligations for a server that exposes tools: *validate all tool inputs*,
*implement proper access controls*, *rate limit tool invocations*, *sanitize tool outputs*. Named
here so a report can be aimed at the module that is supposed to be holding the line:

| Obligation | Implemented in | What "broken" looks like |
| --- | --- | --- |
| Validate all tool inputs | Per-tool zod schemas in `src/core/tool-factory.ts`; `src/core/upload-guard.ts` for the one tool that reads files from disk | An argument reaching Avito, the filesystem or a shell without passing its schema; a path escaping `AVITO_MCP_ALLOWED_UPLOAD_DIRS` via a symlink or a traversal |
| Implement proper access controls | `src/core/policy.ts` — `read_only` / `guarded` / `full_access`, plus allow/deny lists. A blocked tool is never registered, so it is absent from `tools/list` rather than refused at call time | A tool the active mode forbids being callable, listed, or reachable through the confirmation replay path |
| Rate limit tool invocations | `src/core/rate-limiter.ts` — a durable budget shared across processes through a locked state file; slots are released when a call is cancelled | A caller spending budget that is never returned, or bypassing the shared file by running a second process |
| Sanitize tool outputs | `src/resources.ts` (`sanitizeConfig` and a recursive redaction sweep for `avito://state/config`), `src/logger.ts` (pino redact paths), and `src/core/client.ts`, which mints this server's own Avito token and never forwards a caller's `Authorization` header | Any credential, token or `Client_secret` appearing in a tool result, an MCP resource or a log line |

Cache hints do not stand in for any of this: the revision is explicit that `cacheScope` alone must
not be relied on to keep a primitive from an unauthorized reader, and no account-scoped URI on this
server is published as `"public"`.

### New surface the revision added

Three things exist on the 2026 leg that did not exist before, and each of them is attacker-reachable:

- **`subscriptions/listen`** replaces `resources/subscribe` and the HTTP GET stream. A client sends
  a filter; the server narrows it to what it can actually deliver (`src/core/subscriptions.ts`) and
  acknowledges only the honoured subset. A stream that delivers a notification type the filter did
  not ask for, or that carries another caller's events, is in scope.
- **The per-request `_meta` envelope** carries the protocol version and the client's capabilities on
  every single request. It is attacker-controlled input on the hottest path in the server, and it is
  validated before dispatch: a missing or wrong-typed key is `-32602`, a header disagreeing with the
  body is `-32020`, an undeclared capability is `-32021`, an unknown revision is `-32022`, each with
  an HTTP 4xx. Any envelope that produces a 500, or that gets served without validation, is in scope.
- **Quantitative limits instead of a session table.** With sessions gone, `AVITO_MCP_HTTP_MAX_SESSIONS`
  and `AVITO_MCP_HTTP_SESSION_IDLE_SEC` bound nothing on this leg; `AVITO_MCP_HTTP_MAX_INFLIGHT`
  (default 64) bounds concurrent `/mcp` exchanges and `AVITO_MCP_HTTP_MAX_STREAMS` (default 32)
  bounds how many of those may be long-lived subscription streams, so streams cannot starve tool
  calls. Beyond either, the server answers `503` with `Retry-After`. A way to hold a slot or a
  stream that is never returned — in particular after the client hangs up — is a denial-of-service
  report and is in scope.

### The stdio trust boundary

Over `AVITO_MCP_TRANSPORT=stdio` there is no authentication, and there never was one to remove: the
peer is whoever started the process, the credentials are the ones in that process's environment, and
`callerPrincipal()` returns a single principal for everything. This is the intended deployment for a
local MCP client, and it is **not** a boundary you can put an untrusted party behind. If a caller
you do not fully trust needs access, run the HTTP transport with `AVITO_MCP_HTTP_AUTH=oauth` and let
the authorization server be the boundary. "A local MCP client could call a tool" is therefore not a
vulnerability; "a message from that client escapes into arbitrary code execution, or reads a file
outside `AVITO_MCP_ALLOWED_UPLOAD_DIRS`" very much is.

One limitation on stdio is known and not fixable from this repository: the SDK's stdio entry decides
a connection's era from its first classifiable message and holds that decision for the life of the
connection, so an operator cannot infer the served era from configuration alone. It is a
compatibility limitation rather than an authorization one — stdio carries no authorization to
downgrade — and the analysis, the diagnostic we ship instead, and the conditions that would reopen
it are recorded in [`docs/adr/0001-protocol-era-limitations.md`](docs/adr/0001-protocol-era-limitations.md).

## Operational notes for the remote HTTP surface

### `bearer` and `none` do not claim MCP authorization conformance

Only `AVITO_MCP_HTTP_AUTH=oauth` implements the MCP authorization specification. `bearer` is a shared-secret guard and `none` is no guard at all; neither publishes RFC 9728 protected-resource metadata, neither runs an authorization server, and the challenge on a rejected request is a bare `Bearer realm="avito-mcp"` with no `resource_metadata` parameter. An MCP client written against revision 2026-07-28 therefore cannot discover an authorization server from these modes and cannot complete a flow it is required to initiate itself.

This is a deliberate scope decision, not an oversight: `bearer` exists for a caller you configure by hand with a secret you generated, and publishing discovery metadata for an authorization server that does not exist would be worse than publishing none. **Use `oauth` for MCP clients.** A report that `bearer` lacks OAuth discovery is not a vulnerability; a report that `bearer` accepts a token it was not given, or that `oauth` can be bypassed, very much is.

### `AVITO_MCP_HTTP_PUBLIC_URL` is the OAuth issuer identifier

In `AVITO_MCP_HTTP_AUTH=oauth` this value is not a display string. It becomes the **issuer identifier** in `/.well-known/oauth-authorization-server`, the `resource` every access token is bound to, and the base of the endpoints clients POST their authorization code to. Three consequences:

- **It must be `https`.** Cleartext is accepted only for `localhost` / `127.0.0.1` / `[::1]`; startup fails otherwise. The development override `AVITO_MCP_HTTP_ALLOW_INSECURE_PUBLIC_URL=1` exists, and the SDK's own issuer check still requires `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true` on top of it. Do not use either in production.
- **Changing it is changing authorization servers.** A client that recorded the old issuer is required to treat the new one as a different server. Registered clients and issued tokens in `AVITO_MCP_OAUTH_STORE_FILE` are therefore discarded on the first start under a new public URL (logged as `issuer identifier changed`), and every client re-registers and re-authorizes. Plan the change like a credential rotation, not like a rename.
- **Clients compare it byte for byte.** The `iss` parameter on the authorization response and the `issuer` in the metadata document are the same string, trailing slash included; a conformant client may not normalise either side before comparing. If you put avito-mcp behind a proxy, do not let the proxy rewrite the host or the scheme.

### Registration is Dynamic Client Registration; CIMD is deliberately not implemented

Revision 2026-07-28 deprecates DCR in favour of Client ID Metadata Documents, in which the client
presents a URL and the authorization server fetches the metadata from it. That is a SHOULD, and this
deployment does not follow it: fetching a URL supplied by an unauthenticated stranger turns our
authorization server into an SSRF primitive aimed at whatever the host can reach, which on this host
includes a local network. The decision is recorded as an open item of the migration plan (M8.3)
rather than as a silence, and it will be revisited when clients actually stop supporting DCR — DCR's
earliest removal is a revision on or after 2027-07-28.

So `POST /register` stays open, and the hardening is on it (`src/http/oauth/provider.ts`,
`src/http/oauth/index.ts`):

- The request body is capped at 32 KiB by the JSON parser and the serialized metadata at 32 KiB
  again before it reaches the store; every string field has its own byte limit.
- `redirect_uris` must hold between 1 and 10 entries of at most 2048 bytes, each of them `https`, or
  `http` on a loopback host. No fragments, no wildcards, no private-use URI schemes — a
  reverse-domain ownership rule cannot be established at an unauthenticated endpoint, so loopback is
  the supported native-client redirect. At `/authorize` the match is exact.
- `application_type` is read rather than ignored: `web` requires a non-loopback `https` redirect, and
  `native` is treated as a public client, so no `client_secret` is minted for a binary that ships to
  end-user devices and cannot keep one.
- `POST /authorize/approve` is rate-limited to 10 attempts per 15 minutes per IP, and the owner
  password is compared in constant time.
- Registered clients and their secrets are discarded whenever the issuer identifier changes (see
  above), so a registration never outlives the authorization server it was made against.

A way to register a client whose redirect does not satisfy these rules, to get a `client_secret` for
a `native` client, or to make `/register` perform an outbound request, is in scope.

### `AVITO_MCP_OAUTH_STORE_FILE` holds tokens in cleartext — accepted risk

If you enable the durable OAuth store, issued access tokens, refresh tokens and self-registered `client_secret` values are written to that file **as they are**: the token strings are object keys, the secret is a plain field. They are not hashed and not encrypted.

The file is created `0600` in a `0700` directory and is written atomically under an exclusive process lease, so the people who can read it are `root`, the service account avito-mcp runs as, and anyone holding a backup or container layer that contains it. The first two can already read `AVITO_MCP_OAUTH_OWNER_PASSWORD` from the process environment and mint fresh tokens whenever they like, so hashing removes nobody from that list. Access tokens expire in an hour by default, refresh tokens in 30 days, all are revocable, and all are discarded when the issuer identifier changes.

The reasoning and the conditions that would reverse this decision are in [`docs/adr/0006-token-storage.md`](docs/adr/0006-token-storage.md) — the short version is that it stops being an accepted risk the moment any long-lived machine-to-machine credential lives in this store, or the file leaves the host's private state directory. **Reports are in scope** if the file is created with wider permissions than described, if its contents reach a log or an MCP resource, or if another local user can read it.

## Disclosure

Standard coordinated disclosure: please give us a reasonable window to ship a fix before discussing the issue publicly. After a patched version is on npm, write about it however you like.

---

Not a security issue? Use [regular GitHub Issues](https://github.com/elchin92/avito-mcp/issues).
