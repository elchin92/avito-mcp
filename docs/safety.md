# Safety configuration / Безопасные конфигурации

`avito-mcp` is designed to run on real production Avito accounts — Avito has no sandbox. Out of the box, every tool is available, and write methods cost real money or are visible to real customers. **You should configure the safety surface before pointing an autonomous agent at it.**

This doc gives you four pre-baked configurations covering common agent personas. Pick the closest one to what you're building, copy the env vars into your MCP-client config or `.env`, and you're done.

The safety model is built around two orthogonal axes:

1. **`AVITO_MCP_MODE`** — broad capability gate. Hides whole risk categories.
2. **`AVITO_MCP_ALLOW_TOOLS` / `AVITO_MCP_DENY_TOOLS`** — fine-grained per-tool gating. Deny always wins.

Every tool is tagged with one of four risks at build time:

| risk | meaning | examples |
|---|---|---|
| `read` | GETs and POST-as-query (analytics, info, balance) | `items_get_items_info`, `user_get_user_balance`, `meta_get_rate_limits` |
| `write` | modifies your own data, no immediate customer impact, no money spent | `messenger_chat_read`, `stock_get_stocks_info`, `autoload_create_or_update_profile` |
| `money` | spends balance | `items_put_item_vas`, `cpa_auction_save_item_bids`, `promotion_create_bbip_order_for_items_v1` |
| `public` | visible to customers or third parties | `messenger_post_send_message`, `items_update_price`, `orders_apply_transition`, `reviews_create_review_answer_v1` |

You can always check the exact classification of every tool in [`dist/manifest.json`](../dist/manifest.json) after installing the package (run `npm run generate:manifest` to rebuild).

---

## Persona 1 — Analytics agent (read-only)

Use case: dashboards, monitoring, "summarise yesterday's results", reports. Cannot change anything.

```bash
AVITO_MCP_MODE=read_only
```

That's the entire config. ~79 tools registered, every one of them safe to call in any sequence.

**What works:** all statistics (`items_post_item_analytics`, `items_post_account_spendings`, `items_post_calls_stats`), balance (`user_get_user_balance`), chat history (`messenger_get_chats_v2`, `messenger_get_messages_v3`), order list (`orders_get_orders`), reports (`autoload_get_reports_v2`), rate limits (`meta_get_rate_limits`).

**What doesn't:** anything that could change state. Even marking a chat as read is hidden.

---

## Persona 2 — Customer-support agent (read + reply)

Use case: an agent that reads incoming messages, drafts replies, marks chats as read. It can talk to customers but **cannot spend money, change prices, or generate paid promotion**.

```bash
AVITO_MCP_MODE=guarded
AVITO_MCP_ALLOW_TOOLS=user_get_user_info_self,user_get_user_balance,items_get_items_info,items_get_item_info,messenger_get_chats_v2,messenger_get_chat_by_id_v2,messenger_get_messages_v3,messenger_get_voice_files,messenger_chat_read,meta_get_rate_limits
```

This combines: `guarded` mode hides everything `money` and `public`; allowlist narrows it to the support-relevant tools.

**To let the agent actually send replies**, you'll need to opt into the `public` risk for the messenger send tools. Two ways:

- (a) Add to `AVITO_MCP_ALLOW_TOOLS` and switch to `full_access` mode:

  ```bash
  AVITO_MCP_MODE=full_access
  AVITO_MCP_ALLOW_TOOLS=...above list...,messenger_post_send_message,messenger_post_send_image_message,messenger_upload_images
  ```

- (b) Or stick with `guarded` and use a denylist to keep everything money-related blocked even after a future allowlist expansion:

  ```bash
  AVITO_MCP_MODE=full_access
  AVITO_MCP_DENY_TOOLS=items_update_price,items_put_item_vas,items_put_item_vas_package_v2,items_apply_vas,promotion_create_bbip_order_for_items_v1,cpa_auction_save_item_bids,cpa_target_save_auto_bid,cpa_target_save_manual_bid,trxpromo_apply,msg_discounts_open_api_multi_confirm
  ```

  This denies every `money` tool and is robust to future tool additions in those categories getting through allowlist gaps.

---

## Persona 3 — Listings and stock agent (no messaging, no spending)

Use case: agent that manages inventory and listings — keeps stock fresh, generates labels, processes orders. **Doesn't talk to customers, doesn't spend money on promotion.**

```bash
AVITO_MCP_MODE=full_access
AVITO_MCP_DENY_TOOLS=items_update_price,items_put_item_vas,items_put_item_vas_package_v2,items_apply_vas,promotion_create_bbip_order_for_items_v1,cpa_auction_save_item_bids,cpa_target_save_auto_bid,cpa_target_save_manual_bid,trxpromo_apply,msg_discounts_open_api_multi_confirm,messenger_post_send_message,messenger_post_send_image_message,messenger_upload_images,messenger_delete_message,reviews_create_review_answer_v1,reviews_remove_review_answer_v1
```

This is a `full_access` configuration with a hard denylist over every `money` and customer-visible `public` tool. The agent can:

- update stock (`stock_update_stocks`)
- read everything
- manage orders (`orders_generate_labels`, `orders_apply_transition`, `orders_set_tracking_number`)
- process autoload reports

But cannot:

- send any message
- buy any VAS / promotion
- reply to reviews
- change any price

> **Note on `items_update_price`:** technically `public` (customers see it), it's denied here. If you want the agent to *propose* price changes for human approval but not apply them, build that approval flow in your agent runtime — the MCP server has no built-in confirmation step (planned for v0.4.0).

---

## Persona 4 — Full admin (everything goes)

Use case: you, the human, running the MCP server in Claude Desktop / Cursor / Claude Code for interactive ad-hoc work. The agent always asks before destructive calls because *you're* the human-in-the-loop.

```bash
AVITO_MCP_MODE=full_access
```

That's it. All 139 tools available. Well-behaved MCP clients (Claude Desktop, Cursor) will still warn you before any `destructiveHint: true` tool runs — that's the `money` and `public` set — because those annotations are on every tool.

This is the **default** if no env vars are set. It is also the only configuration where Avito write methods can be called automatically by the agent. **Don't use this for unattended cron jobs.**

---

## Defence in depth

Even with a strict mode, you should always:

- **Restrict the OAuth scopes** at the Avito API key level to the minimum your agent actually needs. Avito offers scope selection when creating a key.
- **Run with a low-balance test account** for first experiments. Top up just enough that one bad call doesn't drain your real budget.
- **Read the [server startup log](../README.md#troubleshooting)** — at boot the server logs `mode`, `allowToolsCount`, `denyToolsCount` and emits a `tool hidden by policy` line for every tool that was suppressed. Verify the count matches what you expected.
- **Inspect [`dist/manifest.json`](../dist/manifest.json)** — it's the single source of truth on what's classified as what. If you disagree with a classification, open an issue.

## Future work

- **Confirmation flow** (v0.4.0): destructive calls return `requires_confirmation: true` instead of executing immediately. The agent must call a separate `avito_confirm_action` tool with the original action id. This adds a forced second step for `money` and `public` tools, even in `full_access` mode.
- **Per-tool spending limits** (v0.4.x): cap the cost of an autonomous session at e.g. ₽500/day across all `money` tools.

If either of those is critical to your use case, comment on the [v0.4.0 milestone](https://github.com/elchin92/avito-mcp/milestones) or open a discussion.
