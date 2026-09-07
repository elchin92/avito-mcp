# Upgrade to 2.1.1

[Русская версия](MIGRATION.ru.md) · [Release notes](CHANGELOG.md) · [Operations](docs/operations.md)

Version 2.1.1 preserves the 2.1.0 configuration, tool catalogue and supported MCP revisions. Existing Avito credentials remain in your private configuration. The offline `--demo` mode uses fictional data only when explicitly selected.

## Choose your upgrade path

| Installed version | What to review                                                                          |
| ----------------- | --------------------------------------------------------------------------------------- |
| 2.1.0             | Install 2.1.1 and restart the client or service; no configuration migration is required |
| 2.0.x             | Review [uncertain mutation outcomes](#from-20x) and the reporting correction            |
| 1.3.x             | Review [HTTPS, registration and cancellation changes](#from-13x) before upgrading       |

For a local npm installation:

```bash
npm install avito-mcp@2.1.1
npx avito-mcp --version
```

For a client configured with `npx`, update a pinned package argument to `avito-mcp@2.1.1` and reconnect. For a systemd deployment, follow the [release runbook](docs/releases.md); changing an npm package elsewhere on the host does not replace the running immutable release.

## From 2.0.x

Version 2.1.0 changed two behaviors on both protocol revisions:

- A mutation that loses its response after dispatch returns `OUTCOME_UNKNOWN` with `retryable: false`. Its idempotency hold does not expire automatically. Check the Avito result before retrying; see [recovery](docs/safety.md#lost-responses-after-a-mutation-v21).
- `avito_daily_overview` limits spending history to 270 days and instructs the client to read all listing pages. Modern arguments above 270 are rejected; the legacy prompt clamps the value.

A paid promotion creation that returned an order ID retains that ID when later status polling fails. Check the existing order rather than creating another one.

## From 1.3.x

### HTTPS for remote OAuth

Since 2.0.0, OAuth on a routable host requires an HTTPS `AVITO_MCP_HTTP_PUBLIC_URL`. Loopback HTTP remains supported for local development. Put the server behind a TLS reverse proxy and use its public URL:

```bash
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com
```

Changing this value changes the issuer and discards stored clients and tokens; clients must register and authorize again. [Operations](docs/operations.md#remote-mcp-over-http-oauth-21) contains proxy examples. Development-only cleartext overrides are described in `.env.example` and must not be used for production OAuth.

### Client registration

New registrations accept HTTPS redirects or loopback HTTP redirects without fragments. Private-use URI schemes and routable cleartext callbacks are rejected. Native clients use public-client PKCE and receive no `client_secret`; an explicitly declared web client needs a non-loopback HTTPS callback.

Persisted registrations are not revalidated on load, but the rules apply when a client registers again. A deployment without a persistent OAuth store re-registers clients after each restart.

### Cancellation

Since 2.0.0, `notifications/cancelled` interrupts work on both MCP revisions. Modern clients can also cancel by closing the response stream. Before dispatch, cancellation releases the key. After dispatch, a destructive call with an idempotency key returns that key to a bounded cancellation hold: reuse produces `IDEMPOTENCY_HELD`.

The cancellation hold differs from the indefinite lost-response hold added in 2.1.0. [The safety guide](docs/safety.md#lifting-a-held-idempotency-key) explains the reason codes and recovery.

### Dependencies and package contents

Version 2.0.0 moved to the split TypeScript SDK v2 packages. The built-in OAuth authorization helper remains a transitional dependency in 2.1.1; no external identity provider is required. Direct imports from undocumented `dist/*` paths are not a supported API.

The npm package includes public documentation and examples. Local research, working notes, credentials and runtime state are excluded. The package is used through its CLI; no tool name or documented valid input schema changed in these releases.

## Optional protocol migration

| `AVITO_MCP_PROTOCOL_ERA` | Served revisions              |
| ------------------------ | ----------------------------- |
| `legacy` — default       | `2025-11-25`                  |
| `dual`                   | `2025-11-25` and `2026-07-28` |
| `modern`                 | `2026-07-28` only             |

Start with `dual` if you need modern clients while keeping existing ones. stdio selects its revision from the opening message and keeps it until reconnect; HTTP classifies every request. See [protocol compatibility](docs/operations.md#protocol-and-compatibility).

Modern HTTP uses `AVITO_MCP_HTTP_MAX_INFLIGHT=64` and `AVITO_MCP_HTTP_MAX_STREAMS=32` by default. Legacy session limits continue to apply only to legacy HTTP.

## Verify and recover

After upgrading, check the reported version and `meta_health`, then perform the [read-only canary](docs/adr/0002-canary-protocol.md) if account access is authorized. A healthy listener alone does not prove Avito API access.

To disable the optional modern protocol, set `AVITO_MCP_PROTOCOL_ERA=legacy` and restart. For a package downgrade, review state compatibility and the [rollback runbook](docs/adr/0007-rollback-criteria.md). Preserve held idempotency and pending-action records; an older version may not enforce newer unknown-outcome protections. Never delete state to make a downgrade start.

For an issue, include the installed version, client/version, transport, auth mode, protocol era and redacted error. Keep account credentials and raw customer responses private.
