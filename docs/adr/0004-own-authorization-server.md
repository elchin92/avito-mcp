# ADR 0004 — Keep the built-in OAuth authorization server

Status: accepted
Date: 2026-08-01
Updated: 2026-09-07
Context: OAuth architecture, stage M5

## Decision

Version 2.1.1 retains the built-in authorization server and its transitional dependency on `@modelcontextprotocol/server-legacy/auth`. Existing installations keep their consent flow, issuer, registrations and token-store behavior. The resource-server verification path uses the maintained v2 middleware.

A dedicated identity provider remains the longer-term migration path. It is not a drop-in replacement suitable for a patch release.

## Why retain it now

The supported deployment serves one Avito account. An operator starts the server and approves clients through a password-protected consent page. Moving authorization to an external provider would require issuer configuration, client registration, signing-key discovery and a migration for existing tokens. It would also change installation requirements for users who currently need only this package and a reverse proxy.

Retaining the current implementation preserves that deployment contract while keeping the dependency explicit.

## Maintenance obligations

- Track the frozen authorization helper package and its compatibility with supported Node and SDK versions.
- Keep OAuth checks covered by the HTTP and provider integration tests, including invalid tokens, issuer binding, redirects, PKCE, refresh and revocation.
- Keep the authorization helper's error classes separate from the resource middleware's errors. The router maps exceptions by their own class hierarchy; the wrong class can turn an expected `401` into `500`.
- Preserve discovery and consent behavior when updating dependencies.

## Migration triggers

Revisit this decision if the helper loses compatibility or receives an unresolved security issue; if deployment becomes multi-tenant; or before introducing long-lived machine credentials. A dedicated-provider implementation should first be optional, document its operational requirements and demonstrate migration and rollback with existing clients.

See [OAuth scope compatibility](0005-scopes.md), [token storage](0006-token-storage.md) and [SECURITY.md](../../SECURITY.md).
