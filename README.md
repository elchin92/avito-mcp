# avito-mcp

[![npm version](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![npm downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![CI](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-39_passing-brightgreen)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![GitHub stars](https://img.shields.io/github/stars/elchin92/avito-mcp?style=social)](https://github.com/elchin92/avito-mcp/stargazers)
[![Avito API snapshot](https://img.shields.io/badge/Avito_API_snapshot-2026--05--25-orange)](./swaggers)

> **Give your AI agents hands and feet on Avito.**
> Local MCP server that lets Claude, Cursor, Cline and any other AI assistant **do real work on Avito for you** — answer customers, manage listings, run promotions, fulfil orders, analyse stats. **139 tools** across **18 official Avito APIs**, one `npx` command to install.

🇷🇺 **[Русская версия / Russian version →](./README.ru.md)**

---

## What it does

Avito is Russia's largest classifieds marketplace (~250M monthly visits). Selling there involves dozens of repetitive operations every day: replying in chats, refreshing listings, applying paid promotion, generating shipping labels, watching stats.

`avito-mcp` exposes every public Avito API as a tool your AI agent can call. Plug it into your favourite MCP client and your agent can run an entire Avito storefront — autonomously — from natural language.

- 🔌 **Universal** — works with 15+ MCP clients (Claude Desktop, Cursor, Cline, Continue, Windsurf, Zed, ChatGPT, …)
- 🔒 **Local-only** — stdio transport, your OAuth credentials never leave your machine
- 🤖 **Built for autonomy** — pairs naturally with multi-agent runtimes and cron-scheduled agents for hands-off, always-on operation
- ⚡ **Zero install** — `npx -y avito-mcp`, no clone/build, no Docker

---

## Quick start (≈90 seconds)

**1.** Get OAuth credentials from the [Avito Developer Portal](https://www.avito.ru/professionals/api): `Client_id`, `Client_secret`, and your `Profile_id` (your numeric account ID, shown on the same page).

**2.** Add this snippet to your MCP client's config (the JSON is **the same for every client** — only the file path differs, see the next section):

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

- **Reactive agent** — a Claude/Cursor session permanently open, monitoring chats and replying to customers in your tone of voice.
- **Cron-scheduled agent** — a runtime fires up your agent every N minutes to triage new orders, top up promotion budgets, refresh stats.
- **Multi-agent swarm** — separate agents for "support", "promotion", "logistics" each holding only the tools they need.

The stdio transport keeps every credential and API response on your machine. No proxy. No SaaS in the middle.

→ See the full list of compatible runtimes at [modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients).

---

## What's included — 139 tools

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
<summary>💬 <b>Messenger</b> — 13 tools (messenger_*)</summary>

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
- + 6 deprecated v1 endpoints, kept under their original names for compatibility
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

Also out of scope: `authorization_code` OAuth flow (no public redirect URI on a local CLI), webhook receiver (needs a public URL), Avito sandbox (no sandbox credentials).

---

## Security

- **Local stdio only** — no proxy, no remote endpoints, no telemetry.
- Credentials live in your MCP client's `env` block or local `.env`. They're never sent anywhere except `api.avito.ru`.
- OAuth tokens cached in a per-user state directory (chmod 600):
  - Linux: `$XDG_STATE_HOME/avito-mcp/token.json` (≈ `~/.local/state/avito-mcp/token.json`)
  - macOS: `~/Library/Application Support/avito-mcp/token.json`
  - Windows: `%APPDATA%\avito-mcp\token.json`
  - Override with `AVITO_TOKEN_FILE`. Delete the file to force a refresh.
- **`AVITO_SAFE_MODE=read-only`** — set this env var and the server blocks every tool that writes data, costs money, or is visible to customers. Only `read` tools (GETs and POST-as-query analytics) execute. Recommended for unattended agents and first runs.
- Every tool is marked with one of four risk levels (`read` / `write` / `money` / `public`) and exposed as MCP `ToolAnnotations` (`readOnlyHint`, `destructiveHint`) so well-behaved clients can warn before destructive calls.
- **All 139 tools hit production** — Avito has no sandbox. Write methods cost real money or are visible to real customers. Safe read-only tools for first runs: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.
- **Found a security issue?** Private reporting via [SECURITY.md](./SECURITY.md) — don't open a public issue.

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

A template config is in [.mcp.json.example](./.mcp.json.example).

### CLI flags

```bash
npx avito-mcp --version    # print the installed version
npx avito-mcp --help       # show env vars + usage
```

The server has no other flags by design — all knobs are env vars (see `--help` output).

---

## Contributing

Adding a new Avito swagger? **One file in `src/domains/` plus one line in `src/meta/domain-registry.ts`** — see [CONTRIBUTING.md](./CONTRIBUTING.md). The factory in `src/core/tool-factory.ts` handles HTTP, OAuth, retries, rate-limit observability, error mapping, and Profile_id auto-injection — you'll never write a `fetch()` call inside a tool.

Issues and PRs welcome.

---

## License

[MIT](./LICENSE). Not affiliated with Avito.ru. "Avito" is a trademark of its respective owner. Use of the Avito API is subject to Avito's Terms of Service.
