# ADR 0005 — Keep one OAuth scope while preparing a compatible split

Status: accepted
Date: 2026-08-01
Updated: 2026-09-07
Context: OAuth scope compatibility, stage M5.7

## Decision

The current 2.1.x server uses one OAuth scope, `avito:mcp`. It grants access to the configured MCP surface; tool modes, allow/deny lists and confirmation rules apply separately. OAuth does not yet distinguish read, write or paid operations within that surface.

Narrower scopes remain planned as M8.7. No delivery date is committed.

## Why the change needs staging

`AvitoOAuthProvider.verifyAccessToken` compares a token's scope set with the configured scope set. Existing access and refresh tokens contain `avito:mcp`. Changing that expected set while issuing narrower scopes would invalidate existing sessions and could leave clients repeatedly attempting an unsuccessful refresh.

The current scope is therefore not a substitute for `AVITO_MCP_MODE=read_only` or a tool allowlist. Use those controls when an agent only needs reads.

## Migration order

1. **Accept compatible scope sets first.** Check whether a token satisfies the request's required scopes, and retain `avito:mcp` as a transitional broad scope. Continue issuing the existing scope in this release.
2. **Issue narrower scopes in a later release.** Keep the broad scope accepted for at least the configured refresh-token lifetime, currently 30 days by default. Return `403` and an `insufficient_scope` challenge with the required scope and protected-resource metadata when permission is missing.
3. Test existing-token refresh, narrower permissions, tool-list filtering and confirmation replay before changing defaults.

This sequence preserves existing tokens while allowing a separately reviewed permission model. See [SECURITY.md](../../SECURITY.md) for current authorization boundaries and [the roadmap](../../ROADMAP.md) for contribution directions.
