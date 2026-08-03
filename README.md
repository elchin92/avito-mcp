# avito-mcp

[![npm](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![CI](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-915_passing-brightgreen)](./test)
[![node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Glama](https://glama.ai/mcp/servers/elchin92/avito-mcp/badges/score.svg)](https://glama.ai/mcp/servers/elchin92/avito-mcp)
[![MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**An MCP server that hands your Avito account to an AI agent — so you can stop opening it.**
The agent replies to buyers in chat, keeps listings priced and promoted, moves orders through
delivery, files the marking codes, and reads the numbers back to you. Not once, as a demo: on a
schedule, or the moment a customer writes. The 148 tools over Avito's 18 official APIs are how
it does that. The reason to install it is that the daily half hour of clicking stops being yours.

The hard part of that promise is the "without you" half, so most of this server is machinery for
leaving an agent alone with a production account. A price change or a paid promotion is refused
until a second call confirms it. Any destructive tool will show you the exact HTTP request
instead of sending it. A retry carrying the same idempotency key is a replay, not a second charge.

**[Русская версия →](./README.ru.md)** · [Upgrading from 1.3.x](./MIGRATION.md) · [CHANGELOG](./CHANGELOG.md)

> **New in v2.0.0** — MCP revision 2026-07-28 is served, switched off behind
> `AVITO_MCP_PROTOCOL_ERA`. OAuth mode now requires an `https` public URL and validates
> registered redirect URIs. Same 148 tools, same schemas, same environment variables. A default
> stdio install upgrades with no changes; [the migration guide](./MIGRATION.md) names who is affected.

---

## Quick start

Node.js 22.12 or newer. No clone, no build, no Docker.

**1.** Get `Client_id`, `Client_secret` and your numeric `Profile_id` from the
[Avito developer portal](https://www.avito.ru/professionals/api). All three are on one page.

**2.** Put this in your MCP client's config. The JSON is identical for every client — only the
file path differs, and those are in [Connect your AI client](#connect-your-ai-client).

```json
{
  "mcpServers": {
    "avito": {
      "command": "npx",
      "args": ["-y", "avito-mcp"],
      "env": {
        "Client_id": "YOUR_CLIENT_ID",
        "Client_secret": "YOUR_CLIENT_SECRET",
        "Profile_id": "YOUR_PROFILE_ID"
      }
    }
  }
}
```

**3.** Restart the client and ask: _"What's my Avito balance and how many unread chats do I have?"_

Two API calls, a real answer, and your credentials never left the machine — stdio is the default
transport, and nothing is proxied through anyone else's server.

---

## Connect your AI client

The snippet above works everywhere. What changes is where you put it.

| Client                    | Where the JSON goes                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Desktop (macOS)    | `~/Library/Application Support/Claude/claude_desktop_config.json`                          |
| Claude Desktop (Windows)  | `%APPDATA%\Claude\claude_desktop_config.json`                                              |
| Claude Desktop (Linux)    | `~/.config/Claude/claude_desktop_config.json`                                              |
| Claude Code               | `claude mcp add avito npx -y avito-mcp -e Client_id=… -e Client_secret=… -e Profile_id=…`  |
| Cursor                    | `~/.cursor/mcp.json`, or `<project>/.cursor/mcp.json`                                      |
| Windsurf                  | `~/.codeium/windsurf/mcp_config.json`                                                      |
| Cline / Roo Code / Kilo   | `…/globalStorage/<extension-id>/settings/cline_mcp_settings.json`                          |
| VS Code (Copilot Chat)    | `.vscode/mcp.json`, or Command Palette → "MCP: Add Server"                                 |
| Zed                       | Settings → `context_servers` (`command: { path, args, env }`)                              |
| Continue                  | `~/.continue/config.json` → `experimental.modelContextProtocolServers`                     |
| Codex CLI                 | `~/.codex/config.toml` → `[mcp_servers.avito]`                                             |
| Goose                     | `goose configure` → MCP server, or `~/.config/goose/config.yaml`                           |
| LibreChat                 | `librechat.yaml` → `mcpServers.avito` (`type: stdio`)                                      |
| ChatGPT Desktop           | Settings → Connectors → Add custom MCP server (type `stdio`, command `npx`)                |
| JetBrains AI Assistant    | Settings → Tools → AI Assistant → MCP → Add server                                         |
| Cherry Studio             | Settings → MCP Servers → Add                                                               |
| Anything else             | stdio, `npx`, `["-y", "avito-mcp"]`, the three env vars                                    |

Claude Desktop needs a full quit from the system tray, not a window close, before it rereads the
file. Its logs are at `~/Library/Logs/Claude/mcp-server-avito.log` on macOS. Cursor needs
"Reload Window"; Cline reloads on its own. New clients appear in the
[MCP client directory](https://modelcontextprotocol.io/clients) faster than this table changes.

---

## What the agent can actually do

Every public endpoint of Avito's 18 OpenAPI specifications is a tool, generated from the bundled
swaggers rather than hand-written, so the coverage is the API's rather than someone's taste.

| Group                    | Tools | What an agent uses it for                                                     |
| ------------------------ | ----: | ----------------------------------------------------------------------------- |
| Messenger                |    16 | Read chats, reply, send images, block, subscribe to push events               |
| Listings                 |    11 | Prices, views/contacts/calls, extended analytics, spend breakdown, paid VAS   |
| Orders                   |    12 | Statuses, courier slots, tracking numbers, labels, "Честный знак" marking     |
| Autoload                 |    17 | XML/YML/CSV feed uploads, per-item reports, ID mapping, category schemas      |
| Promotion & CPA          |    25 | BBIP forecasts and orders, CPA bids, auctions, complaints, balance            |
| Delivery (3PL partner)   |    31 | Avito's logistics API for shipping companies — most sellers never call these  |
| Profile, stock, staff    |    14 | Balance, operations history, stock levels, sub-accounts, reviews and answers  |
| Tariffs, trxpromo, calls |    12 | Tariff reference, transactional promotion, call recordings, chat discounts    |
| Auth & meta              |    10 | Health, capabilities, rate limits, the confirmation flow, raw OAuth tokens    |

The Avito API snapshot in `./swaggers/` is dated 25 May 2026. Avito revises endpoints without
warning; a 404 on a documented method or a missing new one is worth an issue, and the snapshot
gets bumped. The live catalogue with per-tool risk, domain and annotations is
[`dist/manifest.json`](./dist/manifest.json) and the `avito://manifest` resource.

**How many tools you actually see** depends on configuration. Two of the 148 are opt-in, because
one returns OAuth tokens and one reads files off your disk:

| Configuration                                                      | Tools registered |
| ------------------------------------------------------------------ | ---------------: |
| Default (`AVITO_MCP_MODE=full_access`, nothing opted in)           |              144 |
| `+ AVITO_MCP_ALLOWED_UPLOAD_DIRS=…` (enables image upload)         |              145 |
| `+ AVITO_MCP_EXPOSE_AUTH_TOOLS=1` (enables the three `auth_*`)     |              147 |
| Both opt-ins — the full manifest                                   |              148 |
| `AVITO_MCP_MODE=guarded` (hides `money` and `public` risks)        |              119 |
| `AVITO_MCP_MODE=read_only` (only `risk=read`)                      |               80 |
| `AVITO_MCP_CONFIRMATION_MODE=off`                                  |    −3 meta tools |

Hidden tools are never registered, so they do not appear in `tools/list` at all — a model cannot
call what it cannot see. `AVITO_MCP_ALLOW_TOOLS` and `AVITO_MCP_DENY_TOOLS` narrow the set by
name for the swarm case, where the support agent has no reason to hold the promotion budget.

---

## Why you can leave it running

Every tool carries one of five risk classes, and the class decides what happens before the call
goes out: `read` 80, `write` 40, `public` 16, `money` 9, `sensitive` 3. The classes are visible
to the client as MCP `ToolAnnotations` and `_meta.risk`, so an orchestrator can route on them.

**Money and public actions need a second call.** By default (`money_public`) anything that spends
money or is visible to a customer returns `{ requires_confirmation: true, confirmation_id: … }`
instead of executing. The agent — or a human reading over its shoulder — calls
`meta_confirm_action` with that id to let it through. Pending state is durable, account-scoped,
one-shot and expires in 15 minutes; `all_destructive` extends the gate to every write.
`AVITO_MCP_CONFIRMATION_SECRET` turns it into a hard gate, and `AVITO_MCP_APPROVAL_MODE=external`
additionally requires the confirming identity to differ from the one that started the action.
[`docs/safety.md`](./docs/safety.md) is frank about what this is: a server-side two-step and audit
layer, not a cryptographic proof that a human approved.

**Anything destructive can rehearse itself.** Pass `dryRun: true` and the tool returns the HTTP
request it would have made — method, path, body — and `fetch` is never called. Flip it for the
whole process with `AVITO_MCP_DRY_RUN_DEFAULT=true` or `--dry-run`, and the agent has to pass
`dryRun: false` deliberately to act.

```json
{ "name": "items_update_price", "arguments": { "item_id": 12345, "price": 1400, "dryRun": true } }
```

**A retry is not a second charge.** Every destructive tool accepts `idempotencyKey`. The reservation
is written to a durable account-scoped ledger before the upstream mutation, so a repeat with the
same key and the same arguments replays the cached result (`idempotent_replay: true`) with no
second HTTP call; the same key with different arguments is a structured conflict error. The ledger
survives restarts and is shared across concurrent stdio processes. An abandoned reservation fails
closed and asks for reconciliation rather than guessing that a possibly-charged action is safe to
repeat. TTL is `AVITO_MCP_IDEMPOTENCY_TTL_SEC` (1 hour), storage `AVITO_MCP_RUNTIME_STATE_DIR`.

**Errors are machine-readable**, so an agent branches on fields rather than on English:

```json
{ "isError": true, "structuredContent": { "error": {
  "type": "AVITO_RATE_LIMIT", "message": "Avito API 429 for POST …",
  "retryable": true, "retryAfter": 60, "httpStatus": 429 } } }
```

`type` is one of `AVITO_BAD_REQUEST`, `AVITO_UNAUTHORIZED`, `AVITO_FORBIDDEN`, `AVITO_NOT_FOUND`,
`AVITO_RATE_LIMIT`, `AVITO_SERVER_ERROR`, `AVITO_API_ERROR`, `NETWORK_ERROR`, `TIMEOUT`,
`CONFIG_ERROR`, `INTERNAL_ERROR`, `IDEMPOTENCY_HELD`. Successful results carry `structuredContent`
too: objects as `{ status, …data, http_status }`, arrays as `{ status, http_status, items, count }`,
binaries (label PDFs, call audio) as `{ status, http_status, mimeType, sizeBytes, base64 }`.

**Three meta tools describe the server to itself** — `meta_health` (version, uptime, counters),
`meta_auth_status` (token metadata only, never the token, `probe: true` forces a refresh) and
`meta_capabilities` (active mode, allow/deny counts, feature flags). All three have strict
output schemas. `meta_get_rate_limits` reports Avito's `X-RateLimit-*` per domain, and the limits
are shared across every tool in one process rather than counted per call site.

**Several processes share one token.** If a cron job, a chat session and a CLI run against the same
token file, they do not stampede Avito's `/token` endpoint: the first to take `{tokenFile}.lock`
refreshes, the rest wait and read the fresh token off disk. Leases are ownership-checked, so a dead
process's lock is reclaimed and a live one's is not stolen (`AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS`, 30s).

How much of this is actually tested: 915 tests across 54 files, 84% of statements and 87% of lines,
including 151 assertions that replay this build against a wire baseline captured from a real
running 1.3.3 process, so a refactor cannot quietly change what an existing client receives.

---

## Resources and prompts

Resources are data the agent can read without spending an Avito API call. Two of them are
subscribable, which is what makes an unattended loop possible at all.

| URI                             | What it holds                                                            |
| ------------------------------- | ------------------------------------------------------------------------ |
| `avito://docs/safety`           | Safety modes, confirmation flow, ready-to-paste configurations           |
| `avito://manifest`              | The live tool catalogue — risk, domain, title, annotations               |
| `avito://state/config`          | Snapshot of the active configuration, secrets redacted                   |
| `avito://state/rate-limits`     | Latest `X-RateLimit-*` seen per Avito domain                             |
| `avito://state/pending-actions` | Confirmations waiting for someone — **subscribable**                     |
| `avito://webhook/events`        | Buffered Avito chat events — **subscribable**                            |
| `avito://swaggers/{slug}`       | One resource per bundled specification, with completion                  |

Prompts are canned workflows that call the right tools in the right order, with the guard rails
written into the prompt text rather than left to the model's judgement.

| Prompt                     | Arguments             | What it does                                                    |
| -------------------------- | --------------------- | ---------------------------------------------------------------- |
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

| Endpoint                                    | What it is                                                     |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `/mcp`                                      | The MCP transport                                               |
| `/authorize`                                | Consent screen — the owner password goes here                   |
| `/token` · `/register` · `/revoke`          | Token exchange, dynamic registration (RFC 7591), revocation     |
| `/.well-known/oauth-authorization-server`   | Authorization server metadata                                   |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata, path-suffixed per RFC 9728                   |
| `/healthz` · `/readyz`                      | Liveness and readiness, unauthenticated, `{ok}`-shaped bodies   |

| Variable                                   | Default     | Meaning                                                                                                        |
| ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `AVITO_MCP_TRANSPORT`                      | `stdio`     | `stdio` \| `http` \| `both` (CLI: `--http`, `--both`)                                                          |
| `AVITO_MCP_HTTP_HOST` / `_PORT`            | `127.0.0.1` / `3000` | Bind address and port. Keep it loopback and let a proxy face the internet                             |
| `AVITO_MCP_HTTP_PUBLIC_URL`                | —           | The OAuth issuer identifier. Changing it is a new authorization server: clients re-register, tokens are dropped |
| `AVITO_MCP_HTTP_AUTH`                      | `oauth`     | `oauth` \| `bearer` \| `none`                                                                                  |
| `AVITO_MCP_OAUTH_OWNER_PASSWORD`           | —           | Required in `oauth` mode, at least 32 bytes. The only secret that issues a token                               |
| `AVITO_MCP_OAUTH_TOKEN_TTL_SEC`            | `3600`      | Lifetime of an issued bearer token                                                                             |
| `AVITO_MCP_OAUTH_STORE_FILE`               | —           | Durable client/token store. Exclusive lease — one running server per file                                      |
| `AVITO_MCP_HTTP_AUTH_TOKEN`                | —           | `bearer` mode: comma-separated shared secrets, each at least 32 bytes                                          |
| `AVITO_MCP_HTTP_ALLOWED_HOSTS` / `_ORIGINS` | derived    | DNS-rebinding protection. Derived fail-closed; an under-specified wildcard bind refuses to start                |
| `AVITO_MCP_HTTP_ALLOW_INSECURE_PUBLIC_URL` | `0`         | Development only. Cleartext issuer on a routable host; the SDK also wants `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` |
| `AVITO_MCP_HTTP_ALLOW_NO_AUTH`             | `0`         | Permit `auth=none` off loopback. Discouraged, and it means what it says                                        |
| `AVITO_MCP_HTTP_MAX_SESSIONS`              | `100`       | **Legacy revision only** (2025-11-25 has sessions). Concurrent sessions; `initialize` beyond it gets a 503     |
| `AVITO_MCP_HTTP_SESSION_IDLE_SEC`          | `1800`      | **Legacy revision only.** Idle sessions past this are reaped — clients that vanished without a `DELETE`        |
| `AVITO_MCP_HTTP_MAX_INFLIGHT`              | `64`        | Revision 2026-07-28, which has no sessions: concurrent `/mcp` exchanges before `503` + `Retry-After`           |
| `AVITO_MCP_HTTP_MAX_STREAMS`               | `32`        | How many of those may be long-lived subscription streams, so streams cannot starve ordinary calls              |

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
is an environment variable; `--help` lists them all, and so does [.env.example](./.env.example).

`--health` is a configuration diagnostic, not a liveness probe — it does not talk to a running
process. For Kubernetes or a supervisor, probe `/readyz`, which returns 200 only while the listener
is open, HTTP-mode credentials are complete, the token and runtime-state directories are writable,
the OAuth store lease is healthy and webhook persistence has not failed. Its body stays `{"ok":…}`.

Environment parsing is fail-fast by design: an unknown enum value, a partially numeric limit, a
weak remote secret or an out-of-range number stops startup instead of falling back to a default you
did not choose. Finding out at boot beats finding out from a bill.

---

## Protocol and compatibility

Skip this section unless you run a deployment other people connect to. A default install answers
the revision it always answered, and nothing here changes until you set a variable.

### Protocol revisions

`AVITO_MCP_PROTOCOL_ERA` selects which MCP revisions a process serves: `legacy` (the default —
2025-11-25 only, byte-for-byte the 1.3.x wire), `dual` (both), `modern` (2026-07-28 only). An
unrecognised value fails startup rather than falling back, because a typo in the variable that
decides which protocol your clients get should not be survivable in silence.

|                              | 2025-11-25                                | 2026-07-28                                                        |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Handshake                    | `initialize`                              | none — `server/discover` and a per-request `_meta` envelope         |
| Watching a resource          | `resources/subscribe`                     | `subscriptions/listen` with `resourceSubscriptions`, acknowledged first |
| Subscribable URIs            | pending actions, webhook events           | the same two                                                        |
| `listChanged`                | advertised `true`                         | advertised `false` — which for this server is the truth             |
| List verbs                   | one answer (≈225 KB), `cursor` ignored    | paginated at 48 KiB per page; an unminted cursor is `-32602`        |
| Prompt arguments             | any string, `parseInt(…) \|\| default`    | allowlists, bounded integers, control and bidi characters refused   |
| Log level                    | `logging/setLevel` per connection         | that method is removed; the level is declared per request in `_meta` |
| Cancelling a call            | `notifications/cancelled`                 | that, or closing the response stream                                |

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
> the SDK entry point: [ADR 0001](docs/adr/0001-protocol-era-limitations.md).

> **Cancellation is honoured on both revisions, and 1.3.3 honoured it on neither.** That row of the
> table is the one place the columns describe the same behaviour rather than a difference: the abort
> is installed by the SDK's base protocol before any revision is known. A cancellation aborts the
> outgoing Avito call and returns the rate-limiter slot; the idempotency lease is released only if
> the request had not yet been sent. A cancellation that raced an already-sent request puts the key
> into a bounded hold, and the next call with it answers `IDEMPOTENCY_HELD` — see
> [ADR 0008](docs/adr/0008-idempotency-hold-on-cancelled-dispatch.md). For a money operation a
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

Upgrading from 1.3.x: [MIGRATION.md](./MIGRATION.md) — the short version is that a default stdio
install needs nothing, and one HTTP configuration refuses to start.

---

## Security

- stdio by default: no proxy, no remote endpoint, no telemetry. The HTTP mode is opt-in, binds
  loopback, and is guarded by OAuth 2.1 or a bearer secret behind your own TLS.
- Credentials live in the client's `env` block or a local `.env` and go nowhere except
  `api.avito.ru`. OAuth tokens are cached per account in a `0600` file under a `0700` directory —
  `$XDG_STATE_HOME/avito-mcp/token.json` on Linux, `~/Library/Application Support/avito-mcp/` on
  macOS, `%APPDATA%\avito-mcp\` on Windows, or wherever `AVITO_TOKEN_FILE` points. A cache created
  for a different origin, client or profile is ignored rather than reused. Delete it to force a refresh.
- `messenger_upload_images` reads files off disk, so it does not register at all without
  `AVITO_MCP_ALLOWED_UPLOAD_DIRS`. With it, the tool validates the same file descriptor it opens,
  rejects parent and final symlink races, enforces count and size limits, checks jpg/jpeg/png/webp
  magic bytes and keeps local paths out of error messages.
- The three `auth_*` tools return OAuth tokens. They are classed `sensitive` and stay hidden even in
  `full_access` until `AVITO_MCP_EXPOSE_AUTH_TOOLS=1`.
- Treat every tool marked `environment: prod` as production, because it is: Avito issues no sandbox
  credentials, and every call in this package hits the live account. Delivery operations Avito
  documents as sandbox are marked `environment: sandbox`, which is metadata, not a safety net. Safe
  first calls: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`.
- Upgrading a live deployment? [`docs/adr/0002-canary-protocol.md`](./docs/adr/0002-canary-protocol.md)
  is five read-only tools to re-run against the real account after a risky rollout, with
  `AVITO_MCP_MODE=read_only` set. [`docs/safety.md`](./docs/safety.md) has ready-to-paste
  configurations for analytics-only, customer support, listings-only and full admin.
- Found a vulnerability? [SECURITY.md](./SECURITY.md) has the private channel. Please don't open a
  public issue for it.

---

## Install from source

For development, air-gapped installs, or when you want to change a tool. Node.js `>=22.12.0`; CI
runs the suite on 22.x and 24.x.

```bash
git clone https://github.com/elchin92/avito-mcp.git && cd avito-mcp
npm ci && cp .env.example .env      # then fill in the three credentials
npm run build:release               # compiles and regenerates dist/manifest.json
```

Point the client at `{ "command": "node", "args": ["/absolute/path/to/dist/server.js"] }`. A
multi-stage [`Dockerfile`](./Dockerfile) is included.

For a hardened systemd deployment, write `.remote.env`, run `npm run verify:release`, then
`sudo deploy/install-services.sh --start`. The installer allowlists only avito-mcp variables into a
root-owned `/etc/avito-mcp/avito-mcp.env`, creates a read-only release under
`/opt/avito-mcp/releases/<version>`, switches the `current` symlink atomically, runs as an
unprivileged user and verifies `/readyz` plus the deployed version on `/healthz`. Deploys are
serialized with `flock`, and any failure restores the previous symlink, config, units and running
state. Rebuilding changed code under an unchanged version number deliberately does nothing — bump
the version first.

Adding a new Avito API takes one file in `src/domains/` and one line in
`src/meta/domain-registry.ts`; the factory in `src/core/tool-factory.ts` already handles HTTP,
OAuth, retries, rate-limit accounting, error mapping and `Profile_id` injection, so no tool ever
writes a `fetch()` call. Details in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Not covered here

Avito publishes separate APIs for these, and their specifications are not bundled:
[Auction](https://developers.avito.ru/api-catalog/auction/documentation),
[Autostrategy](https://developers.avito.ru/api-catalog/autostrategy/documentation),
[Autoteka](https://developers.avito.ru/api-catalog/autoteka/documentation),
[Jobs](https://developers.avito.ru/api-catalog/job/documentation),
[Realty reports](https://developers.avito.ru/api-catalog/realty-reports/documentation),
[Short-term rent](https://developers.avito.ru/api-catalog/str/documentation).

Also out of scope: the `authorization_code` flow against Avito itself, since a local CLI has no
public redirect URI, and an Avito sandbox, since Avito does not issue sandbox credentials.

Bug reports and questions: [issues](https://github.com/elchin92/avito-mcp/issues/new/choose),
[discussions](https://github.com/elchin92/avito-mcp/discussions), [SUPPORT.md](./SUPPORT.md).

[MIT](./LICENSE). Not affiliated with Avito.ru; "Avito" belongs to its owner, and use of the Avito
API is subject to Avito's terms.
