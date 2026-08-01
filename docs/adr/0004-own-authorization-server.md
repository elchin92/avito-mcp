# ADR 0004 — avito-mcp remains its own OAuth authorization server, on a frozen SDK package

Status: accepted
Date: 2026-08-01
Context: migration to MCP revision 2026-07-28, open question 1; stage M5
Supersedes: nothing

## Decision

avito-mcp keeps running its own OAuth 2.1 authorization server, built on
`@modelcontextprotocol/server-legacy@2`, and does **not** delegate authorization
to an external identity provider in this major. The dependency on a package the
SDK marks frozen and deprecated is accepted as transitional, with the exit
conditions below written down rather than assumed.

This is the recorded default of open question 1 in the migration plan; the owner
has not closed that question, and this ADR is the decision that stands until
they do. Stage M0.1's ADR is the intended long-term home for it — it does not
exist on this branch, so the decision is recorded here and can be folded in
later.

## What the alternative would have cost

Delegating to an external IdP means the resource-server half of this repository
stays and the authorization-server half goes away: no `/authorize`, no `/token`,
no DCR, no consent page, no token store, no lease. That is a smaller and better
supported surface, and it is the direction the SDK is pointing.

It is also a different product. avito-mcp is a single-tenant server whose entire
authorization model is "the deployment owner types a password on a consent
screen". There is exactly one principal. An external IdP would require the
operator to run or buy one, register avito-mcp in it, and keep its issuer and
JWKS reachable — for the purpose of authenticating one person to their own
server. For the documented deployment (a small Avito seller running one
instance behind Caddy) that is a larger operational burden than the thing it
secures.

Doing it during the protocol migration would also mean changing the
authorization architecture and the wire era in the same release train, on a
production account with no sandbox to validate against.

## What we are accepting

- **`server-legacy` is frozen.** It receives no new features, and the SDK
  recommends a dedicated OAuth server for production. It is not unmaintained
  today, but it will be.
- **Its revision boundary is undocumented.** Nothing in the sources states which
  MCP revisions the AS half is expected to satisfy. Where the revision imposes
  something the package does not do, it falls to this repository — which is what
  M5.1 turned out to be: the router appends `iss` only to redirects issued from
  the response it hands `authorize()`, and ours comes from a separate consent
  POST.
- **Two error hierarchies coexist and must not be mixed.** The AS half throws
  `server-legacy` error classes, which `mcpAuthRouter` maps by `instanceof`; the
  resource-server half throws the v2 `OAuthError` from
  `@modelcontextprotocol/express`. `new InvalidTokenError() instanceof OAuthError`
  is false in both directions, so a verifier throwing the wrong brand answers
  `500` instead of `401 + WWW-Authenticate` and strips clients of discovery.
  This is maintained by hand and pinned by tests
  (`test/oauth-bearer-http.test.ts`).

## Exit conditions

Any one of these makes the decision worth reopening:

1. `server-legacy` stops working against a supported Node or SDK version, or its
   AS half is removed outright.
2. The deployment stops being single-tenant — more than one principal whose
   access must be told apart rather than merely gated.
3. Machine-to-machine credentials appear (client-credentials grant, long-lived
   tokens), which is also the trigger in ADR 0006 for the token-storage
   decision.
4. The owner answers open question 1 in favour of an external IdP.

Until then the AS half stays here, and its obligations under the revision are
met in this repository — see stage M5 and `SECURITY.md`.
