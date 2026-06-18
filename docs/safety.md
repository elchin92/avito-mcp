# Safety configuration / Безопасные конфигурации

`avito-mcp` is designed to run on real production Avito accounts — Avito has no sandbox. Out of the box, every tool is available, and write methods cost real money or are visible to real customers. **You should configure the safety surface before pointing an autonomous agent at it.**

This doc gives you pre-baked configurations covering common agent personas. Pick the closest one to what you're building, copy the env vars into your MCP-client config or `.env`, and you're done.

The safety model is built around **three orthogonal layers**:

1. **Registration-time gate** (`AVITO_MCP_MODE` + `AVITO_MCP_ALLOW_TOOLS` / `AVITO_MCP_DENY_TOOLS` + `AVITO_MCP_EXPOSE_AUTH_TOOLS`) — decides which tools the agent sees at all.
2. **Upload guard** (`AVITO_MCP_ALLOWED_UPLOAD_DIRS` + `AVITO_MCP_MAX_UPLOAD_MB`) — fail-closed local-file-access boundary for `messenger_upload_images`.
3. **Runtime confirmation flow** (`AVITO_MCP_CONFIRMATION_MODE`) — destructive tools return a pending action; agent must call `meta_confirm_action` to execute.

Every tool is tagged with one of five risks at build time:

| risk | meaning | examples |
|---|---|---|
| `sensitive` | returns secrets / tokens; **hidden by default**, opt-in via `AVITO_MCP_EXPOSE_AUTH_TOOLS=1` | `auth_get_access_token`, `auth_refresh_access_token_authorization_code` |
| `read` | GETs and POST-as-query (analytics, info, balance) | `items_get_items_info`, `user_get_user_balance`, `meta_get_rate_limits` |
| `write` | modifies your own data, no immediate customer impact, no money spent | `messenger_chat_read`, `messenger_upload_images`, `autoload_create_or_update_profile`, `messenger_register_webhook` |
| `money` | spends balance | `items_put_item_vas`, `cpa_auction_save_item_bids`, `promotion_create_bbip_order_for_items_v1` |
| `public` | visible to customers or third parties | `messenger_post_send_message`, `items_update_price`, `orders_apply_transition`, `reviews_create_review_answer_v1`, `stock_update_stocks` |

You can always check the exact classification of every tool in [`dist/manifest.json`](../dist/manifest.json) after installing the package (run `npm run generate:manifest` to rebuild).

> **v0.9.0 webhook receiver tools.** The three local webhook tools follow the same model: `messenger_get_webhook_events` and `messenger_get_webhook_status` are `read` (they only inspect the in-process buffer), while `messenger_register_webhook` is `write` — it changes account settings by subscribing Avito to a delivery URL. The receiver itself is opt-in (`AVITO_MCP_WEBHOOK_SECRET`) and authenticates deliveries by an unguessable secret path segment.

---

## Persona 1 — Analytics agent (read-only)

Use case: dashboards, monitoring, "summarise yesterday's results", reports. Cannot change anything.

```bash
AVITO_MCP_MODE=read_only
```

That's the entire config. ~82 tools registered, every one of them safe to call in any sequence.

**What works:** all statistics (`items_post_item_analytics`, `items_post_account_spendings`, `items_post_calls_stats`), balance (`user_get_user_balance`), chat history (`messenger_get_chats_v2`, `messenger_get_messages_v3`), order list (`orders_get_orders`), reports (`autoload_get_reports_v2`), rate limits (`meta_get_rate_limits`).

**What doesn't:** anything that could change state. Even marking a chat as read is hidden. `auth_*` tools are also hidden by default (they're `sensitive`, not `read`).

---

## Persona 2 — Customer-support agent (read + reply, with confirmation)

Use case: an agent that reads incoming messages, drafts replies, marks chats as read. It can talk to customers but **every send still requires explicit confirmation**.

```bash
AVITO_MCP_MODE=full_access
AVITO_MCP_CONFIRMATION_MODE=money_public
AVITO_MCP_ALLOW_TOOLS=user_get_user_info_self,user_get_user_balance,items_get_items_info,items_get_item_info,messenger_get_chats_v2,messenger_get_chat_by_id_v2,messenger_get_messages_v3,messenger_get_voice_files,messenger_chat_read,messenger_post_send_message,messenger_post_send_image_message,messenger_upload_images,meta_get_rate_limits,meta_confirm_action,meta_cancel_action,meta_list_pending_actions
# If you need image uploads:
AVITO_MCP_ALLOWED_UPLOAD_DIRS=/path/where/agent/drops/photos
```

How it works: `messenger_post_send_message` returns `{"requires_confirmation": true, "confirmation_id": "..."}` instead of executing. The agent must call `meta_confirm_action` with that id to actually send. This forces a server-side two-step. (See the disclaimer below — this is not absolute protection against an autonomous agent that decides to call `meta_confirm_action` itself; pair this with an MCP client that requires human approval per tool call.)

If you want the agent to send without any friction, set `AVITO_MCP_CONFIRMATION_MODE=off`.

---

## Persona 3 — Listings and stock agent (no messaging, no spending)

