# Operations and protocol reference

[README](../README.md) · [Client setup](clients.md)

## Resources and prompts

Resources expose local server data without an Avito API call. Two are subscribable; an external agent can use their notifications as inputs to an event-driven workflow.

| URI                             | What it holds                                                  |
| ------------------------------- | -------------------------------------------------------------- |
| `avito://docs/safety`           | Safety modes, confirmation flow, ready-to-paste configurations |
| `avito://manifest`              | The live tool catalogue — risk, domain, title, annotations     |
| `avito://state/config`          | Snapshot of the active configuration, secrets redacted         |
| `avito://state/rate-limits`     | Latest `X-RateLimit-*` seen per Avito domain                   |
| `avito://state/pending-actions` | Confirmations waiting for someone — **subscribable**           |
| `avito://webhook/events`        | Buffered Avito chat events — **subscribable**                  |
| `avito://swaggers/{slug}`       | One resource per bundled specification, with completion        |

Prompts are canned workflows that call the right tools in the right order, with the guard rails
written into the prompt text rather than left to the model's judgement.

| Prompt                     | Arguments             | What it does                                                    |
| -------------------------- | --------------------- | --------------------------------------------------------------- |
| `avito_daily_overview`     | `days?` (default 7)   | Balance, active listings, spendings — read-only                 |
| `avito_check_unread_chats` | `limit?` (default 20) | Triage unread chats, with an explicit "do not send" instruction |
| `avito_promote_item`       | `item_id`             | Everything needed before a paid VAS purchase, and no purchase   |
| `avito_explain_tool`       | `tool_name`           | One tool's manifest entry cross-referenced with its swagger     |
| `avito_safety_report`      | —                     | The server describing its own posture back to you               |

Selected server events — mode changes, hidden-tool reports, the confirmation lifecycle, rate-limit
warnings — are forwarded to the client as `notifications/message` with sensitive fields censored.
Pino logging to stderr is unaffected.

---

## Remote MCP over HTTP (OAuth 2.1)

stdio is the default and the right answer for one person on one laptop. When several clients, a
hosted agent, or a phone need the same account, the same 148 tools are served over Streamable HTTP
behind OAuth 2.1 — authorization code with PKCE, dynamic client registration, and a consent screen
that a human has to get past.

```bash
AVITO_MCP_TRANSPORT=http                            # stdio (default) | http | both
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com   # your TLS domain, no trailing slash
AVITO_MCP_OAUTH_OWNER_PASSWORD=…                    # required, random, at least 32 bytes
# Client_id / Client_secret / Profile_id as usual — the account the server acts for
```

A client discovers the authorization server from the 401 on `/mcp`, registers itself at
`/register`, and opens `/authorize` in a browser. The owner password entered on that page is the
only thing that mints a token; the endpoint is rate-limited against guessing. Tokens are bound to
the exact `avito:mcp` scope and this deployment's exact resource URL, and each session is tied to
the principal that opened it. `both` runs stdio and HTTP in one process.

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
| `AVITO_MCP_OAUTH_OWNER_PASSWORD`            | —                    | Required in `oauth` mode, at least 32 bytes. The only secret that issues a token                                      |
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
directly. Preserve the `Host` header — the OAuth metadata is built from it.

<details>
<summary>Caddy and nginx snippets for <code>https://mcp.example.com</code></summary>

```caddyfile
mcp.example.com {
    # Caddy handles certificates and preserves Host by default.
    reverse_proxy /mcp* /authorize* /token* /register* /revoke* /healthz* /readyz* \
                  /.well-known/oauth-* /avito/webhook* http://127.0.0.1:3000
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
        proxy_set_header   Host $host;             # OAuth metadata is built from this
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;                    # Streamable HTTP holds responses open
        proxy_read_timeout 3600s;
    }
}
```

</details>

If you control both ends and the full flow is overkill, `AVITO_MCP_HTTP_AUTH=bearer` with a shared
secret works. Be clear about what you are giving up: **`bearer` and `none` do not claim conformance
with the MCP authorization specification.** Neither publishes protected-resource metadata, neither
runs an authorization server, and the 401 is a bare `Bearer realm="avito-mcp"` — an MCP client
cannot discover where to authorize and will not complete a flow it has to start itself. Use `oauth`
for MCP clients; `bearer` is for a caller you configure by hand.

---

## Avito webhook receiver

Polling for new chats works, but an agent that answers within seconds needs the events pushed to
it. The server ships a receiver: give Avito a secret URL and every event is buffered for the agent
to read. This works in pure stdio mode too — Avito needs a public URL to POST to, and your MCP
client never touches it. When a webhook secret is set under `AVITO_MCP_TRANSPORT=stdio`, a small
HTTP listener starts for the receiver alone.

