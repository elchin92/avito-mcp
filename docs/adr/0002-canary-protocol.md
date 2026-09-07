# ADR 0002 — Read-only checks on a live Avito account

Status: accepted
Date: 2026-08-01
Updated: 2026-09-07
Context: release validation with production credentials

[Release runbook](../releases.md) · [Safety](../safety.md) · [Rollback criteria](0007-rollback-criteria.md)

## Decision

A live canary checks an installed release against an authorized Avito account using only `risk=read` tools. It confirms account access and response shapes. Mutation, confirmation and recovery scenarios run against local fixtures, including the offline demo.

A live canary does not prove that every write endpoint works. Keep that limit in the release report. Access to production credentials does not authorize sending messages, changing listings or spending account balance.

## Prepare the check

1. Build and validate the exact release artifact. Record its version, commit and manifest `schema_hash`.
2. Start an isolated process with `AVITO_MCP_MODE=read_only`, separate token/runtime-state paths, and `AVITO_MCP_WEBHOOK_ENABLED=false`. Supply account credentials through a private environment file.
3. Confirm `meta_health.safety.mode === "read_only"` before an upstream call.
4. Read `tools/list` and compare the available names with the release manifest and active allow/deny filters. With no filters, the 2.1.x catalogue exposes 80 read tools from 148 total definitions.

`read_only` is explicit: the compatibility default is `full_access`. The policy excludes write tools during registration, so confirmation tools are absent from this canary.

## Required calls

Use one client and run the following calls in order. The first two are local diagnostics; the final three access Avito.

| Tool                      | Arguments        | Pass condition                                                                           |
| ------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `meta_health`             | `{}`             | `ok === true`, expected version, `safety.mode === "read_only"`                           |
| `meta_capabilities`       | `{}`             | Expected `schemaHash`; available tools agree with the active policy and release manifest |
| `user_get_user_info_self` | `{}`             | `http_status === 200`; account ID matches the private deployment configuration           |
| `items_get_items_info`    | `{"per_page":1}` | `http_status === 200`, `resources` is an array, `meta` contains pagination fields        |
| `messenger_get_chats_v2`  | `{"limit":1}`    | `http_status === 200`, `chats` is an array, `meta.has_more` is a boolean                 |

An empty account may return empty arrays; emptiness alone is not a server failure. Object responses retain `resources` or `chats` rather than becoming an `items`/`count` wrapper.

Any `isError: true`, unexpected protocol error or HTTP 5xx fails the check. Distinguish missing Avito endpoint permissions from an application regression, but record both as a failed account-level check until resolved.

## Before and after deployment

- **Before publication:** run the automated release suite, package smoke check and fixture demo. If a live check is authorized, run this canary against the candidate artifact.
- **After deployment:** confirm `/readyz`, the version in `/healthz`, then repeat the read-only account check. Readiness alone does not establish Avito permissions.
- **During rollout:** observe errors and latency using [ADR 0007](0007-rollback-criteria.md). A completed smoke check is not a completed observation window.

On failure, preserve a redacted diagnostic report and follow the rollback runbook. Do not weaken a pass condition to match a failing candidate.

## What the live canary does not cover

| Area                                                  | Validation used instead                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| Confirmation, approval identity and expiry            | Unit and HTTP integration tests                     |
| Request bodies, upload paths and dry runs             | OpenAPI contract tests and local fixtures           |
| Duplicate prevention, cancellation and lost responses | Idempotency and mutation transport tests            |
| Actual messages, listing changes, paid services       | No production mutation is included in this protocol |
| Long-term behavior under real traffic                 | Separate deployment observation                     |

## Recording results

Keep private account data and raw responses out of public release notes. Record version, commit, client/version, transport, safety mode, test names, pass/fail results and redacted error codes. Compare account identifiers locally and report only whether they matched.

Historical check: on 2026-08-03 the pre-publication read-only set passed for candidate 2.0.0. Its post-deployment observation was not part of that record. This historical result is not evidence for a later release; each release needs its own checks.
