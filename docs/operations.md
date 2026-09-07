# Operations and protocol reference

[Documentation](README.md) · [Русская версия](operations.ru.md) · [Client setup](clients.md)

## Resources and prompts

Resources expose local server data without an Avito API call. Two are subscribable; an external agent can use their notifications as inputs to an event-driven workflow.

| URI                             | What it holds                                                  |
| ------------------------------- | -------------------------------------------------------------- |
| `avito://docs/safety`           | Safety modes, confirmation flow, ready-to-paste configurations |
| `avito://manifest`              | The live tool catalogue — risk, domain, title, annotations     |
| `avito://state/config`          | Snapshot of the active configuration, secrets redacted         |
| `avito://state/rate-limits`     | Latest `X-RateLimit-*` seen per Avito domain                   |
| `avito://state/pending-actions` | Pending actions awaiting confirmation — **subscribable**       |
| `avito://webhook/events`        | Buffered Avito chat events — **subscribable**                  |
| `avito://swaggers/{slug}`       | One resource per bundled specification, with completion        |

Prompts provide instructions for a workflow. The MCP client reads those instructions and decides which tools to call; invoking a prompt does not execute the workflow.

| Prompt                     | Arguments                  | What it does                                                    |
| -------------------------- | -------------------------- | --------------------------------------------------------------- |
| `avito_daily_overview`     | `days?` (1–270; default 7) | Balance, active listings, spendings — read-only                 |
| `avito_check_unread_chats` | `limit?` (default 20)      | Triage unread chats, with an explicit "do not send" instruction |
| `avito_promote_item`       | `item_id`                  | Everything needed before a paid VAS purchase, and no purchase   |
| `avito_explain_tool`       | `tool_name`                | One tool's manifest entry cross-referenced with its swagger     |
| `avito_safety_report`      | —                          | Current safety modes and limits                                 |

Selected server events — mode changes, hidden-tool reports, the confirmation lifecycle, rate-limit
warnings — are forwarded to the client as `notifications/message` with sensitive fields censored.
Pino logging to stderr is unaffected.

---

## Remote MCP over HTTP (OAuth 2.1)

stdio is the default for a local client. Use Streamable HTTP when a hosted agent or several clients need the same account. OAuth uses an authorization code with PKCE, dynamic client registration and an owner approval page.

```bash
AVITO_MCP_TRANSPORT=http                            # stdio (default) | http | both
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com   # your TLS domain, keep this issuer URL stable
AVITO_MCP_OAUTH_OWNER_PASSWORD=…                    # required, random, at least 32 bytes
# Client_id / Client_secret / Profile_id as usual — the account the server acts for
```

A client discovers the authorization server from the 401 on `/mcp`, registers itself at
`/register`, and opens `/authorize` in a browser. Approval requires the owner password; the endpoint rate-limits attempts. Approved clients exchange an authorization code and may refresh tokens within their lifetime. Tokens are bound to
the exact `avito:mcp` scope and this deployment's exact resource URL. Legacy sessions are tied to
the principal that opened them; modern requests carry authorization independently. `both` runs stdio and HTTP in one process.

| Endpoint                                    | What it is                                                    |
| ------------------------------------------- | ------------------------------------------------------------- |
| `/mcp`                                      | The MCP transport                                             |
| `/authorize`                                | Consent screen — the owner password goes here                 |
| `/token` · `/register` · `/revoke`          | Token exchange, dynamic registration (RFC 7591), revocation   |
| `/.well-known/oauth-authorization-server`   | Authorization server metadata                                 |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata, path-suffixed per RFC 9728                 |
| `/healthz` · `/readyz`                      | Liveness and readiness, unauthenticated, `{ok}`-shaped bodies |

