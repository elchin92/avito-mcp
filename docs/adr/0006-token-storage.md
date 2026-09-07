# ADR 0006 — Local OAuth token storage

Status: accepted
Date: 2026-08-01
Updated: 2026-09-07
Context: OAuth store persistence, stage M5.9

## Decision

The current `AVITO_MCP_OAUTH_STORE_FILE` persists access tokens, refresh tokens and registered client secrets in cleartext. Token strings are lookup keys in the store. This is an existing accepted limitation of the single-account deployment, documented in [SECURITY.md](../../SECURITY.md); it is not a claim that hashing provides no protection.

## Exposure and controls

- The file is created with mode `0600` in a directory created with mode `0700`.
- Writes are atomic and protected by an exclusive process lease.
- The host administrator and service account can read the store. A copied backup or snapshot also carries usable credentials.
- Access tokens expire after one hour by default; refresh tokens after 30 days. Tokens are revocable, and changing the OAuth issuer discards registrations and issued credentials.

Compromising the running service account also exposes the owner password and upstream Avito credentials. File-only or backup access is a narrower threat: hashing opaque tokens would reduce that exposure, even though it would not protect a compromised running process. Keep backups private and apply host storage encryption where available.

## Conditions for redesign

Revisit storage before adding any of the following:

1. Long-lived machine-to-machine credentials, client-credentials grants, non-expiring tokens or operator-provisioned client secrets.
2. Multiple tenants whose credentials must be isolated.
3. Storage or backup outside the host's private state boundary.

A redesign should store digests of high-entropy opaque tokens, use appropriate password hashing for operator-supplied secrets, and migrate existing tokens without silently invalidating clients. Whole-file encryption is a separate control with its own key-management requirements.

## Reportable failures

A store created with wider permissions, exposed in logs or MCP resources, readable by an unrelated local user, or corrupted by concurrent writers is in scope for security reporting. The accepted limitation does not exempt those failures.
