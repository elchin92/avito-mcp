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
- **The remote HTTP surface** (`AVITO_MCP_TRANSPORT=http|both`): bypasses of the OAuth 2.1 authorization server or the bearer guard on `/mcp`, leakage of `AVITO_MCP_OAUTH_OWNER_PASSWORD` / issued tokens / `AVITO_MCP_HTTP_AUTH_TOKEN`, DNS-rebinding or session-hijacking attacks on the Streamable HTTP transport.
- **The webhook receiver**: leakage of `AVITO_MCP_WEBHOOK_SECRET`, or ways to read or forge buffered events without the secret.
- Confirmed vulnerable dependencies (with an exploit path through how we use them).

## Not in scope

- Avito API behaviour itself — rate limits, scope restrictions, deprecations. Report those to Avito support.
- Bugs in the MCP client (Claude Desktop, Cursor, etc.) — report to that project.
- A user accidentally pasting their own token somewhere public — that's a credential rotation problem, rotate it.

## Operational notes for the remote HTTP surface

### `bearer` and `none` do not claim MCP authorization conformance

Only `AVITO_MCP_HTTP_AUTH=oauth` implements the MCP authorization specification. `bearer` is a shared-secret guard and `none` is no guard at all; neither publishes RFC 9728 protected-resource metadata, neither runs an authorization server, and the challenge on a rejected request is a bare `Bearer realm="avito-mcp"` with no `resource_metadata` parameter. An MCP client written against revision 2026-07-28 therefore cannot discover an authorization server from these modes and cannot complete a flow it is required to initiate itself.

This is a deliberate scope decision, not an oversight: `bearer` exists for a caller you configure by hand with a secret you generated, and publishing discovery metadata for an authorization server that does not exist would be worse than publishing none. **Use `oauth` for MCP clients.** A report that `bearer` lacks OAuth discovery is not a vulnerability; a report that `bearer` accepts a token it was not given, or that `oauth` can be bypassed, very much is.

### `AVITO_MCP_HTTP_PUBLIC_URL` is the OAuth issuer identifier

In `AVITO_MCP_HTTP_AUTH=oauth` this value is not a display string. It becomes the **issuer identifier** in `/.well-known/oauth-authorization-server`, the `resource` every access token is bound to, and the base of the endpoints clients POST their authorization code to. Three consequences:

- **It must be `https`.** Cleartext is accepted only for `localhost` / `127.0.0.1` / `[::1]`; startup fails otherwise. The development override `AVITO_MCP_HTTP_ALLOW_INSECURE_PUBLIC_URL=1` exists, and the SDK's own issuer check still requires `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true` on top of it. Do not use either in production.
- **Changing it is changing authorization servers.** A client that recorded the old issuer is required to treat the new one as a different server. Registered clients and issued tokens in `AVITO_MCP_OAUTH_STORE_FILE` are therefore discarded on the first start under a new public URL (logged as `issuer identifier changed`), and every client re-registers and re-authorizes. Plan the change like a credential rotation, not like a rename.
- **Clients compare it byte for byte.** The `iss` parameter on the authorization response and the `issuer` in the metadata document are the same string, trailing slash included; a conformant client may not normalise either side before comparing. If you put avito-mcp behind a proxy, do not let the proxy rewrite the host or the scheme.

## Disclosure

Standard coordinated disclosure: please give us a reasonable window to ship a fix before discussing the issue publicly. After a patched version is on npm, write about it however you like.

---

Not a security issue? Use [regular GitHub Issues](https://github.com/elchin92/avito-mcp/issues).