| Variable                                    | Default              | Meaning                                                                                                               |
| ------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AVITO_MCP_TRANSPORT`                       | `stdio`              | `stdio` \| `http` \| `both` (CLI: `--http`, `--both`)                                                                 |
| `AVITO_MCP_HTTP_HOST` / `_PORT`             | `127.0.0.1` / `3000` | Bind address and port. Keep it loopback and let a proxy face the internet                                             |
| `AVITO_MCP_HTTP_PUBLIC_URL`                 | —                    | The OAuth issuer identifier. Changing it is a new authorization server: clients re-register, tokens are dropped       |
| `AVITO_MCP_HTTP_AUTH`                       | `oauth`              | `oauth` \| `bearer` \| `none`                                                                                         |
| `AVITO_MCP_OAUTH_OWNER_PASSWORD`            | —                    | Required in `oauth` mode, at least 32 bytes. Protects the owner approval page                                         |
| `AVITO_MCP_OAUTH_TOKEN_TTL_SEC`             | `3600`               | Lifetime of an issued bearer token                                                                                    |
| `AVITO_MCP_OAUTH_STORE_FILE`                | —                    | Durable client/token store. Exclusive lease — one running server per file                                             |
| `AVITO_MCP_HTTP_AUTH_TOKEN`                 | —                    | `bearer` mode: comma-separated shared secrets, each at least 32 bytes                                                 |
| `AVITO_MCP_HTTP_ALLOWED_HOSTS` / `_ORIGINS` | derived              | DNS-rebinding protection. Derived fail-closed; an under-specified wildcard bind refuses to start                      |
| `AVITO_MCP_HTTP_ALLOW_INSECURE_PUBLIC_URL`  | `0`                  | Development only. Cleartext issuer on a routable host; the SDK also wants `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` |
| `AVITO_MCP_HTTP_ALLOW_NO_AUTH`              | `0`                  | Permit `auth=none` off loopback. Discouraged, and it means what it says                                               |
| `AVITO_MCP_HTTP_MAX_SESSIONS`               | `100`                | **Legacy revision only** (2025-11-25 has sessions). Concurrent sessions; `initialize` beyond it gets a 503            |
| `AVITO_MCP_HTTP_SESSION_IDLE_SEC`           | `1800`               | **Legacy revision only.** Idle sessions past this are reaped — clients that vanished without a `DELETE`               |
| `AVITO_MCP_HTTP_MAX_INFLIGHT`               | `64`                 | Revision 2026-07-28, which has no sessions: concurrent `/mcp` exchanges before `503` + `Retry-After`                  |
| `AVITO_MCP_HTTP_MAX_STREAMS`                | `32`                 | How many of those may be long-lived subscription streams, so streams cannot starve ordinary calls                     |

Node binds loopback and speaks plain HTTP; TLS is the reverse proxy's job. Never publish port 3000
directly. Preserve the intended host and scheme; configure the public issuer with `AVITO_MCP_HTTP_PUBLIC_URL`.

<details>
<summary>Caddy and nginx snippets for <code>https://mcp.example.com</code></summary>

```caddyfile
mcp.example.com {
    # Caddy handles certificates and preserves Host by default.
    reverse_proxy 127.0.0.1:3000
}
```

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location ~ ^/(mcp|\.well-known/oauth-|authorize|token|register|revoke|avito/webhook|healthz|readyz) {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;             # preserve the public host
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;                    # Streamable HTTP holds responses open
        proxy_read_timeout 3600s;
    }
}
```

</details>

`AVITO_MCP_HTTP_AUTH=bearer` is available for a manually configured caller. It and `none` do not implement MCP authorization discovery: they expose no authorization server or protected-resource metadata. Use `oauth` for clients that need to discover and complete the authorization flow. The built-in authorization helper is a [transitional dependency](adr/0004-own-authorization-server.md); version 2.1.1 preserves the existing consent and token-store behavior.

---

## Avito webhook receiver

The optional webhook receiver buffers incoming events for the agent to read. Avito needs a public HTTPS delivery URL. The receiver can run with stdio: enabling it starts an HTTP listener for webhooks without exposing an HTTP MCP endpoint.

```bash
AVITO_MCP_WEBHOOK_SECRET=…                            # random, at least 32 bytes
AVITO_MCP_WEBHOOK_PUBLIC_URL=https://mcp.example.com  # defaults to the HTTP public URL
# AVITO_MCP_WEBHOOK_PATH=/avito/webhook               # AVITO_MCP_WEBHOOK_BUFFER=100
# AVITO_MCP_WEBHOOK_LOG_FILE=/var/lib/avito-mcp/webhook-events.jsonl
```

Avito then delivers to `{PUBLIC_URL}{PATH}/{SECRET}`, answered `200 {"ok":true}` well inside
the configured response deadline. The secret is a path segment, which is the receiver authentication factor:
the URL is unguessable, it must be public HTTPS, and 32 random bytes is the floor. Both registration
tools accept only the receiver URL derived from operator configuration, so an agent cannot point
future messages at a host of its choosing, and dry-run output redacts the secret.

Keep receiver URLs out of proxy logs. The [Caddy example](../deploy/Caddyfile.example) excludes the webhook path from access logs, but error logs can still include paths during an upstream failure. Review both and keep journals private.

Read the events with `messenger_get_webhook_events` (filters: `chat_id`, `since`, `limit`) or
subscribe to `avito://webhook/events` and be notified as they land. `messenger_get_webhook_status`
reports what the buffer holds. The optional log file is `0600`, contains normalized metadata only —
no message text, no raw payload — rotates at 10 MiB and keeps one backup.

---

## Operating it

```bash
avito-mcp --readonly        # AVITO_MCP_MODE=read_only          --guarded
avito-mcp --dry-run         # AVITO_MCP_DRY_RUN_DEFAULT=true    --no-confirmation
avito-mcp --http           # AVITO_MCP_TRANSPORT=http; --both enables both transports
avito-mcp --health          # print a JSON health snapshot and exit
avito-mcp --version
avito-mcp --help
```

Flags set environment defaults, and the variable wins if both are set. Everything else
is an environment variable; `--help` lists them all, and so does [.env.example](../.env.example).

`--health` is a configuration diagnostic, not a liveness probe — it does not talk to a running
process. For Kubernetes or a supervisor, probe `/readyz`, which returns 200 only while the listener
is open, HTTP-mode credentials are complete, the token and runtime-state directories are writable,
the OAuth store lease is healthy and webhook persistence has not failed. Its body stays `{"ok":…}`.

