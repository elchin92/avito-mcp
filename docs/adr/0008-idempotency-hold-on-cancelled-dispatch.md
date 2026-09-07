# ADR 0008 — Retain idempotency claims after uncertain mutations

Status: accepted
Date: 2026-08-03
Updated: 2026-09-07
Context: cancellation safety, block A item 11 / stage M1.4

[Safety and recovery](../safety.md) · [Migration guide](../../MIGRATION.md)

## Decision

Cancelling a request aborts the outgoing Avito call and releases the rate-limit slot. Whether its idempotency key can be reused depends on whether the mutation was dispatched.

| Observed outcome                                           | Idempotency behavior                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Cancelled or failed before dispatch                        | Release the reservation; no mutation was sent                                             |
| Cancelled after dispatch                                   | Hold the key for the configured ledger TTL; reuse returns `IDEMPOTENCY_HELD`              |
| Transport failure after dispatch, without a known response | Return `OUTCOME_UNKNOWN` with `retryable: false`; retain the key without automatic expiry |
| Definite response received                                 | Keep the known outcome under the ordinary replay rules                                    |

The indefinite hold was added in 2.1.0. It is distinct from the bounded cancellation hold introduced in 2.0.0. Both protect against treating a missing response as evidence that Avito did not perform the action.

## Scope

The behavior applies to both protocol revisions. `notifications/cancelled` reaches the same cancellation signal on legacy and modern connections. Modern clients can also cancel by closing the response stream.

The tool factory uses `RequestOptions.onDispatch`, called immediately before `fetch()`, rather than inferring dispatch from the cancellation signal. Failures while waiting for a token or rate-limit slot release the reservation. A known upstream rejection is handled as a definite outcome.

Confirmed mutations retain their claim when the outcome is unknown. A retry with the same key cannot create a second mutation. Calls made without a key have no caller-key replay guarantee.

The ledger coordinates claims across processes using the same runtime-state directory. It cannot provide exactly-once execution at an upstream API that has already accepted a request but lost the response.

## Recovery

Inspect the Avito account or known operation ID first. Do not submit a new key as a workaround for an unknown result. For a paid promotion whose creation returned an order ID, use that ID to check status rather than creating another order.

After reconciliation, an operator can use `IdempotencyStore.releaseHold(toolName, key)` or remove only the identified hold record with all writers stopped. Preserve unrelated state. Detailed instructions and cancellation expiry rules are in [the safety guide](../safety.md#lifting-a-held-idempotency-key).

## Validation

- `test/idempotency-cancel-race.test.ts`: cancellation before and after dispatch, persistent holds and concurrent callers.
- `test/mutation-transport-outcome.test.ts`: lost responses, known rejections, failed token refresh and paid-promotion polling.
- `test/idempotency.test.ts`: replay and durable ledger behavior.

The legacy regression baseline remains immutable. Intentional safety corrections are documented instead of described as unchanged wire behavior.

## Sources

- [MCP cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)
- [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
