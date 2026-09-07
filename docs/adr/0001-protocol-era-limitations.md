# ADR 0001 — Protocol selection and capability limits

Status: accepted
Date: 2026-08-01
Updated: 2026-09-07
Context: MCP revision 2026-07-28 compatibility

[Operations](../operations.md#protocol-and-compatibility) · [Conformance](../conformance.md)

## stdio selects a revision once per connection

The SDK's `serveStdio` entry classifies the opening message and keeps that revision for the connection. Under `dual`, an opening frame without the modern `_meta` envelope selects legacy behavior, including when the frame is a hand-written `tools/list` rather than `initialize`. Later modern envelopes do not switch the connection.

**Decision:** use the supported SDK entry instead of maintaining a fork of its connection state machine. A modern client must send `io.modelcontextprotocol/protocolVersion` in `params._meta` from its first request. If it starts without that envelope, correct the client and reconnect. HTTP classifies each request independently.

`src/stdio-era.ts` adds a single `protocol era pinned to legacy` warning on stderr when a `dual` connection selects legacy. It identifies the opening method. The wrapper also validates per-message protocol claims and narrows subscription filters. stdout remains the protocol channel.

Validation: `test/modern-hardening.test.ts` exercises the wrapper against a spawned server. Revisit this choice if the SDK adds a supported way to change the revision selection behavior.

## No current request requires a client capability

`-32021 MissingRequiredClientCapability` applies when handling a request requires a client capability that the caller did not declare. The current tool/resource/prompt surface has no such precondition:

- The SDK's static method-to-capability table is empty for these requests.
- This server does not return `inputRequired` or use sampling, roots or elicitation.
- Confirmation uses `confirmation_id` and `meta_confirm_action` rather than a client callback.

**Decision:** record the requirement as conditional and currently inapplicable; do not add an artificial error path merely to exercise its code. The conformance table links the guard that checks the assumption.

Adopting `inputRequired`, elicitation, sampling or roots would make capability enforcement a live requirement. That change must add an end-to-end test and update this record.

## Consequences

The default remains `AVITO_MCP_PROTOCOL_ERA=legacy`. A package upgrade does not enable modern-only service. The stdio constraint is a compatibility limit; stdio has no separate caller authentication boundary. Remote access should use the OAuth HTTP transport described in [SECURITY.md](../../SECURITY.md).