```bash
AVITO_MCP_WEBHOOK_SECRET=…                            # random, at least 32 bytes
AVITO_MCP_WEBHOOK_PUBLIC_URL=https://mcp.example.com  # defaults to the HTTP public URL
# AVITO_MCP_WEBHOOK_PATH=/avito/webhook               # AVITO_MCP_WEBHOOK_BUFFER=100
# AVITO_MCP_WEBHOOK_LOG_FILE=/var/lib/avito-mcp/webhook-events.jsonl
```

Avito then delivers to `{PUBLIC_URL}{PATH}/{SECRET}`, answered `200 {"ok":true}` well inside
Avito's two-second deadline. The secret is a path segment, which is the whole authentication story:
the URL is unguessable, it must be public HTTPS, and 32 random bytes is the floor. Both registration
tools accept only the receiver URL derived from operator configuration, so an agent cannot point
future messages at a host of its choosing, and dry-run output redacts the secret.

Read the events with `messenger_get_webhook_events` (filters: `chat_id`, `since`, `limit`) or
subscribe to `avito://webhook/events` and be notified as they land. `messenger_get_webhook_status`
reports what the buffer holds. The optional log file is `0600`, contains normalized metadata only —
no message text, no raw payload — rotates at 10 MiB and keeps one backup.

---

## Operating it

```bash
avito-mcp --readonly        # AVITO_MCP_MODE=read_only          --guarded
avito-mcp --dry-run         # AVITO_MCP_DRY_RUN_DEFAULT=true    --no-confirmation
avito-mcp --http | --both   # AVITO_MCP_TRANSPORT=http | both
avito-mcp --health          # print a JSON health snapshot and exit
avito-mcp --version | --help
```

Flags are sugar over environment variables, and the variable wins if both are set. Everything else
is an environment variable; `--help` lists them all, and so does [.env.example](../.env.example).

`--health` is a configuration diagnostic, not a liveness probe — it does not talk to a running
process. For Kubernetes or a supervisor, probe `/readyz`, which returns 200 only while the listener
is open, HTTP-mode credentials are complete, the token and runtime-state directories are writable,
the OAuth store lease is healthy and webhook persistence has not failed. Its body stays `{"ok":…}`.

Environment parsing is fail-fast by design: an unknown enum value, a partially numeric limit, a
weak remote secret or an out-of-range number stops startup instead of falling back to a default you
did not choose. Finding out at boot beats finding out from a bill.

---

## Deploy as a systemd service

For a Linux host using systemd, prepare `.remote.env` with the HTTP settings and Avito credentials, run `npm run verify:release`, then run `sudo deploy/install-services.sh --start` from the source checkout. Review [the installer](../deploy/install-services.sh) and [environment settings](../.env.example) before starting it.

The installer creates a restricted service account, a root-owned `/etc/avito-mcp/avito-mcp.env`, and a release under `/opt/avito-mcp/releases/<version>`. It switches the `current` symlink atomically and checks readiness and the deployed version. Deployments are serialized with `flock`; failures restore the previous release, configuration and service state. Changed code under an unchanged version number is not a new release: bump the version before redeploying it.

## Protocol and compatibility

Skip this section unless you run a deployment other people connect to. A default install continues to serve the legacy revision. Version 2.1.0 deliberately corrects the reporting prompt and unknown-outcome handling on both revisions; see [CHANGELOG](../CHANGELOG.md).

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
| `listChanged`       | advertised `true`                                | advertised `false` — which for this server is the truth                 |
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

> **Cancellation is honoured on both revisions, and 1.3.3 honoured it on neither.** That row of the
> table is the one place the columns describe the same behaviour rather than a difference: the abort
> is installed by the SDK's base protocol before any revision is known. A cancellation aborts the
> outgoing Avito call and returns the rate-limiter slot; the idempotency lease is released only if
> the request had not yet been sent. A cancellation that raced an already-sent request puts the key
> into a bounded hold, and the next call with it answers `IDEMPOTENCY_HELD` — see
> [ADR 0008](../docs/adr/0008-idempotency-hold-on-cancelled-dispatch.md). For a money operation a
> refusal beats a possible double charge.

### Versioning

The public surface has been under [SemVer](https://semver.org) since v1.0.0. Stable, so a break
means a major: tool names and every documented Avito-valid input shape, environment variable names
and defaults, `avito://` resource URIs, prompt names, the risk model, the error taxonomy, the CLI
flags. Additive, so a minor: new tools when Avito ships endpoints, new opt-in variables, new
resources and prompts. The bundled swagger snapshot is data rather than API — refreshing it is a
minor bump as long as existing tool names keep working.

One honest exception. A contract or security fix does not promise to keep accepting inputs the
bundled Avito specification already rejects: a minor or security release may add a finite
anti-abuse bound, reclassify an under-rated operation, restrict an operator-controlled exfiltration
target, or drop an end-of-life Node.js line. Such tightening must preserve documented Avito-valid
calls unless that exact behaviour is the vulnerability, and every instance needs explicit changelog
migration guidance. Everything else still costs a major.

Upgrading from 1.3.x: [MIGRATION.md](../MIGRATION.md) — the short version is that a default stdio
install needs nothing, and one HTTP configuration refuses to start.

---