Use case: agent that manages inventory and listings — keeps stock fresh, generates labels, processes orders. **Doesn't talk to customers, doesn't spend money on promotion.**

```bash
AVITO_MCP_MODE=full_access
AVITO_MCP_DENY_TOOLS=items_put_item_vas,items_put_item_vas_package_v2,items_apply_vas,promotion_create_bbip_order_for_items_v1,cpa_auction_save_item_bids,cpa_target_save_auto_bid,cpa_target_save_manual_bid,trxpromo_apply,msg_discounts_open_api_multi_confirm,messenger_post_send_message,messenger_post_send_image_message,messenger_upload_images,messenger_delete_message,reviews_create_review_answer_v1,reviews_remove_review_answer_v1
AVITO_MCP_CONFIRMATION_MODE=money_public
```

The agent can:

- update stock (`stock_update_stocks` — note this is `public` and would normally be blocked by `guarded` mode; here it executes but goes through confirmation)
- read everything
- manage orders (`orders_generate_labels`, `orders_apply_transition`, `orders_set_tracking_number`)
- process autoload reports

But cannot:

- send any message
- buy any VAS / promotion
- reply to reviews
- upload images (hidden — no allowed dirs)

Note that `items_update_price` is **not** in the denylist here — it's `public` and so it still works, but goes through confirmation. Add it to the denylist if you want it fully blocked.

---

## Persona 4 — Full admin (everything goes)

Use case: you, the human, running the MCP server in Claude Desktop / Cursor / Claude Code for interactive ad-hoc work. The agent always asks before destructive calls because *you're* the human-in-the-loop.

```bash
AVITO_MCP_MODE=full_access
AVITO_MCP_CONFIRMATION_MODE=off    # opt out of the runtime gate
```

That's it. **141 tools register** under this exact config: all Avito tools except the 3 `sensitive` auth tools (opt-in via `AVITO_MCP_EXPOSE_AUTH_TOOLS=1`) and `messenger_upload_images` (needs `AVITO_MCP_ALLOWED_UPLOAD_DIRS`), plus 4 meta tools — with confirmation off the three `meta_*_action` tools don't register at all. No confirmation friction. Well-behaved MCP clients (Claude Desktop, Cursor) will still warn you before any `destructiveHint: true` tool runs — that's the `money` and `public` set — because those annotations are on every tool.

This is the closest to the v0.1.x default behaviour. **Don't use this for unattended cron jobs.**

---

## On the confirmation flow — what it is and isn't

The confirmation flow (`AVITO_MCP_CONFIRMATION_MODE != off`) is a **server-side two-step safety guard against accidental one-shot execution**. It's also an **audit layer** — every destructive action shows up as a pending entry, and there's a paper trail.

It is **not a cryptographic human-approval mechanism by itself.** An autonomous agent can theoretically:

1. Call `items_put_item_vas` → receive a `confirmation_id`
2. Call `meta_confirm_action` with that id

Both calls go through the same MCP transport. There's no out-of-band proof that a human approved.

To turn the confirmation flow into something closer to a real human gate, pair it with one of:

- **An MCP client that requires per-tool-call user approval** (Claude Desktop and Cursor both do this for unfamiliar tools). The agent literally cannot dispatch `meta_confirm_action` without the user clicking allow.
- **`AVITO_MCP_CONFIRMATION_SECRET`** (shipped in v0.5.0; hardened in v1.1.0) — when set, `meta_confirm_action` requires the matching `confirmation_secret` argument, compared in constant time. The agent never sees the secret; only the human can type it. This converts soft-confirmation into hard-confirmation. As of v1.1.0 the secret **must be at least 32 characters** (the server refuses to start otherwise), and **5 wrong/missing attempts delete the pending action** to blunt brute-forcing. See `.env.example` for setup (`openssl rand -base64 32`).

For the use cases this server is designed for (humans-in-the-loop using Claude Desktop / Cursor for Avito), the confirmation flow is the right layer.

---

## Defence in depth

Even with a strict mode, you should always:

- **Restrict the OAuth scopes** at the Avito API key level to the minimum your agent actually needs. Avito offers scope selection when creating a key.
- **Run with a low-balance test account** for first experiments. Top up just enough that one bad call doesn't drain your real budget.
- **Read the server startup log** (stderr) — at boot the server logs `mode`, `allowToolsCount`, `denyToolsCount`, `exposeAuthTools`, `uploadDirsCount`, `confirmationMode` and emits a `tool hidden by policy` line for every tool that was suppressed. Verify the count matches what you expected.
- **Inspect [`dist/manifest.json`](../dist/manifest.json)** — it's the single source of truth on what's classified as what. If you disagree with a classification, open an issue.
- **For unattended agents, prefer `read_only` or `guarded` + denylist** over `full_access`. The smaller the surface, the smaller the blast radius if something goes wrong.

## Future work

- **Per-tool spending limits** — cap the cost of an autonomous session at e.g. ₽500/day across all `money` tools.

Already shipped from this list: `AVITO_MCP_CONFIRMATION_SECRET` hard-confirmation (v0.5.0), structured base64+mimeType binary responses (v0.5.x), `environment` metadata on tools (v0.5.x).

If anything else is critical to your use case, open an issue or a discussion.
