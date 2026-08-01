# ADR 0001 — What the dual-era server does NOT do, and why

Status: accepted
Date: 2026-08-01
Context: migration to MCP revision 2026-07-28 (`MIGRATION_PLAN.md`), branch `feat/m3-dual-era`
Supersedes: nothing

Two obligations of revision 2026-07-28 are not met by writing more code in this
repository. One is a limitation of the SDK's stdio serving entry that we can
diagnose but not remove; the other is a requirement with no reachable trigger on
this server's primitive surface. Both are recorded here as explicit decisions so
that a later reader finds a decision rather than a silence.

---

## 1. A stdio connection's era is decided once and never revisited

### Decision

Accept the SDK's behaviour. Do not reimplement `serveStdio`. Ship a diagnostic
(a stderr warning naming the era, the pinning method and the fact that the pin
is permanent) and document the constraint for operators in both READMEs.

### The behaviour

`@modelcontextprotocol/server/stdio` decides a connection's era from its first
classifiable message and holds that decision for the life of the connection.
From `dist/stdio.mjs`, `serveStdio` → `processMessage`:

```js
const processMessage = async (message) => {
    if (state.phase === "closed") return;
    if (state.phase === "pinned") {
        …
        state.instance.channel.deliver(message);
        return;
    }
    …
    const opening = classifyOpeningMessage(message);
    switch (opening.kind) {
        …
        case "legacy": {
            if (legacyMode === "reject") { … }
            …
            const instance = await connectInstance("legacy");
            …
            state = { phase: "pinned", era: "legacy", instance };
            state.instance.channel.deliver(message);
            return;
        }
    }
};
```

and the classifier that produces `legacy`:

```js
function classifyOpeningMessage(message) {
    const params = message.params;
    if (message.method === "initialize" && !carriesValidModernEnvelopeClaim(params)) {
        …
        return { kind: "legacy", reason: "initialize", … };
    }
    if (!hasEnvelopeClaim(params)) return { kind: "legacy", reason: "no-claim" };
    …
}
```

So **any** first frame without a per-request `_meta` envelope — not just
`initialize`; a hand-written `tools/call`, a `tools/list` probe, a proxy that
strips `_meta` — pins the connection to revision 2025-11-25 permanently. Once
`phase === 'pinned'`, every later frame goes through `channel.deliver(message)`
with no classification argument at all, so a subsequent, perfectly well-formed
2026-07-28 message on the same connection is served as 2025 traffic.

### Why we do not override it

`ServeStdioOptions` is `{ legacy, transport, onerror, maxSubscriptions }`. None
of these reaches the state machine: `legacy` only chooses whether a legacy
opening is served or refused, and the phases (`opening` / `probe` / `pinned` /
`closed`) are closure-local with no accessor. Making a stdio connection
re-classify per message would mean forking `serveStdio` — reimplementing the
probe-and-discard dance, the listen router wiring, the drain-on-discard
bookkeeping and the graceful teardown — and owning that fork against every SDK
release. That trade is worse than the defect: the defect has a one-line client
fix (send the envelope on the first message, which every conformant 2026 client
does by construction, since the envelope is how it names its revision at all),
and a fork has no fix.

This is also the SDK behaving as specified for stdio: the binding has no header
layer, so the body is the only era signal, and a connection-scoped decision is
the only one available at connection scope.

### What we do instead

`src/stdio-era.ts` wraps the wire transport through the supported
`options.transport` seam and:

- emits **one** stderr line when a `dual` connection pins to legacy, naming the
  method that pinned it and stating that the pin is for the life of the
  connection — the M3.10 observability requirement, and the line an operator
  greps while rolling `dual` out;
- keeps stdout untouched (on stdio, stdout is the protocol);
- restores the per-message protocol-version check the pin costs — see §2 below;
- narrows `subscriptions/listen` filters, as the HTTP leg does.

`test/modern-hardening.test.ts` pins all of this against a spawned server.

### Rollback / operator guidance

An operator seeing `protocol era pinned to legacy` for a client that should be
modern has two remedies, in order: update the client so its first frame carries
`io.modelcontextprotocol/protocolVersion` in `params._meta`; or, if the client
cannot, leave it on `legacy` — a legacy-pinned connection is served exactly as
1.3.3 served it, which is a degraded era, not an outage.

---

## 2. `-32021 MissingRequiredClientCapability` is unreachable on this surface

### Decision

Do not manufacture a producer for `-32021`. Record that the code is
structurally unreachable given the primitives this server exposes, and guard the
assumption with a test so that the day it stops being true is a failing build
rather than a silent conformance gap.

### Why it is unreachable

The revision's requirement is conditional:

> «A server **MUST NOT** rely on capabilities the client has not declared. If
> processing a request requires a capability the client did not include in
> `io.modelcontextprotocol/clientCapabilities`, the server **MUST** return a
> `MissingRequiredClientCapabilityError` (`-32021`) whose
> `data.requiredCapabilities` lists the missing capabilities.»

"If processing a request requires a capability" is the antecedent, and on this
server nothing satisfies it. Two independent reasons:

1. **No spec method carries a static requirement.** The SDK's table is literally
   empty:

   ```js
   const REQUIRED_CLIENT_CAPABILITIES_BY_METHOD = {};
   function requiredClientCapabilitiesForRequest(method) {
     return Object.hasOwn(REQUIRED_CLIENT_CAPABILITIES_BY_METHOD, method)
       ? REQUIRED_CLIENT_CAPABILITIES_BY_METHOD[method]
       : void 0;
   }
   ```

   There is no method for which merely being called requires a client
   capability.

2. **The only dynamic producer is MRTR, which this server deliberately does not
   use.** The other call site is
   `requiredClientCapabilitiesForInputRequest(entry)`, which maps
   `elicitation/create` → `elicitation`, `sampling/createMessage` → `sampling`
   and `roots/list` → `roots`. Those are reached only when a handler returns an
   `inputRequired` result. This server never does: confirmation for
   money/public operations goes through the durable `confirmation_id` +
   `meta_confirm_action` pair, which `MIGRATION_PLAN.md` §1.3 keeps deliberately
   — it survives statelessness, is cross-process, and does not route a
   money-operation approval through the client. Sampling, roots and elicitation
   appear nowhere in `src/` (`grep` returns nothing).

The honest conclusion is therefore not "we implemented `-32021`" but "no request
this server can receive has a client-capability precondition, so the MUST has no
instance". A synthetic probe that forces the code out of the SDK proves the SDK
can emit it; it proves nothing about this server.

### What would change this

Any of: a tool that returns an `inputRequired` result; adopting URL or form
elicitation; adopting sampling; reading client roots. Each makes the antecedent
true and makes `-32021` a live obligation — at which point the SDK produces it
automatically at the input-request leg, and what this project must add is a
conformance test, not a mechanism.

`test/modern-hardening.test.ts` asserts that no handler in `src/core/tool-factory.ts`,
`src/build-server.ts` or `src/resources.ts` mentions `inputRequired`, so the
first commit that introduces one has to revisit this ADR.

---

## Consequences

- The migration's 100 % criterion (`MIGRATION_PLAN.md` §1.2) item **A7** is
  satisfied by this recorded decision rather than by a code path.
- Requirement **B** (no client loses service) is unaffected by either item:
  the stdio pin degrades a modern client to legacy, never to failure.
- Both items are re-checked automatically: §1 by the stdio suite in
  `test/modern-hardening.test.ts`, §2 by the guard in the same file.
