# ADR 0006 — Tokens and client secrets stay in cleartext in the OAuth store, and why that is an accepted risk rather than a defect

Status: accepted
Date: 2026-08-01
Context: migration to MCP revision 2026-07-28, stage M5.9
Supersedes: nothing

## Decision

`AVITO_MCP_OAUTH_STORE_FILE` keeps access tokens, refresh tokens and
`client_secret` values as they are: the token strings are the KEYS of the
`accessTokens` / `refreshTokens` objects, and the secret is a plain field on the
client record. They are neither hashed nor encrypted. The risk is accepted and
documented in `SECURITY.md`.

This is the second of the two outcomes stage M5.9 allows, and it is chosen
deliberately, not by omission.

## What the exposure actually is

The file is created `0600` inside a directory created `0700`, is rewritten by
atomic `open(O_EXCL)` + `fsync` + `rename`, and is held under an exclusive
process lease. So the population that can read it is:

- `root` on the host;
- the service account avito-mcp itself runs as;
- anyone who can read a backup, a snapshot or a container layer containing it.

The first two can already read `AVITO_MCP_OAUTH_OWNER_PASSWORD` from the unit's
environment, and with it can mint fresh tokens at will; they can also read
`AVITO_TOKEN_FILE`, which holds the Avito credentials the tokens ultimately
protect. Hashing the MCP tokens does not narrow that population by one member.

The third is the real difference, and it is bounded: an access token expires in
an hour by default and a refresh token in 30 days, both are revocable, and all
of them are discarded outright when the issuer identifier changes (ADR: see
`SECURITY.md`, "`AVITO_MCP_HTTP_PUBLIC_URL` is the OAuth issuer identifier").

## Why hashing is not a free win here

Hashing an access token is the standard answer, and it is the right one for a
multi-tenant authorization server. It buys less than it appears to here:

- **The store is not a credential of record.** Nothing in it is a long-lived
  secret an operator typed. Everything in it was minted by this process from
  the owner password, which sits in the environment of the same process in
  cleartext. The weakest link is not the file.
- **The lookups are the hot path of every request.** Token verification is a
  `Map.get` on the presented string today. Under hashing it becomes a digest per
  request — acceptable with SHA-256, not acceptable with a password KDF — and a
  fast unsalted digest of a 256-bit random token buys nothing against an
  attacker who has the file, because there is no dictionary to attack. So the
  realistic version of "hash the tokens" defends against an attacker with file
  read access who is somehow unable to use the tokens they can already see.
- **`client_secret` genuinely should be hashed**, and would be, if it were worth
  anything: it authenticates a client that self-registered, unauthenticated,
  over an open DCR endpoint, to a server whose actual gate is the owner typing a
  password on a consent screen. It is a correlation identifier wearing a
  credential's name.

## What would change this decision

This becomes a defect, not an accepted risk, as soon as **any long-lived
machine-to-machine credential** exists in this store — a client-credentials
grant, a non-expiring token, or an operator-provisioned `client_secret` that is
not self-registered. At that point the file starts holding something whose value
outlives the process that made it, and hashing (plus a KDF for anything
operator-supplied) becomes mandatory rather than ceremonial.

Two smaller triggers, either of which is enough on its own:

- the store starts being shared with, or backed up to, a location outside the
  host's own private state directory;
- multi-tenancy of any kind, i.e. more than one principal whose tokens must be
  isolated from each other rather than merely from outsiders.

## Not in scope of this decision

Encryption at rest of the whole file is a different control with a different
problem (where the key lives) and is not addressed here. Full-disk or
filesystem-level encryption on the host remains the recommended mitigation and
is out of this repository's hands.
