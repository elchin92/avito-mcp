# Documentation

[English README](../README.md) · [README на русском](../README.ru.md)

`avito-mcp` connects an MCP-compatible client to an Avito account. The client supplies the AI model and asks for tool calls; the server validates them, applies access and confirmation rules, and calls Avito. It does not run an autonomous seller agent by itself.

## Start here

| I want to…                               | Read                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Try the project without an Avito account | The offline demo in the [English](../README.md) or [Russian](../README.ru.md) README |
| Connect a client                         | [Client setup](clients.md) · [Подключение клиентов](clients.ru.md)                   |
| Choose a useful first task               | [Seller workflows](workflows.md) · [Сценарии продавца](workflows.ru.md)              |
| Limit what the agent can do              | [Safety modes and confirmation](safety.md)                                           |
| Diagnose an error                        | [Troubleshooting](troubleshooting.md) · [Решение проблем](troubleshooting.ru.md)     |
| Upgrade an existing installation         | [Migration](../MIGRATION.md) · [Обновление](../MIGRATION.ru.md)                      |

The offline demo uses fictional data and a local fixture. Normal operation uses the credentials in your private client configuration or environment file.

## Operate a server

- [Operations](operations.md) · [Эксплуатация](operations.ru.md): HTTP, OAuth, webhooks, resources and protocol settings.
- [Release and deployment runbook](releases.md): validation, npm and registry publication, systemd deployment and recovery.
- [Security policy](../SECURITY.md): trust boundaries, known limits and private reporting.
- [Rollback criteria](adr/0007-rollback-criteria.md): observable thresholds and deployment checks.

## Contribute

- [Contributing](../CONTRIBUTING.md): setup, shared tool factory, contracts and checks.
- [Roadmap](../ROADMAP.md): bounded improvements with a way to validate them.
- [MCP conformance](conformance.md): requirements linked to automated tests; remaining gaps are explicit.
- [Changelog](../CHANGELOG.md): released behavior changes.

## Architecture

```text
MCP client
    │ stdio or authenticated Streamable HTTP
    ▼
Protocol adapter → tool policy → schema validation
    → dry run / confirmation / idempotency → Avito API
    │
    └─ Local resources: manifest, redacted configuration,
       rate limits, pending actions and webhook events
```

Tool definitions live in `src/domains/`; shared execution controls live in `src/core/`. Bundled OpenAPI files in `swaggers/` describe the supported upstream operations. `dist/manifest.json` is generated during the build and lists every tool's schema and risk.

## Architecture decisions

| Record                                                                         | Topic                                        |
| ------------------------------------------------------------------------------ | -------------------------------------------- |
| [0001 — Protocol migration](adr/0001-mcp-2026-07-28-migration.md)              | Support both MCP revisions                   |
| [0001 — Protocol limits](adr/0001-protocol-era-limitations.md)                 | stdio selection and conditional capabilities |
| [0002 — Live canary](adr/0002-canary-protocol.md)                              | Read-only account verification               |
| [0004 — OAuth server](adr/0004-own-authorization-server.md)                    | Current dependency and migration path        |
| [0005 — OAuth scopes](adr/0005-scopes.md)                                      | Introduce narrower permissions compatibly    |
| [0006 — Token storage](adr/0006-token-storage.md)                              | Private state and remaining exposure         |
| [0007 — Rollback](adr/0007-rollback-criteria.md)                               | Measure and recover a deployment             |
| [0008 — Idempotency holds](adr/0008-idempotency-hold-on-cancelled-dispatch.md) | Recover uncertain mutations safely           |

The two records numbered 0001 retain their original filenames so existing links continue to work. These records preserve technical decisions; private working notes and conversation transcripts are not project documentation.
