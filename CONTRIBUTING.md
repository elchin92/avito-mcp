# Contributing to avito-mcp

Thank you for considering contributing! This project's main goal is to give AI agents the maximum useful coverage of Avito's public API. Most PRs will be either adding new domains, expanding tool descriptions, or fixing bugs.

> **Before you start:** for help or questions see [SUPPORT.md](./SUPPORT.md). For security issues use the private channel in [SECURITY.md](./SECURITY.md) — **not** a public issue.

## Architecture in 30 seconds

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

The heart of the project is `src/core/tool-factory.ts` — `defineTool(server, ctx, spec)`. It turns a 7-line declarative spec into a full MCP tool with HTTP, OAuth, retry, error mapping and Profile_id auto-injection. **You should never write a `fetch()` call inside a tool handler.**

## Adding a new Avito swagger (4 steps)

1. Drop the spec into `swaggers/<name>.json`.
2. Create `src/domains/<name>.ts`. Copy `src/domains/user.ts` as the simplest template (3 tools, mix of GET/POST, with Profile_id injection).
3. Register it: add one line to `src/meta/domain-registry.ts`.
4. Run `npm run inspect` and verify your tools show up with valid descriptions and schemas.

If your domain has a read-only endpoint safe for smoke-testing, add a call in `scripts/smoke.ts`.

## Adding a single tool to an existing domain

One `defineTool(server, ctx, { ... })` call in the appropriate `src/domains/<name>.ts`. That's it.

## Conventions

- **Tool naming:** `<domain>_<snake_case_operationId>`. Example: `items_get_item_info`. Resolve operationId collisions across files via the domain prefix (e.g. `delivery_check_confirmation_code` vs `orders_check_confirmation_code`).
- **Versioned operations within a domain:** suffix with `_v1`/`_v2` (e.g. `cpa_chats_by_time_v1`, `cpa_chats_by_time_v2`).
- **Tool definitions are in English** (titles, descriptions, parameter docs) — the audience is global and includes the AI agents themselves. Follow the existing description style: front-load a clear verb + resource, state when (and when not) to use the tool, flag side effects and money/public visibility.
- **Every tool gets a human-readable `title`** — the manifest snapshot test enforces full title coverage; a new tool without a title fails CI. Prefix destructive titles with `⚠️`.
- **`risk` field is required** on every new tool. Without it, the tool defaults to `'write'` and is hidden under `AVITO_MCP_MODE=read_only` — which is the right fail-closed behaviour, but you should be explicit:
  - `'sensitive'` — returns secrets/tokens (auth-style tools). Hidden by default even in `full_access`; opt-in via `AVITO_MCP_EXPOSE_AUTH_TOOLS=1`.
  - `'read'` — GETs and POST-as-query (analytics, statistics, balance, info). No side effects on the server.
  - `'write'` — modifies your own data without immediate customer impact or money spent (drafts, settings, internal stock, marking chats as read).
  - `'money'` — spends balance (VAS purchases, CPA bids, paid promotion orders).
  - `'public'` — visible to customers or third parties (sending messages, replying to reviews, changing prices, setting tracking numbers, accepting returns).

  The factory derives the MCP `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) from `risk` automatically — well-behaved MCP clients use these to warn users before destructive calls.
- **Warn on write methods in the description** — prefix with `⚠️` for `money`/`public` tools as a belt-and-suspenders signal alongside the annotations.
- **Path parameters with `{user_id}` or `{userId}`** — use `injectProfileId: 'user_id' | 'userId'` so the user's profile id is auto-filled if the agent doesn't pass it.
- **Complex nested bodies** — model the bundled OpenAPI contract with explicit Zod schemas. Use `z.unknown()` only when the upstream schema is genuinely unconstrained, and document that exception in `test/openapi-contract.test.ts`.
- **Custom execution still goes through `defineTool`** via `customExecute` / `buildDryRunPreview`. Do not register a business tool directly with `server.registerTool`: that bypasses the shared policy, confirmation, dry-run, idempotency, and error pipeline.

## Tests

- Unit tests (`vitest`) are required for anything in `src/core/`. Run: `npm test`.
- Every Swagger wrapper is checked against its bundled OpenAPI operation by `test/openapi-contract.test.ts`; update schemas and the reviewed exception list deliberately.
- `npm run smoke` uses the real Avito API, is read-only, and refuses production unless `AVITO_MCP_SMOKE_ALLOW_PRODUCTION=true` is explicit. The manual `live-smoke.yml` workflow owns this check; normal CI never calls Avito.

## Before you open a PR

```bash
npm run verify:release
npm audit --omit=dev --audit-level=high
```

These commands cover lint, strict source/script/test typechecks, all-source coverage thresholds, tests, the deterministic manifest, and the release build. CI also installs the actual npm tarball, runs container/restart deployment gates, blocks on `npm audit`, and scans git history for secrets. If you added or renamed a tool, the manifest snapshot test will flag it; update the snapshot deliberately (`npx vitest run -u`) and commit it together with your change.

## Filing issues

- **Bug:** include MCP client + version, Node version, exact tool name + arguments, full error from logs (stderr).
- **New domain request:** link to the Avito OpenAPI spec.
- **Tool description improvement:** paste the current text + your suggestion + why it helps the LLM pick this tool.

## Don't

- Don't add HTTP client logic outside `src/core/client.ts`.
- Don't add telemetry, analytics, or any outbound calls except to `api.avito.ru`.
- Don't bundle credentials, tokens, real item IDs, or business data in commits, examples, or tests.
- Don't add dependencies without justification — keep the install footprint minimal.
