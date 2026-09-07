# Contributing to avito-mcp

Contributions should help a seller complete a real task or help a maintainer keep the server reliable. Useful changes include client examples, clearer errors, missing Avito operations, regression fixes and documentation.

[Documentation](docs/README.md) · [Roadmap](ROADMAP.md) · [Support](SUPPORT.md) · [Private security reporting](SECURITY.md#how-to-report)

## Development setup

Use Node.js 24 and a supported npm version for development. If you use Node.js 22,
use 22.13 or later to satisfy ESLint's requirements. The published server supports
Node.js 22.12 or later. Work on a branch from `main`:

```bash
npm ci
npm run demo
npm run verify:release
```

The demo and ordinary tests use fictional local fixtures. They need no Avito account. Keep real credentials in ignored local environment files and use explicit read-only authorization for a live smoke check.

## First contribution

Reproduce a [workflow](docs/workflows.md), improve a [client configuration](docs/clients.md), or report a documentation mismatch. Include your client version and OS; use fictional IDs and redacted results. A docs-only PR needs accurate examples, valid local links, and EN/RU updates where the same guidance exists.

For code changes, use the shared factory below and run the release checks. For a new Avito domain, discuss the official specification and the user task in an issue before starting a large implementation.

## Where code belongs

```
swaggers/<name>.json                   ← Avito OpenAPI spec (source of truth)
       ↓
src/domains/<name>.ts                  ← one file per swagger, declarative tools
       ↓
src/meta/domain-registry.ts            ← one line registers the domain
       ↓
148 MCP tools (138 Swagger operations + 3 local/convenience + 7 meta)
served over stdio or Streamable HTTP
```

Run `npm run generate:manifest` to produce an up-to-date `dist/manifest.json` with the
authoritative list, including the `risk` classification of every tool.

The heart of the project is `src/core/tool-factory.ts` — `defineTool(server, ctx, spec)`. It applies HTTP, OAuth, retries, error mapping and Profile_id injection consistently. Business tools must use this pipeline; do not add a separate `fetch()` inside a handler.

## Adding a new Avito swagger (4 steps)

1. Drop the spec into `swaggers/<name>.json`.
2. Create `src/domains/<name>.ts`. Copy `src/domains/user.ts` as the simplest template (3 tools, mix of GET/POST, with Profile_id injection).
3. Register it: add one line to `src/meta/domain-registry.ts`.
4. Run `npm run inspect` and verify your tools show up with valid descriptions and schemas.

If your domain has a read-only endpoint safe for smoke-testing, add a call in `scripts/smoke.ts`.

## Adding a single tool to an existing domain

Add a `defineTool(server, ctx, { ... })` definition in the relevant domain. Include an explicit risk, accurate schemas and a description explaining the task and side effects. Update contract tests and the manifest snapshot when the public catalogue changes.

## Conventions

- **Tool naming:** `<domain>_<snake_case_operationId>`. Example: `items_get_item_info`. Resolve operationId collisions across files via the domain prefix (e.g. `delivery_check_confirmation_code` vs `orders_check_confirmation_code`).
- **Versioned operations within a domain:** suffix with `_v1`/`_v2` (e.g. `cpa_chats_by_time_v1`, `cpa_chats_by_time_v2`).
- **Tool definitions are in English** (titles, descriptions, parameter docs) — the audience is global and includes the AI agents themselves. Follow the existing description style: front-load a clear verb + resource, state when (and when not) to use the tool, flag side effects and money/public visibility.
- **Every tool gets a human-readable `title`** — the manifest snapshot test enforces full title coverage; a new tool without a title fails CI. Prefix destructive titles with `⚠️`.
- **`risk` field is required** on every new tool. Without it, the tool defaults to `'write'` and is hidden under `AVITO_MCP_MODE=read_only` — but every new definition should state its risk explicitly:
  - `'sensitive'` — returns secrets/tokens (auth-style tools). Hidden by default even in `full_access`; opt-in via `AVITO_MCP_EXPOSE_AUTH_TOOLS=1`.
  - `'read'` — GETs and POST-as-query (analytics, statistics, balance, info). No side effects on the server.
  - `'write'` — modifies your own data without immediate customer impact or money spent (drafts, settings, internal stock, marking chats as read).
  - `'money'` — spends balance (VAS purchases, CPA bids, paid promotion orders).
  - `'public'` — visible to customers or third parties (sending messages, replying to reviews, changing prices, setting tracking numbers, accepting returns).

  The factory derives the MCP `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) from `risk` automatically — well-behaved MCP clients use these to warn users before destructive calls.

- **Warn on write methods in the description** — prefix with `⚠️` for `money`/`public` tools alongside the annotations.
- **Path parameters with `{user_id}` or `{userId}`** — use `injectProfileId: 'user_id' | 'userId'` so the user's profile id is auto-filled if the agent doesn't pass it.
- **Complex nested bodies** — model the bundled OpenAPI contract with explicit Zod schemas. Use `z.unknown()` only when the upstream schema is genuinely unconstrained, and document that exception in `test/openapi-contract.test.ts`.
- **Custom execution still goes through `defineTool`** via `customExecute` / `buildDryRunPreview`. Do not register a business tool directly with `server.registerTool`: that bypasses the shared policy, confirmation, dry-run, idempotency, and error pipeline.

## Deprecated MCP surfaces

The MCP revision `2026-07-28` publishes a [registry of Deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated). Four rows of it are features this server has never used — and **must not start using**. Use the supported replacement for new code and keep existing compatibility changes deliberate. A fifth rule, listed last, guards the SDK package line itself.

- **Sampling** — `sampling/createMessage`, `server.createMessage()`. Deprecated in `2026-07-28` (SEP-2577). Call an LLM provider directly; a server that needs an answer back from its caller uses the multi round-trip request pattern, not a server-initiated request.
- **Roots** — `roots/list`, `listRoots()`, `notifications/roots/list_changed` (the notification is already removed, not just deprecated). Deprecated in `2026-07-28` (SEP-2577). Take directories and files as tool parameters, resource URIs, or configuration — `AVITO_MCP_ALLOWED_UPLOAD_DIRS` is exactly that.
- **`includeContext: "thisServer"` / `"allServers"`** — deprecated by SEP-2596, removed no later than Sampling itself. Nothing to migrate: the field only exists on Sampling requests, which this server never sends.
- **HTTP+SSE transport** — `SSEServerTransport`, the `/sse` subpath (`@modelcontextprotocol/server-legacy/sse` in the v2 line). Deprecated by SEP-2596 (soft-deprecated since `2025-03-26`). Use Streamable HTTP, already wired in `src/http/mcp-http.ts`.
- **The retired v1 SDK package** — `@modelcontextprotocol/sdk` and any of its subpaths. The server is on the `@modelcontextprotocol/*@2` line: import from `@modelcontextprotocol/{core,server,node,express}` (and `client` in tests and scripts). The transitional exception is the authorization-server layer: `mcpAuthRouter`, `OAuthServerProvider` and `redirectUriMatches` still come from the deprecated `@modelcontextprotocol/server-legacy/auth` in 2.1.1 to preserve existing installations; see [ADR 0004](docs/adr/0004-own-authorization-server.md). Note the two do **not** share an error hierarchy — see the header comment in `src/http/oauth/provider.ts` before touching a `throw` there.

`test/deprecated-surface.test.ts` enforces this: it parses every `src/**/*.ts` with the TypeScript parser and fails on any of those identifiers, string literals or module specifiers. It looks at **code tokens only** — comments are trivia and are not scanned, so you can (and should) name a deprecated feature in a comment when explaining why it is absent.

Two clarifications, since the registry is easy to misread:

- Deprecated is not removed. Features already present in `src/` (Logging, Dynamic Client Registration) stay; the rule is only that no _new_ code path may depend on them. Widening their use is a review question, not an automatic no.
- If an exception is necessary, change the rule list in `test/deprecated-surface.test.ts` in the same PR and state the reason — do not delete the test or skip the case.

## Tests

- Add meaningful regression tests for execution, policy, transport and state changes. Run `npm test`; documentation-only changes need accurate examples and link checks.
- Every Swagger wrapper is checked against its bundled OpenAPI operation by `test/openapi-contract.test.ts`; update schemas and the reviewed exception list deliberately.
- `npm run smoke` uses the real Avito API, is read-only, and refuses production unless `AVITO_MCP_SMOKE_ALLOW_PRODUCTION=true` is explicit. The manual `live-smoke.yml` workflow owns this check; normal CI never calls Avito.

## Before you open a PR

```bash
npm run verify:release
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

These commands cover lint, strict source/script/test typechecks, all-source coverage thresholds, tests, the deterministic manifest, and the release build. CI also installs the actual npm tarball, runs container/restart deployment gates, blocks on `npm audit`, and scans git history for secrets. If you added or renamed a tool, the manifest snapshot test will flag it; update the snapshot deliberately (`npx vitest run -u`) and commit it together with your change.

Maintainers preparing a release or production rollout: follow the [release and deployment runbook](docs/releases.md).

## Filing issues

- **Bug:** include MCP client + version, Node version, exact tool name + arguments, redacted error from logs (stderr).
- **New domain request:** link to the Avito OpenAPI spec.
- **Tool description improvement:** paste the current text + your suggestion + why it helps the LLM pick this tool.

## Publication hygiene

- Don't add HTTP client logic outside `src/core/client.ts`.
- Don't add telemetry, analytics, or any outbound calls except to `api.avito.ru`.
- Keep credentials, tokens, customer data, conversation transcripts and private work notes out of commits, examples, tests and release artifacts. Use fictional IDs and redact logs before sharing them.
- Don't add dependencies without justification — keep the install footprint minimal.
