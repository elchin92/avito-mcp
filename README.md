# avito-mcp

[![npm version](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![npm downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

> **Give your AI agents hands and feet on Avito** — Russia's largest classifieds marketplace.
> Run the entire business autonomously: answer customers, manage listings, promote, fulfil orders, analyse stats.
> Hands-off, fully local — stdio transport, your credentials never leave your machine.

🇷🇺 **[Русская версия / Russian version →](./README.ru.md)**

---

## What it does

Local **MCP (Model Context Protocol)** server wrapping **139 tools** across **18 Avito API domains**.
Works with **Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, Zed**, and any MCP-compatible client.

## Install (2 minutes)

**1.** Get OAuth credentials from the [Avito API portal](https://www.avito.ru/professionals/api): `Client_id`, `Client_secret`, and your `Profile_id`.

**2.** Add to your MCP client's config (the JSON is identical across clients — only the config-file path differs):

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

**3.** Restart your client. Ask your agent: *"What's my Avito balance?"* → done.

### Where the config file lives

| Client | Config path |
|---|---|
| **Claude Desktop** | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows: `%APPDATA%\Claude\claude_desktop_config.json` · Linux: `~/.config/Claude/claude_desktop_config.json` |
| **Claude Code** | `~/.claude.json` (or run `claude mcp add avito npx -y avito-mcp -e Client_id=... -e Client_secret=... -e Profile_id=...`) |
| **Cursor** | `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` |
| **Cline** (VS Code) | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Continue** | `~/.continue/config.json` (under `experimental.modelContextProtocolServers`) |
| **Zed** | Settings → `context_servers` block |

Detailed per-client walk-throughs (including troubleshooting) are in [README.ru.md](./README.ru.md#подключение-к-ai-клиентам) — the JSON is identical, only the wrapping varies slightly.

## What's included (139 tools)

| Domain | Tools | What you can do |
|---|---|---|
| `items_*` | 11 | Read/update listings, prices, stats, paid VAS |
| `messenger_*` | 14 | Chats, messages, image upload, webhooks |
| `orders_*` | 12 | Orders, status transitions, shipping labels |
| `autoload_*` | 17 | XML/YML feed uploads, reports |
| `delivery_*` | 31 | Partner delivery API (3PL — for delivery service providers) |
| `cpa_*` + `promotion_*` + `cpa_target_*` + `cpa_auction_*` | 25 | CPA, auctions, BBIP promotion, bid management |
| `user_*` / `stock_*` / `hierarchy_*` / `reviews_*` | 14 | Profile, balance, inventory, employees, reviews |
| `tariffs_*` / `trxpromo_*` / `calltracking_*` / `msg_discounts_*` | 12 | Tariffs, trx-promo, call-tracking, discount campaigns |
| `auth_*` / `meta_*` | 4 | OAuth tokens, rate-limit observability |

## What's NOT supported

Avito provides **separate APIs** for these verticals — their swagger specs are not bundled here:

| Category | Where to find |
|---|---|
| 🚗 **Cars** (auto, trucks, special vehicles) | [Avito Auto API](https://developers.avito.ru/api-catalog/auto/documentation) |
| 🏠 **Real estate** | [Avito Real Estate API](https://developers.avito.ru/api-catalog/realty/documentation) |
| 💼 **Jobs / Vacancies** | [Avito Jobs API](https://developers.avito.ru/api-catalog/job/documentation) |

Also out of scope in v0.1.x: `authorization_code` OAuth flow (no public redirect URI on a local CLI), webhook receiver (needs a public URL), Avito sandbox (no sandbox credentials).

## Security

- **stdio transport** — no proxy servers, no remote endpoints, all traffic stays on your machine.
- Credentials live in your MCP client's `env` block or in a local `.env` file.
- OAuth token cached at `$cwd/.avito-token.json` (chmod 600); delete it to force a refresh.
- The server talks **only** to `api.avito.ru` (hardcoded base URL).
- **All 139 tools hit production** — there is no Avito sandbox. Write methods (price changes, paid promotion, messages to customers) cost real money or affect real users. Safe read-only smoke-tools: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.

## Install from source (alternative to npx)

```bash
git clone https://github.com/elchin92/avito-mcp.git
cd avito-mcp
npm install
cp .env.example .env       # then fill in your credentials
npm run build
```

Then point your MCP client at the built file:

```json
{ "command": "node", "args": ["/absolute/path/to/avito-mcp/dist/server.js"] }
```

## Contributing

Adding a new Avito swagger spec? **One file in `src/domains/` plus one line in `src/meta/domain-registry.ts`** — see [CONTRIBUTING.md](./CONTRIBUTING.md). The architecture is intentionally minimal so you never write a `fetch()` call inside a tool handler.

## License

[MIT](./LICENSE). Not affiliated with Avito.ru. "Avito" is a trademark of its respective owner. Use of the Avito API is subject to Avito's Terms of Service.
