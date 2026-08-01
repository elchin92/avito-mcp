# ADR 0005 — One OAuth scope for this major, and what it costs

Status: accepted
Date: 2026-08-01
Context: migration to MCP revision 2026-07-28, stage M5.7
Supersedes: nothing

## Decision

`avito:mcp` stays the only scope for the whole 1.x line. It is not split into
`avito:read` / `avito:write` in this major, and no step-up authorization is
implemented.

The split is not abandoned — it is scheduled as **M8.7** and gated on a
prerequisite recorded below that has to ship in its own release, ahead of any
narrower scope being issued.

## Why not now

The requirement is real. Revision 2026-07-28 says a resource server MUST take
scope hierarchies into account, and this deployment exposes 148 tools across a
risk classification that already distinguishes read, write, money and public
operations. A single scope means an agent granted access to read a chat is, by
the same token, granted permission to spend money. That is a genuine gap and
this ADR does not pretend otherwise.

What makes it impossible to fix as part of M5 is the shape of the check that
enforces it. `AvitoOAuthProvider.verifyAccessToken` requires the token's scope
set to EQUAL `{avito:mcp}` — not to contain what the request needs. With one
scope, equality and containment are the same relation, so nothing has ever
distinguished them. Introducing a second scope separates them immediately:

- every access and refresh token already issued carries `{avito:mcp}`;
- under a two-scope world those tokens no longer equal the expected set;
- so each one fails on its next request with `invalid_token`, which every
  client reads as an expiry it should be able to refresh — and the refresh
  fails the same way, because the refresh token carries the same scope set.

The installed base is logged out at the moment of deployment, and there is no
signal to a client that says "re-run the full authorization" rather than "retry
later". A single-tenant server whose owner must be physically present to type a
password at a consent screen is the worst possible place for that failure mode.

## The order this has to happen in

Whoever implements M8.7 does it in **two releases**, not one:

1. **Relax the check, issue nothing new.** Turn set equality into "the token
   carries every scope this request requires", and accept `avito:mcp` as a
   super-scope that satisfies any requirement. Ship it. Every existing token
   keeps working, unchanged, because a super-scope satisfies everything.
2. **Only then start issuing narrower scopes**, with `avito:mcp` still accepted
   for a transitional window at least as long as the refresh-token lifetime (30
   days today), and with insufficient scope answered `403` +
   `WWW-Authenticate: error="insufficient_scope", scope="…", resource_metadata="…"`
   rather than today's `401 invalid_token`.

Doing these in one release, or in the opposite order, produces exactly the
outage described above. The check in `src/http/oauth/provider.ts` carries a
comment pointing here for that reason.

## Owner input

Open question 4 of the migration plan ("split the single scope?") was not
answered by the owner. The plan's recorded default is "do not split in this
major; record it and move it to M8.7", and this ADR is that record. If the
owner later chooses to split, nothing here changes except the release it lands
in — the two-step order above is a property of the code, not of the schedule.
