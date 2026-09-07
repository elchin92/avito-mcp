# Safety configuration / Безопасные конфигурации

[Documentation](README.md) · [Client setup](clients.md) · [Security policy](../SECURITY.md)

Normal operation uses a real Avito account. Choose the visible tools and approval rules before connecting an agent. For a first run, use `AVITO_MCP_MODE=read_only` or the offline `--demo`; the compatibility default is `full_access` with confirmation for money and public actions.

## Choose a profile

| Task                              | Configuration                                                | What it permits                                                        |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Reports and account checks        | `AVITO_MCP_MODE=read_only`                                   | Read tools only                                                        |
| Read and prepare internal changes | `AVITO_MCP_MODE=guarded`                                     | Read/write tools; public and money tools are hidden                    |
| Reply to customers                | [Messenger profile](../examples/profiles/messenger.env.json) | An explicit tool allowlist with confirmation for all destructive calls |
| Manage listings and stock         | [Seller profile](../examples/profiles/seller.env.json)       | An explicit tool allowlist with confirmation for all destructive calls |
| Narrow analytics access           | [Analytics profile](../examples/profiles/analytics.env.json) | A small read-only allowlist                                            |

`sensitive` tools are hidden by default. An explicit `AVITO_MCP_EXPOSE_AUTH_TOOLS=1` can expose them in `guarded` or `full_access`; keep that opt-in disabled for the profiles above.

Copy the selected profile's environment entries into your client configuration and add credentials privately. An allowlist is easier to maintain than a broad denylist when a task should have limited access.

## How the controls work

1. **Tool visibility:** `AVITO_MCP_MODE`, allow/deny lists and `AVITO_MCP_EXPOSE_AUTH_TOOLS` decide which tools register. A hidden tool cannot be called through the normal tool interface.
2. **File access:** `messenger_upload_images` requires `AVITO_MCP_ALLOWED_UPLOAD_DIRS`; the upload guard rejects paths outside those roots and applies `AVITO_MCP_MAX_UPLOAD_MB`.
3. **Execution:** dry runs preview requests, confirmation gates stage actions, and idempotency keys prevent known duplicate calls.

| Risk        | Meaning                                               | Example                                     |
| ----------- | ----------------------------------------------------- | ------------------------------------------- |
| `read`      | Reads account data, including POST-as-query endpoints | `user_get_user_balance`                     |
| `write`     | Changes internal state                                | `messenger_chat_read`                       |
| `public`    | Affects customers or externally visible state         | `items_update_price`, `stock_update_stocks` |
| `money`     | Spends balance                                        | `items_put_item_vas`                        |
| `sensitive` | Returns secrets; hidden unless explicitly enabled     | `auth_get_access_token`                     |

The generated `dist/manifest.json` and `meta_capabilities` list classifications. A mode limits business actions; read tools may still update local caches and diagnostics.

<a id="on-the-confirmation-flow--what-it-is-and-isnt"></a>

## Confirmation and human approval

`AVITO_MCP_CONFIRMATION_MODE=money_public` stages money/public calls. `all_destructive` also stages write calls; `off` disables the server confirmation step. In a staged call, the server returns `requires_confirmation` and a `confirmation_id`; `meta_confirm_action` executes the pending action after rechecking policy.

The two-step flow does not prove that a human approved. An agent with access to both calls can propose and confirm an action. Choose a client approval policy that requires review before `meta_confirm_action`, or configure a separate approval factor:

```bash
AVITO_MCP_CONFIRMATION_MODE=all_destructive
AVITO_MCP_APPROVAL_MODE=external
# Set AVITO_MCP_CONFIRMATION_SECRET privately; at least 32 characters.
```

`external` requires the separate confirmation secret. After verifying it, the server records the confirmer as `external:secret-provider`; it does not prove a separate person or OAuth client. A human can supply the secret through the same client, including stdio. Keep it outside the initiating agent's environment and conversation; an agent that receives it can use it too.