Environment parsing is fail-fast by design: an unknown enum value, a partially numeric limit, a
weak remote secret or an out-of-range number stops startup instead of falling back to a default you
did not choose. Correct the reported setting before restarting.

---

## Deploy as a systemd service

For a Linux host using systemd, prepare `.remote.env` with the HTTP settings and Avito credentials, run `npm run verify:release`, then run `sudo deploy/install-services.sh --start` from the source checkout. Review [the installer](../deploy/install-services.sh) and [environment settings](../.env.example) before starting it.

The installer creates a restricted service account, a root-owned `/etc/avito-mcp/avito-mcp.env`, and a release under `/opt/avito-mcp/releases/<version>`. It switches the `current` symlink atomically and checks readiness and the deployed version. Deployments are serialized with `flock`; failures restore the previous release, configuration and service state. Changed code under an unchanged version number is not a new release: bump the version before redeploying it.

## Protocol and compatibility

This section is for operators and client implementers. The default remains legacy in 2.1.1. Correctness fixes introduced in 2.1.0 apply to both revisions; see [CHANGELOG](../CHANGELOG.md).

### Protocol revisions

`AVITO_MCP_PROTOCOL_ERA` selects which MCP revisions a process serves: `legacy` (the default —
2025-11-25 only, preserving the 1.3.x protocol surface with the documented 2.1.0 correctness fixes), `dual` (both), `modern` (2026-07-28 only). An
unrecognised value fails startup rather than falling back, because a typo in the variable that
decides which protocol your clients get should not be survivable in silence.

|                     | 2025-11-25                                       | 2026-07-28                                                              |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Handshake           | `initialize`                                     | none — `server/discover` and a per-request `_meta` envelope             |
| Watching a resource | `resources/subscribe`                            | `subscriptions/listen` with `resourceSubscriptions`, acknowledged first |
| Subscribable URIs   | pending actions, webhook events                  | the same two                                                            |
| `listChanged`       | advertised `true`                                | advertised `false`; sets are static                                     |
| List verbs          | one answer (≈225 KB), `cursor` ignored           | paginated at 48 KiB per page; an unminted cursor is `-32602`            |
| Prompt arguments    | legacy validation; daily overview period bounded | allowlists, bounded integers, control and bidi characters refused       |
| Log level           | `logging/setLevel` per connection                | that method is removed; the level is declared per request in `_meta`    |
| Cancelling a call   | `notifications/cancelled`                        | that, or closing the response stream                                    |

`listChanged` differs deliberately. This server's tool, prompt and resource sets are fixed for the
life of the process, so no `list_changed` notification is ever sent. On 2025-11-25 the advertised
`true` is inert and kept for wire compatibility. On 2026-07-28 it is not inert — `subscriptions/listen`
narrows a client's filter against exactly those bits, so `true` would acknowledge a subscription to
updates that never arrive and leave the client waiting instead of polling.

Tool schemas are emitted as JSON Schema draft-07 on both revisions. 2026-07-28 permits 2020-12 but
does not require it, the two dialects render identical bodies for this catalogue, and
`meta_capabilities.schemaHash` is computed over the schemas as emitted — so moving the dialect would
break every consumer watching that hash for drift. No schema references a network URI.

> **On stdio the revision is decided once per connection.** There is no header layer, so the SDK
> reads it from the first classifiable message and holds it for the life of the connection. Under
> `dual`, a 2026 client whose opening frame carries no `_meta` envelope is served as a 2025 client
> until it reconnects, even if every later frame carries one. The server writes one
> `protocol era pinned to legacy` line to stderr when that happens, naming the method that pinned
> it — grep for it while rolling out. The fix is client-side: send
> `io.modelcontextprotocol/protocolVersion` in `params._meta` on the first message. HTTP is
> unaffected, since every request is classified on its own. Why we accept this instead of forking
> the SDK entry point: [ADR 0001](../docs/adr/0001-protocol-era-limitations.md).

> **Cancellation applies to both revisions.** Before dispatch it releases the reservation; after dispatch it holds the key under the cancellation TTL. A transport failure with an unknown outcome uses an indefinite hold. See [recovery guidance](safety.md#lost-responses-after-a-mutation-v21).

### Versioning

The project follows [SemVer](https://semver.org). Tool names, documented valid inputs, environment names and defaults, resource URIs, prompts, risk rules, error types and CLI flags are public contracts.

| Change                                                | Release type |
| ----------------------------------------------------- | ------------ |
| Incompatible public contract                          | Major        |
| Additive tools, opt-in settings, resources or prompts | Minor        |
| Compatible fixes and documentation                    | Patch        |

Correctness or security fixes may tighten invalid inputs, anti-abuse bounds, understated risk or unsafe configuration. They must preserve documented Avito-valid calls unless that behavior is itself the vulnerability. Each tightening needs explicit changelog and migration guidance. Dropping an end-of-life Node.js line must also be documented.

For version-specific changes, use the [upgrade guide](../MIGRATION.md).
