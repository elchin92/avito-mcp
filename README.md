# avito-mcp

[![npm version](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![npm downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![CI](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-212_passing-brightgreen)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Glama score](https://glama.ai/mcp/servers/elchin92/avito-mcp/badges/score.svg)](https://glama.ai/mcp/servers/elchin92/avito-mcp)
[![GitHub stars](https://img.shields.io/github/stars/elchin92/avito-mcp?style=social)](https://github.com/elchin92/avito-mcp/stargazers)
[![Avito API snapshot](https://img.shields.io/badge/Avito_API_snapshot-2026--05--25-orange)](./swaggers)

> **Give your AI agents hands and feet on Avito.**
> An MCP server that lets Claude, Cursor, Cline and any other AI assistant **do real work on Avito for you** — answer customers, manage listings, run promotions, fulfil orders, analyse stats. **141 Avito API tools** + **7 local/meta tools** = up to **148 MCP tools** across **18 official Avito APIs**. Runs locally over stdio or as a shared **remote MCP** over HTTP (OAuth 2.1), with a built-in **webhook receiver** for real-time chat events. One `npx` command to install.

🇷🇺 **[Русская версия / Russian version →](./README.ru.md)**

<a href="https://glama.ai/mcp/servers/elchin92/avito-mcp"><img width="380" height="200" src="https://glama.ai/mcp/servers/elchin92/avito-mcp/badges/card.svg" alt="avito-mcp MCP server" /></a>

> **New in v1.1.1** — dependency security patch: the transitive `hono` (high) and `esbuild` (low, dev-only) npm-audit advisories from [#21](https://github.com/elchin92/avito-mcp/issues/21) are cleared (`npm audit` → 0). Lockfile-only, no code change. Full history in the [CHANGELOG](./CHANGELOG.md).

---

## What it does

Avito is Russia's largest classifieds marketplace (~250M monthly visits). Selling there involves dozens of repetitive operations every day: replying in chats, refreshing listings, applying paid promotion, generating shipping labels, watching stats.

`avito-mcp` exposes every public Avito API as a tool your AI agent can call. Plug it into your favourite MCP client and your agent can run an entire Avito storefront — autonomously — from natural language.

- 🔌 **Universal** — works with 15+ MCP clients (Claude Desktop, Cursor, Cline, Continue, Windsurf, Zed, ChatGPT, …)
- 🔒 **Local-first** — stdio transport by default, your OAuth credentials never leave your machine (optional [remote HTTP mode](#remote-mcp-over-http-oauth-21) for shared/team deployments)
- 🤖 **Built for autonomy** — dry-run, idempotency keys, a confirmation flow and risk-tagged tools make it safe to leave an agent running unattended
- ⚡ **Zero install** — `npx -y avito-mcp`, no clone/build, no Docker

---

## Quick start (≈90 seconds)

**1.** Get OAuth credentials from the [Avito Developer Portal](https://www.avito.ru/professionals/api): `Client_id`, `Client_secret`, and your `Profile_id` (your numeric account ID, shown on the same page).

**2.** Add this snippet to your MCP client's config (the JSON is **the same for every client** — only the file path differs, see [Connect your AI client](#connect-your-ai-client)):

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

**3.** Restart your client. Ask your agent:

> *"What's my Avito balance and how many unread chats do I have?"*

Done. Two API calls, real answer.

---

## Built for autonomous workflows

Most MCP servers are designed to be **called by hand** from a chat window. `avito-mcp` is designed to be **left running** — picked up by multi-agent runtimes and scheduled agents that operate without you watching.

Typical deployment patterns:

- **Reactive agent** — a Claude/Cursor session permanently open, monitoring chats and replying to customers in your tone of voice. Pair with the [webhook receiver](#avito-webhook-receiver) to react the instant a customer writes instead of polling.
- **Cron-scheduled agent** — a runtime fires up your agent every N minutes to triage new orders, top up promotion budgets, refresh stats.
- **Multi-agent swarm** — separate agents for "support", "promotion", "logistics", each holding only the tools they need (via `AVITO_MCP_ALLOW_TOOLS` / safety modes).
- **Team / hosted deployment** — one [remote MCP instance](#remote-mcp-over-http-oauth-21) behind OAuth 2.1, shared by several clients and humans.

The stdio transport keeps every credential and API response on your machine. No proxy. No SaaS in the middle.

→ See the full list of compatible runtimes at [modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients).

---

## What's included — up to 148 tools

| Configuration | Tools visible |
|---|---|
| Default (`AVITO_MCP_MODE=full_access`, no opt-ins) | **144** |
| + `AVITO_MCP_EXPOSE_AUTH_TOOLS=1` | 147 (+3 auth) |
| + `AVITO_MCP_ALLOWED_UPLOAD_DIRS=…` | 145 (+1 upload) |
| + Both opt-ins | **148** |
| `AVITO_MCP_CONFIRMATION_MODE=off` | −3 (hides meta_*_action) |
| `AVITO_MCP_MODE=read_only` | ~82 (only `risk=read`) |
| `AVITO_MCP_MODE=guarded` | ~125 (adds `write`, hides `money`/`public`) |

141 tools wrap Avito API endpoints; 7 are local meta tools — `meta_get_rate_limits`, three `meta_*_action` tools for the [confirmation flow](#security), plus `meta_health`, `meta_auth_status` and `meta_capabilities` for introspection. The authoritative inventory lives in [`dist/manifest.json`](./dist/manifest.json) (regenerate with `npm run generate:manifest`).

Every public endpoint from Avito's 18 OpenAPI specs is exposed. Click any group to expand.

> **Avito API snapshot date: 25 May 2026.** The bundled swaggers (`./swaggers/`) reflect Avito's public API as of that date. Avito occasionally adds or revises endpoints — if you spot drift (404 on a known method, new method missing), open an issue and we'll bump the snapshot.

<details>
<summary>📋 <b>Listings</b> — 11 tools (items_*)</summary>

- `items_get_items_info` — list your listings (pagination, status, category filters)
- `items_get_item_info` — full details of one listing
- `items_post_calls_stats` — call statistics per item per day
- `items_post_vas_prices` — promotion service prices for given items
- `items_post_item_stats_shallow` — basic views/contacts/calls over a period
- `items_post_item_analytics` — extended analytics with grouping & sorting
- `items_post_account_spendings` — spend breakdown by service type
- `items_update_price` ⚠️ — change listing price
- `items_put_item_vas` ⚠️ — apply one paid VAS service
- `items_put_item_vas_package_v2` ⚠️ — apply a VAS package
- `items_apply_vas` ⚠️ — apply multiple VAS slugs at once
</details>

<details>
<summary>💬 <b>Messenger</b> — 16 tools (messenger_*)</summary>

- `messenger_get_chats_v2` — list chats (filters: unread, item_ids, chat_types)
- `messenger_get_chat_by_id_v2` — details of one chat
- `messenger_get_messages_v3` — message history in a chat (paginated)
- `messenger_get_voice_files` — download URLs for voice messages
- `messenger_get_subscriptions` — current webhook subscriptions
- `messenger_post_send_message` ⚠️ — send a real text reply to a customer
- `messenger_post_send_image_message` ⚠️ — send an image (use upload first)
- `messenger_upload_images` — multipart upload, returns image_ids
- `messenger_delete_message` ⚠️ — delete a message
- `messenger_chat_read` — mark all unread in a chat as read
- `messenger_post_blacklist_v2` ⚠️ — block users (with reason codes)
- `messenger_post_webhook_v3` ⚠️ — subscribe to push notifications (needs public URL)
- `messenger_post_webhook_unsubscribe` — unsubscribe
- `messenger_get_webhook_events` — drain events received by the built-in [webhook receiver](#avito-webhook-receiver)
- `messenger_get_webhook_status` — receiver stats: retained / total received / last received
- `messenger_register_webhook` ⚠️ — subscribe the configured public URL with Avito in one call
</details>

<details>
<summary>📦 <b>Orders</b> — 12 tools (orders_*)</summary>

- `orders_get_orders` — list orders with filters
- `orders_get_courier_delivery_range` — available courier time slots
- `orders_download_label` — fetch generated label PDF
- `orders_markings` ⚠️ — submit "Честный знак" (mandatory product marking)
- `orders_accept_return_order` ⚠️ — choose Russian Post office for return
- `orders_apply_transition` ⚠️ — change order status (confirm/ship/cancel)
- `orders_check_confirmation_code` — verify pickup code
- `orders_cnc_set_details` ⚠️ — click-and-collect order details
- `orders_set_courier_delivery_range` ⚠️ — pick a courier time slot
- `orders_set_tracking_number` ⚠️ — set carrier tracking number
- `orders_generate_labels` — generate labels (≤100 orders)
- `orders_generate_labels_extended` — generate labels (≤1000 orders)
</details>

<details>
<summary>🔄 <b>Autoload</b> — 17 tools (autoload_*)</summary>

XML/YML/CSV feed uploads, report retrieval, ID mapping, category schema lookup. Includes both v1 (deprecated, kept for compatibility) and v2/v3.

- `autoload_upload` ⚠️ — trigger a feed upload (rate-limited to 1/hour)
- `autoload_get_profile_v2`, `autoload_create_or_update_profile_v2` ⚠️ — manage feed profile
- `autoload_get_reports_v2` — list upload reports with pagination
- `autoload_get_report_by_id_v3`, `autoload_get_last_completed_report_v3` — report details
- `autoload_get_report_items_by_id`, `autoload_get_report_items_fees_by_id` — per-item results
- `autoload_get_ad_ids_by_avito_ids`, `autoload_get_avito_ids_by_ad_ids` — ID mapping
- `autoload_user_docs_tree`, `autoload_user_docs_node_fields` — category schema reference
- + 5 legacy endpoints (deprecated v1 and early v2), kept under their original names for compatibility
</details>

<details>
<summary>🚚 <b>Delivery</b> — 31 tools (delivery_*) <i>· 3PL partner API</i></summary>

Avito's logistics partner API for delivery service providers. Most users will never call these — they're for shipping companies integrating with Avito Delivery. Includes both production endpoints and sandbox endpoints for partner testing. Full list in the source: [`src/domains/delivery.ts`](./src/domains/delivery.ts).
</details>

<details>
<summary>📈 <b>Promotion & CPA</b> — 25 tools (promotion_*, cpa_*, cpa_target_*, cpa_auction_*)</summary>

- **BBIP promotion** (7) — promotion_get_bbip_forecasts_by_items_v1, promotion_create_bbip_order_for_items_v1 ⚠️, promotion_get_order_status_v1, …
- **CPA** (11) — chats/calls by time, balance v2/v3, complaints, phone info — `cpa_*`
- **CPA target action** (5) — `cpa_target_get_bids`, `cpa_target_save_auto_bid` ⚠️, `cpa_target_save_manual_bid` ⚠️, …
- **CPA auction** (2) — `cpa_auction_get_user_bids`, `cpa_auction_save_item_bids` ⚠️
</details>

<details>
<summary>👤 <b>Profile, Stock, Hierarchy, Reviews</b> — 14 tools</summary>

- **User** (3) — `user_get_user_info_self`, `user_get_user_balance`, `user_post_operations_history`
- **Stock** (2) — `stock_get_stocks_info`, `stock_update_stocks` ⚠️
- **Hierarchy** (5) — sub-accounts, employees, item assignment (multi-employee setups)
- **Reviews** (4) — `reviews_get_reviews_v1`, `reviews_create_review_answer_v1` ⚠️, `reviews_remove_review_answer_v1` ⚠️, `reviews_get_ratings_info_v1`
</details>

<details>
<summary>🛠️ <b>Misc</b> — 12 tools (tariffs_*, trxpromo_*, calltracking_*, msg_discounts_*)</summary>

- **Tariffs** (1) — transport-category tariff reference
- **TrxPromo** (3) — transactional promotion: commissions / apply / cancel
- **CallTracking** (3) — call records and audio retrieval
- **Messenger discounts** (5, beta) — bulk discount campaigns in chats
</details>

<details>
<summary>🔐 <b>Auth & Meta</b> — 4 tools</summary>

- **Auth** (3) — `auth_get_access_token` (debug; the server manages tokens automatically), `auth_get_access_token_authorization_code`, `auth_refresh_access_token_authorization_code`
- **Meta** (1) — `meta_get_rate_limits` — observe X-RateLimit-* across all domains
</details>

> ⚠️ marks methods that **spend real money or affect live data** (price changes, paid promotion, customer-facing messages, blocked users). Safe read-only smoke tools: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.

---

## MCP resources & prompts

Beyond tools, the server exposes MCP **resources** (data your agent can fetch without an API call) and **prompts** (canned workflows that orchestrate the right tools in the right order).

### Resources

| URI | Type | What's in it |
|---|---|---|
| `avito://docs/safety` | `text/markdown` | Safety modes + confirmation guide |
| `avito://manifest` | `application/json` | Live tool catalogue (risk / domain / title / annotations) |
| `avito://state/config` | `application/json` | Active config snapshot — secrets redacted |
| `avito://state/rate-limits` | `application/json` | Latest `X-RateLimit-*` per Avito domain |
| `avito://state/pending-actions` | `application/json` | Pending confirmations — **subscribable**, emits `notifications/resources/updated` |
| `avito://webhook/events` | `application/json` | Buffered Avito [webhook](#avito-webhook-receiver) events — **subscribable** |
| `avito://swaggers/{slug}` | `application/json` | One resource per file in `swaggers/` (autocomplete via `complete`) |

Subscribe to `avito://state/pending-actions` and your client sees every create/confirm/cancel/expire in real time — perfect for UIs that want a "things waiting for human" indicator. Subscribe to `avito://webhook/events` and the client is notified the moment Avito delivers a new chat event.

### Prompts

| Name | Args | Purpose |
|---|---|---|
| `avito_daily_overview` | `days?` (default 7) | Balance + active items + spendings (read-only, no confirmation) |
| `avito_check_unread_chats` | `limit?` (default 20) | Triage unread chats; explicit "don't send / don't blacklist" guard |
| `avito_safety_report` | — | Self-describe via `state/config` + `manifest` + `docs/safety` |
| `avito_explain_tool` | `tool_name` | Cross-reference one tool's manifest entry + matching swagger |
| `avito_promote_item` | `item_id` | Gather everything needed before a paid VAS purchase; explicit "не покупай" |

### Structured tool outputs

Every tool returns `structuredContent` alongside the text block — clients can parse Avito responses as JSON without regex:

- Objects → `{ status, ...data }`
- Arrays → `{ status, items, count }`
- Binary (PDF labels, audio) → `{ status, mimeType, sizeBytes, base64 }`
- Errors → `{ error: { type, message, retryable, retryAfter?, httpStatus? }, error_kind }` with `isError: true` — see [Structured error taxonomy](#structured-error-taxonomy)

### MCP logging

Selected pino events (mode changes, hidden-tool reports, confirmation lifecycle, rate-limit warnings) are forwarded to the client as `notifications/message` with `logger: "avito-mcp"`, with sensitive fields censored. Clients that adjust verbosity via `logging/setLevel` work as expected. Pino → stderr is preserved.

---

## Universal safety primitives

Opt-in primitives that make the package safe to use in **any** automation context — manual chat, scheduled jobs, multi-agent runtimes, server farms — without committing to a specific orchestrator or backend.

### Dry-run

Every destructive tool (`risk: write | money | public`) accepts an optional `dryRun: boolean` parameter. When `true`, the tool returns a structured preview of the HTTP request it *would have* made — no call to Avito. Useful both for human inspection ("what is the agent about to do?") and for agents that want to think before acting.

```json
{
  "name": "items_update_price",
  "arguments": { "item_id": 12345, "price": 1400, "dryRun": true }
}
```

→ `structuredContent: { dryRun: true, operation: { tool, method, path, ... }, request_preview: { ... } }` and `fetch` is never called.

You can flip the default for the entire server: `AVITO_MCP_DRY_RUN_DEFAULT=true` or `--dry-run`. Then every destructive tool short-circuits unless the agent explicitly passes `dryRun: false`.

### Idempotency

Every destructive tool also accepts an optional `idempotencyKey: string`. The server keeps an in-memory ledger keyed by `(tool, key, hash(args))`:

- First call with a key: executes, caches the result.
- Repeat call with the same key + identical args within TTL: returns the cached result, marked `structuredContent.idempotent_replay: true`. No second HTTP call.
- Repeat call with the same key + different args: returns a structured `IdempotencyConflictError` (the dedupe contract was violated).

This is the simplest reliable defence against duplicate sends after retries, crashes, or race conditions between concurrent agents. TTL via `AVITO_MCP_IDEMPOTENCY_TTL_SEC` (default 1 hour).

### Structured error taxonomy

All errors return both human text and a machine envelope:

```json
{
  "isError": true,
  "structuredContent": {
    "error": {
      "type": "AVITO_RATE_LIMIT",
      "message": "Avito API 429 for POST ...",
      "retryable": true,
      "retryAfter": 60,
      "httpStatus": 429
    }
  }
}
```

`type` ∈ `AVITO_BAD_REQUEST | AVITO_UNAUTHORIZED | AVITO_FORBIDDEN | AVITO_NOT_FOUND | AVITO_RATE_LIMIT | AVITO_SERVER_ERROR | AVITO_API_ERROR | NETWORK_ERROR | TIMEOUT | CONFIG_ERROR | INTERNAL_ERROR`.

Agents can branch on `retryable` and `retryAfter` programmatically — no regex over English text.

### Health / auth / capabilities meta-tools

| Tool | What it returns |
|---|---|
| `meta_health` | Overall health snapshot: version, uptime, capabilities, safety mode, counters (pending actions, idempotency entries, rate-limit snapshots) |
| `meta_auth_status` | OAuth token *metadata* only — `tokenPresent`, `expiresInSec`, last error. The token value is NEVER exposed. With `probe: true` will attempt a refresh. |
| `meta_capabilities` | Machine-readable config: mode, allow/deny counts, feature flags (`dryRun`, `idempotency`, `confirmation`, `hardConfirmation`, `fileUploads`, `sensitiveAuthTools`) |

All three have strict `outputSchema` (zod) — clients can validate against the contract.

### Cross-process token lock

If you run multiple avito-mcp processes against the same token file (cron + chat + CLI), they never hit Avito's `/token` endpoint in parallel. The first to acquire `{tokenFile}.lock` refreshes; the rest wait, then read the freshly-refreshed token from disk. Stale locks (dead PID, ancient timestamp) are reclaimed automatically. Tunable via `AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS` (default 30s).

### CLI flags

Convenience shortcuts that translate to env vars (env wins if both set):

```bash
avito-mcp --readonly             # AVITO_MCP_MODE=read_only
avito-mcp --guarded              # AVITO_MCP_MODE=guarded
avito-mcp --dry-run              # AVITO_MCP_DRY_RUN_DEFAULT=true
avito-mcp --no-confirmation      # AVITO_MCP_CONFIRMATION_MODE=off
avito-mcp --http | --both        # AVITO_MCP_TRANSPORT=http | both
avito-mcp --health               # print JSON health snapshot and exit
```

`--health` does not connect stdio transport — ideal for Docker / Kubernetes / supervisord health probes:

```yaml
healthcheck:
  test: ["CMD", "avito-mcp", "--health"]
  interval: 30s
```

---

## Remote MCP over HTTP (OAuth 2.1)

By default `avito-mcp` speaks **stdio** — perfect for a local client. It can also run as a **remote** MCP server: the same 148 tools served over the network via **Streamable HTTP**, so a hosted agent, a team, or a phone-based client can connect to one shared instance. Access is gated by **OAuth 2.1** (authorization-code + PKCE + Dynamic Client Registration), with a human-in-the-loop consent screen.

### Turn it on

```bash
AVITO_MCP_TRANSPORT=http            # stdio (default) | http | both   (CLI: --http)
AVITO_MCP_HTTP_HOST=127.0.0.1       # Node always binds loopback; TLS is the proxy's job
AVITO_MCP_HTTP_PORT=3000
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com   # your public TLS domain, NO trailing slash
AVITO_MCP_HTTP_AUTH=oauth           # oauth (default) | bearer | none
AVITO_MCP_OAUTH_OWNER_PASSWORD=…    # REQUIRED in oauth mode — the only person who can mint a token
# Client_id / Client_secret / Profile_id as usual (the Avito credentials the remote server acts with)
```

`both` runs stdio **and** HTTP at once — handy when one process serves a local client and a remote one simultaneously.

### How the OAuth flow works

1. A client hits `/.well-known/oauth-protected-resource/mcp` (the RFC 9728 path-suffixed URL the 401's `WWW-Authenticate` header points to), discovers the authorization server, and reads `/.well-known/oauth-authorization-server`.
2. The client **self-registers** via Dynamic Client Registration (`POST /register`) — no manual client setup.
3. It runs **authorization-code + PKCE**: opens `/authorize` in a browser.
4. A **human approves** at `/authorize` by entering `AVITO_MCP_OAUTH_OWNER_PASSWORD`. This is the gate — without the owner password no token is ever issued, and the approval endpoint is rate-limited against brute force.
5. The client exchanges the code at `/token` for a bearer token (TTL `AVITO_MCP_OAUTH_TOKEN_TTL_SEC`, default 3600s), and that token guards every `/mcp` request.

| Endpoint | Purpose |
|---|---|
| `/mcp` | Streamable HTTP MCP transport (the tools) |
| `/.well-known/oauth-authorization-server` | OAuth 2.1 AS metadata |
| `/.well-known/oauth-protected-resource/mcp` | Resource-server metadata for `/mcp` (RFC 9728 path-suffixed) |
| `/authorize` | Consent screen — human enters the owner password (rate-limited) |
| `/token` | Authorization-code → bearer token exchange |
| `/register` | Dynamic Client Registration (DCR) |
| `/revoke` | Token revocation (RFC 7009) |
| `/healthz` | Liveness probe (no auth — answers only `{ok, name, version}`) |

### All HTTP / OAuth env vars

| Variable | Default | Meaning |
|---|---|---|
| `AVITO_MCP_TRANSPORT` | `stdio` | `stdio` \| `http` \| `both` (CLI flag `--http`) |
| `AVITO_MCP_HTTP_HOST` | `127.0.0.1` | Bind address — keep it loopback behind a proxy |
| `AVITO_MCP_HTTP_PORT` | `3000` | Listen port |
| `AVITO_MCP_HTTP_PUBLIC_URL` | — | Public TLS base used to build OAuth issuer / resource metadata. **No trailing slash.** |
| `AVITO_MCP_HTTP_AUTH` | `oauth` | `oauth` \| `bearer` \| `none` |
| `AVITO_MCP_OAUTH_OWNER_PASSWORD` | — | **Required in `oauth` mode.** Gates `/authorize` — the only secret that mints a token. |
| `AVITO_MCP_OAUTH_TOKEN_TTL_SEC` | `3600` | Issued bearer-token lifetime |
| `AVITO_MCP_OAUTH_STORE_FILE` | — | Optional file to persist issued tokens/clients across restarts |
| `AVITO_MCP_HTTP_AUTH_TOKEN` | — | `bearer` mode: shared secret(s), comma-separated |
| `AVITO_MCP_HTTP_ALLOW_NO_AUTH` | `0` | Allow `auth=none` on a non-loopback host (**discouraged**) |
| `AVITO_MCP_HTTP_ALLOWED_HOSTS` | derived | CSV — DNS-rebinding protection (accepted `Host` values). When unset, derived from the public URL + bind address — protection is **on by default** (off only for a wildcard bind with no public URL) |
| `AVITO_MCP_HTTP_ALLOWED_ORIGINS` | derived | CSV — DNS-rebinding protection (accepted `Origin` values). Same derivation as above |
| `AVITO_MCP_HTTP_MAX_SESSIONS` | `100` | Max concurrent Streamable HTTP sessions — `initialize` beyond it → 503 |
| `AVITO_MCP_HTTP_SESSION_IDLE_SEC` | `1800` | Sessions idle longer than this are reaped (clients that vanished without `DELETE`) |

> **Security model.** Node binds `127.0.0.1` and speaks plain HTTP. **TLS is terminated by a reverse proxy** (nginx / Caddy) on your domain, which forwards to `http://127.0.0.1:3000`. Never expose port 3000 directly to the internet. `auth=none` on a public host is refused unless you set `AVITO_MCP_HTTP_ALLOW_NO_AUTH=1`.

### Reverse-proxy snippets (terminate TLS for `https://mcp.example.com`)

Both proxy the MCP endpoint, the OAuth discovery/flow endpoints, and the webhook path, and **preserve the `Host` header** (the OAuth metadata is built from it).

<details open>
<summary><b>nginx</b></summary>

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    # MCP transport + OAuth (discovery, authorize, token, register, revoke) + webhook receiver.
    location ~ ^/(mcp|\.well-known/oauth-authorization-server|\.well-known/oauth-protected-resource|authorize|token|register|revoke|avito/webhook) {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header   Host              $host;          # preserve Host — OAuth metadata depends on it
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;

        # Streamable HTTP keeps long-lived responses open:
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```
</details>

<details>
<summary><b>Caddy</b></summary>

```caddyfile
mcp.example.com {
    # Caddy obtains and renews the TLS cert automatically.
    # Caddy preserves the Host header by default (no header_up needed).
    reverse_proxy /mcp* http://127.0.0.1:3000
    reverse_proxy /.well-known/oauth-authorization-server* http://127.0.0.1:3000
    reverse_proxy /.well-known/oauth-protected-resource*   http://127.0.0.1:3000
    reverse_proxy /authorize* http://127.0.0.1:3000
    reverse_proxy /token*     http://127.0.0.1:3000
    reverse_proxy /register*  http://127.0.0.1:3000
    reverse_proxy /revoke*    http://127.0.0.1:3000
    reverse_proxy /avito/webhook* http://127.0.0.1:3000
}
```
</details>

### Quicker: bearer mode

If you control both ends and don't need the full OAuth dance, set `AVITO_MCP_HTTP_AUTH=bearer` and a shared secret:

```bash
AVITO_MCP_TRANSPORT=http
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com
AVITO_MCP_HTTP_AUTH=bearer
AVITO_MCP_HTTP_AUTH_TOKEN=long-random-secret,another-secret   # one or more, comma-separated
```

Clients then send `Authorization: Bearer long-random-secret` to `/mcp`. The same reverse-proxy config applies.

---

## Avito webhook receiver

Polling `messenger_get_chats_v2` works, but for **real-time** reactions (reply the instant a customer writes) Avito can **push** events to you. The server ships a built-in receiver: point Avito at a secret URL and every event is buffered for your agent to read.

This works **even in pure stdio mode** — Avito only needs a public URL to POST to; your MCP client never touches it. (If `AVITO_MCP_TRANSPORT=stdio` and a webhook secret is set, the server still starts a tiny HTTP listener just for the receiver.)

### Turn it on

```bash
AVITO_MCP_WEBHOOK_SECRET=…                              # enables the receiver; becomes a secret path segment
AVITO_MCP_WEBHOOK_PUBLIC_URL=https://mcp.example.com    # public base Avito POSTs to (defaults to the HTTP public URL)
# AVITO_MCP_WEBHOOK_PATH=/avito/webhook                 # default
# AVITO_MCP_WEBHOOK_BUFFER=100                          # ring-buffer size (events kept in memory)
# AVITO_MCP_WEBHOOK_LOG_FILE=/var/log/avito-webhook.jsonl   # optional JSONL audit log
```

Avito then delivers to:

```
POST {AVITO_MCP_WEBHOOK_PUBLIC_URL}{AVITO_MCP_WEBHOOK_PATH}/{AVITO_MCP_WEBHOOK_SECRET}
  → 200 {"ok":true}      (answered in well under Avito's 2-second deadline)
```

The secret is part of the path, so the URL is unguessable — that's the auth. The URL must be **public HTTPS** (the server refuses to register loopback/private addresses with Avito). Subscribe the URL with Avito either through your account or in one call with the `messenger_register_webhook` tool.

| Variable | Default | Meaning |
|---|---|---|
| `AVITO_MCP_WEBHOOK_SECRET` | — | Enables the receiver; the unguessable path segment Avito must hit. **Required** — without it the receiver stays disabled |
| `AVITO_MCP_WEBHOOK_ENABLED` | `1` when a secret is set | Explicit toggle: set `0` to disable without unsetting the secret. `1` without a secret does nothing (warned at startup) |
| `AVITO_MCP_WEBHOOK_PUBLIC_URL` | (HTTP public URL) | Public base Avito POSTs to |
| `AVITO_MCP_WEBHOOK_PATH` | `/avito/webhook` | Path prefix before the secret segment |
| `AVITO_MCP_WEBHOOK_BUFFER` | `100` | In-memory ring-buffer size |
| `AVITO_MCP_WEBHOOK_LOG_FILE` | — | Optional JSONL file — every raw event appended for audit/replay |

### Consuming events

| Surface | What it gives you |
|---|---|
| `messenger_get_webhook_events` (tool, read) | Drain buffered events — filter by `chat_id`, `since`, `limit` |
| `messenger_get_webhook_status` (tool, read) | Receiver stats: retained / total received / last received at / buffer size |
| `messenger_register_webhook` (tool, ⚠️ write) | Subscribe the configured public URL with Avito |
| `avito://webhook/events` (resource, **subscribable**) | The same events as an MCP resource; `resources/subscribe` for live push to your client |

A typical loop: subscribe to `avito://webhook/events`, and on each `notifications/resources/updated` read the new event, draft a reply, and (after confirmation) send it with `messenger_post_send_message`.

---

## Connect your AI client

The JSON snippet from the Quick Start section above works in **every** MCP-compatible client — only the path to the config file changes. Pick yours below:

<details>
<summary><b>Claude Desktop</b> (macOS / Windows / Linux)</summary>

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Create the file if it doesn't exist; otherwise add the `avito` entry to the existing `mcpServers` block. **Fully quit** Claude Desktop (system tray) and reopen — a `🔌 avito` indicator should appear at the bottom of the chat.

Logs: `~/Library/Logs/Claude/mcp-server-avito.log` (macOS).
</details>

<details>
<summary><b>Claude Code</b> (CLI)</summary>

Easiest — one command:

```bash
claude mcp add avito npx -y avito-mcp \
  -e Client_id=YOUR_CLIENT_ID \
  -e Client_secret=YOUR_CLIENT_SECRET \
  -e Profile_id=YOUR_PROFILE_ID
```

Or add `.mcp.json` to your project root (use the JSON from Quick Start, plus `"type": "stdio"`). Verify with `claude mcp list`.
</details>

<details>
<summary><b>Cursor</b></summary>

Path: `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (per-project). Use the Quick Start JSON as-is. Reload window after saving (`Cmd/Ctrl + Shift + P` → "Reload Window").
</details>

<details>
<summary><b>ChatGPT Desktop</b> (Connectors / MCP)</summary>

OpenAI's Desktop app added MCP server support via the Connectors UI. Settings → Connectors → Add custom MCP server → fill in:
- Name: `Avito`
- Type: `stdio`
- Command: `npx`
- Arguments: `-y avito-mcp`
- Environment variables: `Client_id`, `Client_secret`, `Profile_id`
</details>

<details>
<summary><b>Windsurf</b> (Codeium)</summary>

Path: `~/.codeium/windsurf/mcp_config.json`. Use the Quick Start JSON. Alternative: Settings → Cascade → MCP Servers → Add Server (UI).
</details>

<details>
<summary><b>Cline</b> (VS Code extension)</summary>

In VS Code: Cline icon → ⚙️ → MCP Servers → Edit `cline_mcp_settings.json`.

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Linux | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

Use the Quick Start JSON. Cline auto-reloads without VS Code restart.
</details>

<details>
<summary><b>Continue</b> (VS Code / JetBrains)</summary>

Add to `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "avito-mcp"],
          "env": { "Client_id": "...", "Client_secret": "...", "Profile_id": "..." }
        }
      }
    ]
  }
}
```
</details>

<details>
<summary><b>Zed</b></summary>

Open Settings (`Cmd+,`), find the `context_servers` block:

```json
{
  "context_servers": {
    "avito": {
      "command": {
        "path": "npx",
        "args": ["-y", "avito-mcp"],
        "env": { "Client_id": "...", "Client_secret": "...", "Profile_id": "..." }
      }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b> (GitHub Copilot Chat with MCP)</summary>

Microsoft added MCP support to Copilot Chat in 2025. Create `.vscode/mcp.json` in your workspace or use the Command Palette → "MCP: Add Server". Same Quick Start JSON.
</details>

<details>
<summary><b>Codex CLI</b> (OpenAI)</summary>

OpenAI's CLI assistant supports MCP via `~/.codex/config.toml`:

```toml
[mcp_servers.avito]
command = "npx"
args = ["-y", "avito-mcp"]
env = { Client_id = "...", Client_secret = "...", Profile_id = "..." }
```
</details>

<details>
<summary><b>JetBrains AI Assistant</b></summary>

Settings → Tools → AI Assistant → MCP → Add server. Fill the same fields (command `npx`, args `-y avito-mcp`, env variables). Applies to IntelliJ IDEA, PyCharm, WebStorm, GoLand, Rider.
</details>

<details>
<summary><b>Goose</b> (Block)</summary>

Block's open-source CLI agent. Add via `goose configure` → MCP server → paste the Quick Start JSON. Config lives in `~/.config/goose/config.yaml`.
</details>

<details>
<summary><b>Roo Code / Kilo Code</b> (Cline forks, VS Code)</summary>

Both are forks of Cline and use the same config format and path patterns — replace `saoudrizwan.claude-dev` in the path with the fork's extension ID (`rooveterinaryinc.roo-cline` or `kilocode.kilo-code`). JSON is identical.
</details>

<details>
<summary><b>LibreChat</b> (self-hosted ChatGPT alternative)</summary>

Edit `librechat.yaml`:

```yaml
mcpServers:
  avito:
    type: stdio
    command: npx
    args: ["-y", "avito-mcp"]
    env:
      Client_id: "..."
      Client_secret: "..."
      Profile_id: "..."
```
</details>

<details>
<summary><b>Cherry Studio</b></summary>

Settings → MCP Servers → Add. UI fields: name `avito`, command `npx`, args `-y avito-mcp`, env vars same as above.
</details>

<details>
<summary><b>Any other MCP client</b></summary>

The server speaks stock stdio MCP. Universal parameters:
- `command`: `npx`
- `args`: `["-y", "avito-mcp"]`
- `env`: `{ Client_id, Client_secret, Profile_id }`
- `transport`: `stdio`

Browse the [MCP clients directory](https://modelcontextprotocol.io/clients) for new ones.
</details>

---

## Example prompts

Drop these into your AI client to see what's possible:

**📊 Analyse**
- *"What's my Avito balance and how much did I spend on promotion this month?"*
- *"Top 10 listings by contacts last week — table with views/contacts/conversion."*
- *"Find listings whose calls dropped 50%+ compared to the previous week."*

**💬 Communicate**
- *"Show me unread chats from the last 24 hours and reply with: 'Hi! Yes, still available, where would you like delivery?'"*
- *"Read the full conversation in chat X and suggest the best next reply in my tone."*

**💰 Promote**
- *"Forecast a 1000₽ BBIP boost on item 12345 — is it worth it?"*
- *"Set a manual CPA bid of 500₽ on top-10 listings in category 'Electronics'."*

**📦 Fulfil**
- *"List all orders with status `ready_to_ship` and generate labels in a single PDF."*
- *"For order ABCD, find an available courier slot tomorrow morning."*

**🤖 Automate**
- *"Every weekday at 9am, send me Telegram with: balance, new orders count, unread chats count, top promotion spends."*
- *"If any chat has been unread for 6+ hours, draft a reply and ping me to approve."*

---

## What's NOT supported

Avito provides **separate APIs** for the following verticals — their swagger specs are not bundled:

| Category | Where to find |
|---|---|
| 🏷️ Auction | [Avito Auction API](https://developers.avito.ru/api-catalog/auction/documentation) |
| 🤖 Auto-strategies (automated bidding) | [Avito Autostrategy API](https://developers.avito.ru/api-catalog/autostrategy/documentation) |
| 🚗 Autoteka (vehicle history) | [Avito Autoteka API](https://developers.avito.ru/api-catalog/autoteka/documentation) |
| 💼 Jobs / Vacancies | [Avito Jobs API](https://developers.avito.ru/api-catalog/job/documentation) |
| 📊 Real-estate reports | [Avito Realty Reports API](https://developers.avito.ru/api-catalog/realty-reports/documentation) |
| 🏠 Short-term rent | [Avito STR API](https://developers.avito.ru/api-catalog/str/documentation#ApiDescriptionBlock) |

Also out of scope: the `authorization_code` OAuth flow against Avito itself (no public redirect URI on a local CLI) and the Avito sandbox (Avito issues no sandbox credentials — every call hits production).

---

## Security

- **Local stdio by default** — no proxy, no remote endpoints, no telemetry. The optional [remote HTTP mode](#remote-mcp-over-http-oauth-21) is opt-in (`AVITO_MCP_TRANSPORT=http`), binds loopback, and is guarded by OAuth 2.1 (or a bearer secret) behind your own TLS proxy, with DNS-rebinding protection on by default.
- Credentials live in your MCP client's `env` block or local `.env`. They're never sent anywhere except `api.avito.ru`.
- OAuth tokens cached in a per-user state directory (chmod 600):
  - Linux: `$XDG_STATE_HOME/avito-mcp/token.json` (≈ `~/.local/state/avito-mcp/token.json`)
  - macOS: `~/Library/Application Support/avito-mcp/token.json`
  - Windows: `%APPDATA%\avito-mcp\token.json`
  - Override with `AVITO_TOKEN_FILE`. Delete the file to force a refresh.
- **Three-layer safety model** (every layer opt-in via env vars; the defaults keep trivial reads frictionless but harden everything destructive):
  - **`AVITO_MCP_MODE`** (`read_only` / `guarded` / `full_access`) — registration-time gate. Hidden tools never appear in `tools/list`. `read_only` ≈ 82 tools, `guarded` adds writes (~125 tools), `full_access` is the full 141 Avito + 7 meta (+ opt-in extras).
  - **`AVITO_MCP_ALLOW_TOOLS` / `AVITO_MCP_DENY_TOOLS`** — per-tool gating. Deny wins over allow.
  - **`AVITO_MCP_CONFIRMATION_MODE`** (`off` / `money_public` (default) / `all_destructive`) — runtime gate. Destructive tools return `{requires_confirmation: true, confirmation_id: ...}`; the agent must call `meta_confirm_action` to execute. Pending state is in-memory, TTL'd (default 15 min), one-shot. `AVITO_MCP_CONFIRMATION_SECRET` upgrades this to **hard confirmation** — only a human who knows the secret can approve.
  - **`AVITO_MCP_EXPOSE_AUTH_TOOLS`** (default: `0`) — `auth_*` tools return OAuth tokens; classed as `sensitive` and hidden by default even in `full_access`.
  - **`AVITO_MCP_ALLOWED_UPLOAD_DIRS`** — `messenger_upload_images` reads files from disk; without an explicit directory allowlist it doesn't register at all. Path validation uses `realpath` (symlink-escape proof), extension allowlist (jpg/jpeg/png/webp), size cap (`AVITO_MCP_MAX_UPLOAD_MB`, default 15), magic-byte sniff with extension cross-check.
- Every tool is tagged with one of five risks (`sensitive` / `read` / `write` / `money` / `public`), exposed as MCP `ToolAnnotations` (`readOnlyHint`, `destructiveHint`) and as `_meta.risk`, and listed in [`dist/manifest.json`](./dist/manifest.json). Well-behaved MCP clients warn before destructive calls.
- See [`docs/safety.md`](./docs/safety.md) for ready-to-paste configs (analytics-only, customer-support with confirmation, listings-only, full admin) and a frank discussion of what the confirmation flow is and isn't (it's a server-side two-step + audit layer, not a cryptographic human-approval mechanism — unless you add the hard-confirmation secret).
- **All 141 Avito tools hit production** — Avito has no sandbox. Write methods cost real money or are visible to real customers. Safe read-only tools for first runs: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.
- **Found a security issue?** Private reporting via [SECURITY.md](./SECURITY.md) — don't open a public issue.

---

## Versioning & stability

As of **v1.0.0** the public surface is covered by [SemVer](https://semver.org):

- **Stable (breaking change ⇒ major bump):** tool names and their input schemas, env var names and defaults, resource URIs (`avito://…`), prompt names, the risk classification model, the structured error taxonomy, and the CLI flags.
- **Additive (minor bump):** new tools when Avito ships new endpoints, new opt-in env vars, new resources/prompts.
- **Patch:** bug fixes, security hardening, doc corrections, dependency bumps.

The bundled Avito swagger snapshot is data, not API — refreshing it (and the tools that follow from it) is a minor bump as long as existing tool names keep working.

---

## Community & support

- **Bug?** [Open an issue](https://github.com/elchin92/avito-mcp/issues/new/choose).
- **Question or idea?** [Start a discussion](https://github.com/elchin92/avito-mcp/discussions).
- **Need help picking the right tool or setting up your client?** See [SUPPORT.md](./SUPPORT.md).
- **Want to contribute?** Adding a new Avito swagger takes ~10 minutes — see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Like the project?** Star the repo and tell another Avito seller who uses AI.

---

## Install from source

For development, air-gapped installs, or when you want to modify a tool:

```bash
git clone https://github.com/elchin92/avito-mcp.git
cd avito-mcp
npm install
cp .env.example .env       # fill in your credentials
npm run build
```

Then point your MCP client at:
```json
{ "command": "node", "args": ["/absolute/path/to/avito-mcp/dist/server.js"] }
```

A template config is in [.mcp.json.example](./.mcp.json.example). A multi-stage [`Dockerfile`](./Dockerfile) is included for container deployments.

### CLI flags

```bash
npx avito-mcp --version    # print the installed version
npx avito-mcp --help       # show env vars + usage
```

All other knobs are env vars (see `--help` output or [.env.example](./.env.example)).

---

## Contributing

Adding a new Avito swagger? **One file in `src/domains/` plus one line in `src/meta/domain-registry.ts`** — see [CONTRIBUTING.md](./CONTRIBUTING.md). The factory in `src/core/tool-factory.ts` handles HTTP, OAuth, retries, rate-limit observability, error mapping, and Profile_id auto-injection — you'll never write a `fetch()` call inside a tool.

Issues and PRs welcome.

---

## License

[MIT](./LICENSE). Not affiliated with Avito.ru. "Avito" is a trademark of its respective owner. Use of the Avito API is subject to Avito's Terms of Service.