With hard confirmation enabled, attempts are limited to 20 per minute per principal, including unknown IDs. Five wrong or missing secret attempts across sessions delete the pending action. Anonymous legacy HTTP callers can obtain a new principal by reconnecting; see [the security policy](../SECURITY.md#caller-identity).

## Webhooks and uploads

Webhook registration tools are `public` and require confirmation under the default mode. They accept only the exact HTTPS receiver URL configured by the operator; arbitrary destinations are rejected and previews redact its secret. Reading buffered events is a read operation.

Image upload is disabled until an allowed directory is configured. Grant access to a dedicated image directory, not a home directory containing credentials or unrelated files.

## Lost responses after a mutation (v2.1)

If an HTTP timeout or connection failure happens **after** a mutation was sent,
Avito may already have applied it. The tool returns `OUTCOME_UNKNOWN` with
`retryable: false`. Check the listing, order or transaction in Avito before
issuing a new mutation. This applies to both MCP protocol revisions, including
confirmed actions and calls without an idempotency key.

With an idempotency key, the reservation is held with reason
`transport_failure_after_dispatch`; **this hold does not expire with the ordinary
idempotency TTL**. Reusing that key refuses the operation rather than sending it
again. The confirmation claim also remains consumed. A new key is not a recovery
mechanism: it can duplicate the first operation. Without a key the server cannot
recognize an independently submitted duplicate, so the client must honour the
non-retryable result.

A known successful BBIP order creation keeps its order ID if subsequent polling
fails; inspect that existing order instead of creating a replacement.

After reconciliation, an operator may release the held reservation using the
store's `releaseHold` maintenance method, or remove the exact held record with
all writers stopped. Never remove an unresolved record or a completed result.
For a confirmed action, also clear the corresponding pending claim after
reconciliation; releasing an idempotency hold alone does not free its claimed
pending-action slot. `PendingActionStore.completePersistent(id)` works only in
the live store instance that owns the claim. For recovery after a restart or
from a separate maintenance process, stop all writers, verify the exact action
ID and `claimed` state in the pending record, then remove that reconciled record
alongside its held idempotency record. Do not clear the entire state directory.
There is deliberately no model-accessible tool that discards this protection.
Failures before dispatch and ordinary read requests remain retryable.

## Lifting a held idempotency key

Inspect the reason before choosing a recovery action:

| Reason                             | When it occurs                                        | Automatic expiry                                                                 |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `cancelled_after_dispatch`         | The caller cancelled after the mutation was sent      | At the configured idempotency TTL, measured from call start; one hour by default |
| `transport_failure_after_dispatch` | A dispatched mutation lost its response               | None                                                                             |
| `unfinished_reservation`           | A process stopped with a durable call still in flight | None                                                                             |

A held key returns `IDEMPOTENCY_HELD`. The log identifies the tool, key fingerprint and persistent record path; a cancellation hold also has `heldUntil`. Both protocol revisions honor cancellation. Cancelling before dispatch releases the reservation instead.

Before repeating an action, inspect its actual result in Avito. Expiry of a cancellation hold does not prove that the original action failed. Do not use a new key simply to bypass an unresolved hold.

For manual recovery, stop every process sharing the runtime-state directory, reconcile the exact operation, and remove only its identified hold record. Never remove a completed result or clear the whole ledger. A confirmed action may also have a consumed pending claim; follow the preceding section to reconcile it. Use `IdempotencyStore.releaseHold(toolName, key)` only after the same checks. See [ADR 0008](adr/0008-idempotency-hold-on-cancelled-dispatch.md) for the design and tests.

## Operational checks

- Start with the few tools needed for the task and inspect `meta_capabilities` after configuration changes.
- Keep token, OAuth and webhook state private. The installer uses a restricted service account and private state permissions.
- Use local fixtures for mutation tests. A production smoke check should remain read-only unless a specific real action is authorized.
- Review `OUTCOME_UNKNOWN` before any retry. Approval does not remove uncertainty from an upstream operation.
- Keep the client's own approval settings aligned with the server profile.

## Why tool arguments do not use `x-mcp-header`

Business inputs can contain customer identifiers, phone numbers and amounts. This server has no routing requirement that needs them in HTTP headers, where proxies may log them. `test/openapi-contract.test.ts` guards the absence of this annotation.

Any future adoption needs validation in the same change: a nonempty valid HTTP field-name token, no CR/LF, case-insensitive uniqueness, a primitive non-`number` property type, and a property statically reachable through `properties` rather than only through a conditional or composed schema.

Potential future controls, including spending limits and narrower OAuth scopes, are listed in the [roadmap](../ROADMAP.md). They are not implemented guarantees.
