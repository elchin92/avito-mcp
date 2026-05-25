# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-25

Final hardening pass. Closes the last items on the v0.3.0 audit's path to 10/10: hard-confirmation, binary endpoint UX, richer safety metadata. No breaking changes for default configs.

### Added
- **`AVITO_MCP_CONFIRMATION_SECRET`** — turns the confirmation flow from soft (any caller can confirm) into **hard** (caller must supply the secret). When set, `meta_confirm_action` requires a `confirmation_secret` parameter, compared in constant time via `crypto.timingSafeEqual`. Wrong or missing secret returns `isError: true` and **does not delete the pending action** — agent can retry within TTL with the correct secret. Bridges the gap between two-step UX and actual human-in-the-loop guarantees when paired with an MCP client that asks the user to type the secret.
- **Binary endpoint UX** — `safeParseResponse` in `src/core/client.ts` now detects non-JSON, non-text content-types (PDF, audio, octet-stream) and returns a structured envelope: `{ __binary: true, mimeType, sizeBytes, base64 }`. Affects `orders_download_label` (PDF labels) and `calltracking_get_record_by_call_id` (audio recordings). `formatResponse` renders binaries as a clean readable block instead of dumping bytes-as-text. Agents can now decode `base64` to save the file locally or upload elsewhere.
- **Richer ToolSpec safety metadata** — two new optional fields:
  - `accessesLocalFiles?: boolean` — currently set on `messenger_upload_images`.
  - `environment?: 'prod' | 'sandbox' | 'local'` — `meta_*` tools tagged `'local'`. Default `'prod'`. Surfaces in `_meta` and `dist/manifest.json`. Doesn't change runtime behaviour — it's analytics + auditable signal for clients.
- New tests (88 total, +9 from v0.4.1): 4 hard-confirmation (no secret rejected, wrong secret rejected, correct secret executes, length-mismatch rejected), 5 binary-response (PDF, audio, JSON-not-affected, text-not-affected, empty body).

### Changed
- Server startup log adds `hardConfirmation: true/false` so the active safety profile is fully auditable in one line.
- `--help` documents `AVITO_MCP_CONFIRMATION_SECRET` and all v0.4.x env vars (some were missing from earlier help output).
- `.env.example` documents `AVITO_MCP_CONFIRMATION_SECRET` with explanation of soft vs hard confirmation.
- `orders_download_label` and `calltracking_get_record_by_call_id` descriptions updated — they now correctly describe the structured `{mimeType, sizeBytes, base64}` envelope instead of the old "raw bytes as text" warning.

### Notes on the audit
This release closes the last items on the path to 10/10 from the v0.3.0 audit:
- ✅ Confirmation secret (audit's "10/10 safety" recommendation)
- ✅ Binary endpoint UX (audit P2)
- ✅ Richer safety metadata as first-class fields (audit P3)

Still deferred to future minor releases (none are 10/10-blockers — they're polish):
- Per-tool spending caps (requires Avito price oracle we don't have)
- Persist manifest to repo (vs. ship-only — current approach is sufficient)
- `delivery_*` sandbox tools manually tagged `environment: 'sandbox'`

## [0.4.1] - 2026-05-25

CI hygiene release. No code changes, no breaking changes.

### Added
- **`npm audit` job in CI** (`audit-level=high`, `--omit=dev`, `continue-on-error: true`). Runs only on push to main — non-blocking by design, just a warning signal in the Actions tab.
- **`gitleaks` job in CI** — scans every push and PR for committed secrets. Uses the official `gitleaks/gitleaks-action@v2`. `continue-on-error` so it doesn't block obviously-clean PRs but always reports.
- **`tsconfig.scripts.json`** + `npm run typecheck:scripts` — type-checks `scripts/` (was excluded from the main `tsconfig.json`). Now wired into CI before `npm run build`. Catches type errors in `scripts/generate-manifest.ts` which is critical for the publish pipeline.
- **Manifest snapshot test** (`test/manifest-snapshot.test.ts`) — asserts exact `tool_count`, `counts_by_risk` (sensitive: 3, read: 77, write: 43, money: 9, public: 10, unknown: 0) and snapshots the full tool roster. Silent drift now fails CI loudly. Re-snapshot with `npm test -- -u` after intentional tool additions/reclassifications.
- **CI now generates the manifest** before tests, and the tarball-verify step **fails if `dist/manifest.json` is missing** from the published artifact.

### Tests
79 passing (was 74). +5 snapshot/invariant assertions.

## [0.4.0] - 2026-05-25

"Sensitive surface + upload guard + confirmation flow" — the safety hardening pass recommended by the v0.3.0 audit. Three new gates added on top of v0.3.0's mode + allow/deny system:
sensitive-class hiding for auth tools, fail-closed file-access guard for the multipart upload tool, and runtime confirmation flow for destructive operations.

### Breaking changes

> `0.x` versions can break — read these carefully before upgrading unattended deployments.

- **`auth_*` tools are now hidden by default.** They return OAuth tokens and are reclassified as `risk: 'sensitive'`. To restore previous behaviour:
  ```bash
  AVITO_MCP_EXPOSE_AUTH_TOOLS=1
  ```
- **`messenger_upload_images` is hidden by default.** It reads files from disk and the previous version allowed arbitrary paths. To restore:
  ```bash
  AVITO_MCP_ALLOWED_UPLOAD_DIRS=/path/to/safe/dir1,/path/to/safe/dir2
  ```
  Even with allowed dirs, every upload now goes through `realpath`/extension/size/magic-byte validation.
- **`money` and `public` tools now require a two-step confirmation by default.** First call returns `{requires_confirmation: true, confirmation_id: "..."}` instead of executing. Agent must then call `meta_confirm_action` with that id. To restore one-shot execution:
  ```bash
  AVITO_MCP_CONFIRMATION_MODE=off
  ```

### Added
- **New risk class `sensitive`** in addition to `read` / `write` / `money` / `public`. Used for tools that return credentials. Hidden by default at registration time regardless of mode. Opt-in via `AVITO_MCP_EXPOSE_AUTH_TOOLS=1`. Currently covers 3 tools: `auth_get_access_token`, `auth_get_access_token_authorization_code`, `auth_refresh_access_token_authorization_code`.
- **`messenger_upload_images` hardening** with new env vars:
  - `AVITO_MCP_ALLOWED_UPLOAD_DIRS` (comma- or whitespace-separated) — without it the tool isn't registered at all. Validation uses `fs.realpath` on both file and directory to defeat symlink escape and `/safe-malicious` prefix attacks. Strict `dir + sep` startsWith.
  - `AVITO_MCP_MAX_UPLOAD_MB` (default `15`) — size cap per file.
  - Extension allowlist hard-coded: jpg/jpeg/png/webp.
  - Magic-byte sniff (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WEBP `RIFF...WEBP`) cross-checked against extension. Mismatch is rejected.
  - All validation runs before any byte is sent to Avito. Fail-closed everywhere.
- **Runtime confirmation flow** with new env vars and three new meta tools:
  - `AVITO_MCP_CONFIRMATION_MODE` (`off` / `money_public` (default) / `all_destructive`) — `money_public` requires confirmation for `money` and `public`; `all_destructive` adds `write`. `off` keeps v0.3.x behaviour.
  - `AVITO_MCP_CONFIRMATION_TTL_SEC` (default `900`) — pending action TTL.
  - `meta_confirm_action(confirmation_id)` — executes the pending. One-shot; re-evaluates policy at confirm time (in case config changed); deletes the pending before executing so race-double-confirm fails.
  - `meta_cancel_action(confirmation_id)` — removes a pending without executing.
  - `meta_list_pending_actions()` — sanitized list (no args dump, no execute closure) for "what did I just queue?" diagnostics.
  - Pending store is **in-memory only** — rebooting the server loses all pending. Deliberate: better than accidentally confirming an old action.
  - All three meta tools are registered **only** when `AVITO_MCP_CONFIRMATION_MODE != off` — no clutter when flow is disabled.
- **24 new tests** (74 → 98 total): 10 for confirmation flow (pending creation, one-shot confirm, double-confirm rejected, cancel, expiry, list, mode toggles, policy re-evaluation), 14 for upload guard (every reason path: outside dirs, symlink escape, extension mismatch, magic-byte mismatch, size limit, directory disguised as file, naive prefix attack, empty allowlist, path traversal).
- New module `src/core/pending-actions.ts` (TTL'd in-memory store, sanitised list view).
- New module `src/core/upload-guard.ts` (`validateUpload`, `UploadGuardError`).

### Changed
- `ToolContext` now includes `pendingStore: PendingActionStore` (internal API; only domain authors affected).
- `dist/manifest.json` now includes `counts_by_risk.sensitive` and the three new confirmation tools. With confirmation on, 142 tools total: 3 sensitive / 77 read / 43 write / 9 money / 10 public.
- Server startup log adds `exposeAuthTools`, `uploadDirsCount`, `confirmationMode` fields so the active safety profile is auditable from the first line of stderr.
- `--help` documents every new env var. `.env.example` documents every new env var, organised into three labeled sections (registration gates / upload guard / runtime confirmation).
- README EN + RU Security sections rewritten around the three-layer model.
- `docs/safety.md` rewritten — fixed `stock_get_stocks_info` typo (should have been `stock_update_stocks`), added confirmation flow explanation with explicit "what it isn't" disclaimer about autonomous agents.

### Fixed
- `dist/manifest.json` generator now correctly counts `sensitive` (previously crashed on unknown risk).
- `.github/ISSUE_TEMPLATE/bug_report.md` added — was missing in v0.3.x. Now asks reporters for their active safety env vars.

### Notes on the audit
This release closes the high-priority items from the v0.3.0 audit: sensitive surface, upload hardening, confirmation. P1 items kept for follow-ups (v0.4.1 / v0.5.0):
- `gitleaks` / secret scanning in CI
- `npm audit` warning gate in CI
- Type-check `scripts/` separately
- Snapshot tests on exact tool counts
- Binary endpoint UX (PDF/audio as base64)
- `AVITO_MCP_CONFIRMATION_SECRET` for hard-confirmation (human-typed secret)
- Per-tool spending caps

## [0.3.0] - 2026-05-25

"Defence in depth" — three safety modes, per-tool allowlist/denylist, generated tool manifest, and registry-invariant tests. Plus a `docs/safety.md` with ready-to-paste configurations for common agent personas.

### Added
- **`AVITO_MCP_MODE`** env var with three values, replacing the binary `AVITO_SAFE_MODE`:
  - `read_only`   — registers only `risk='read'` tools (~79 tools). Agent literally cannot see anything else in `tools/list`.
  - `guarded`     — registers `read` + `write` (~120 tools); hides `money` and `public`. Agent can edit own data but can't spend or talk to customers.
  - `full_access` — all 139 tools; legacy behaviour. **Default.**
- **`AVITO_MCP_ALLOW_TOOLS`** — comma-separated tool names; if set, only these register, regardless of mode. Lets you build narrow agent personas.
- **`AVITO_MCP_DENY_TOOLS`** — comma-separated tool names that are always hidden. Deny wins over allow.
- **Policy hides tools at registration time, not at call time** — they don't appear in `tools/list` at all. Removes the temptation for an agent to attempt the call. (v0.2.x blocked at call time with an isError response; v0.3.0 hides entirely.)
- **`dist/manifest.json`** — generated catalogue of every tool with name, domain, risk, description and annotations. Built by `npm run generate:manifest` (now part of `prepack` so it ships in every published tarball). Useful for documentation, programmatic agent runtimes, and CI invariant checks.
- **Tool `_meta.risk` field** — every tool exposes its risk classification via MCP `_meta` in addition to the derived `ToolAnnotations`. MCP-aware clients can read it for fine-grained UI.
- **Registry invariant tests** (`test/registry.test.ts`) — mount the full domain registry against an InMemoryTransport and assert:
  - ≥139 tools registered
  - All names unique
  - All names match `^[a-z][a-z0-9_]*$`
  - All names start with a known domain prefix
  - All tools have a non-empty description
  - All descriptions contain Cyrillic (convention)
  - Every tool has both `readOnlyHint` and `destructiveHint` set explicitly

  Catches future regressions like the `messenger_upload_images` slip-through that affected v0.2.0.
- **`docs/safety.md`** — long-form safety guide with four ready-to-paste agent personas:
  - Persona 1 (analytics-only): `AVITO_MCP_MODE=read_only`
  - Persona 2 (customer-support): guarded + allowlist with the messenger subset
  - Persona 3 (listings & stock, no messaging or spending): `full_access` with denylist over money + public
  - Persona 4 (full admin, interactive): defaults

### Changed
- **`AVITO_SAFE_MODE=read-only`** is now deprecated. It still works (mapped to `AVITO_MCP_MODE=read_only`) and emits a one-line stderr warning at startup. Will be removed in v1.0.0.
- Server startup log now records `mode`, `allowToolsCount`, `denyToolsCount` so you can verify policy at a glance.
- `--help` documents all new env vars; `.env.example` documents all new env vars; both READMEs (EN + RU) Security sections document modes + allowlist/denylist and link to `docs/safety.md`.
- `prepublishOnly` and `prepack` now run `generate:manifest` so the manifest in npm tarballs matches the source.

### Tests
- 50 passing (up from 39 in v0.2.x): added 9 registry-invariants tests and refactored the safe-mode tests to use the new mode-based config instead of `process.env.AVITO_SAFE_MODE` mutation.

## [0.2.1] - 2026-05-25

Hotfix release: v0.2.0 missed one tool, plus several doc tune-ups.

### Fixed
- **`messenger_upload_images`** — the only tool registered via `server.registerTool` directly (instead of `defineTool`), it slipped through the v0.2.0 risk classification and was **not blocked under `AVITO_SAFE_MODE=read-only`**. Now classified as `write`, gets MCP `ToolAnnotations`, and respects safe-mode like every other tool.

### Docs
- `CONTRIBUTING.md` — documents the required `risk` field on every new tool, with explicit semantics for each of the four categories. Adds a note that custom tools using `server.registerTool` directly must implement the safe-mode guard themselves.
- `.github/PULL_REQUEST_TEMPLATE.md` — new checklist item: every new tool must declare `risk` explicitly.
- `SECURITY.md` — token cache file reference generalised (was tied to the old `cwd/.avito-token.json` filename).
- `README.ru.md` Troubleshooting — token-reset commands updated to the new per-OS state directory paths; added a row explaining `AVITO_SAFE_MODE` blocking.
- README (EN + RU) header — added CI status, tests-passing, TypeScript-strict, and GitHub stars badges.

## [0.2.0] - 2026-05-25

"Safe by default" — risk classification, safe-mode, and a real CLI.

### Added
- **`AVITO_SAFE_MODE=read-only`** — env var that blocks every tool with risk other than `read`. Lets you hand the MCP server to an unattended agent (cron, multi-agent runtime) without it accidentally spending money, sending messages, or changing prices. Block fires before any HTTP request — Avito never sees the call.
- **Tool risk classification** — every one of the 138 swagger-backed tools (and the `meta_get_rate_limits` tool) is now tagged with one of four risks: `read` (78), `write` (40), `money` (9), `public` (11). Default for unclassified tools is `write` (fail-closed).
- **MCP `ToolAnnotations`** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) — derived from the risk field and sent to the MCP client on `tools/list`. Behaving clients (Claude Desktop, Cursor, etc.) can now warn users before destructive calls.
- **CLI flags** — `avito-mcp --version` and `avito-mcp --help`. `--help` lists every recognised env var, including the new `AVITO_SAFE_MODE`. Both flags exit without loading `.env`, so they work even before credentials are configured.
- New `src/version.ts` — single source of truth that reads `package.json` at runtime. No more hard-coded version strings.
- 8 new unit tests covering risk classification and the safe-mode guard (39 tests total, up from 31).

### Changed
- **Breaking-ish: default OAuth token file location moved out of `process.cwd()`.** Previously `./.avito-token.json`, which leaked tokens into whatever directory the MCP client happened to spawn the server in (project dirs, IDE workspaces, sync folders). New default is a per-user state directory:
  - Linux: `$XDG_STATE_HOME/avito-mcp/token.json` (defaults to `~/.local/state/avito-mcp/token.json`)
  - macOS: `~/Library/Application Support/avito-mcp/token.json`
  - Windows: `%APPDATA%\avito-mcp\token.json`
  Override with `AVITO_TOKEN_FILE`. If you had a token cached in cwd, the server will simply request a fresh one on first call (OAuth tokens are short-lived, no migration needed).
- `User-Agent` header on every outbound request now reads `avito-mcp/<actual-version>` instead of the previously hardcoded `avito-mcp/0.1.0`. Same fix in `scripts/list-tools.ts` and the MCP `serverInfo` block — all version drift between `package.json` and runtime is now eliminated.
- `.env.example` documents `AVITO_SAFE_MODE`, `AVITO_BASE_URL`, and the new token file location.

### Fixed
- **Version drift** between `package.json` and `src/server.ts` / `src/core/client.ts` / `scripts/list-tools.ts` (all three had `0.1.0` hardcoded since the original release). Fixes the misleading `serverInfo.version` field that broke issue triage.

### Notes
- The `read` classification covers GETs and POST-as-query endpoints (analytics, statistics, balance, info). Anything that mutates state, costs money, or is visible to customers is `write` / `money` / `public` respectively.
- `AVITO_SAFE_MODE` is opt-in. Without it, every tool runs as before — this is **not** a behavioural change for existing users.

## [0.1.4] - 2026-05-25

Community health files.

### Added
- **`SECURITY.md`** — security policy with private vulnerability reporting via GitHub Security Advisories. Defines in-scope vs out-of-scope and coordinated disclosure expectations.
- **`SUPPORT.md`** — where to go for bugs, questions, security issues, Avito-API problems, and MCP-client issues (RU + EN).
- **`.github/PULL_REQUEST_TEMPLATE.md`** — what/why, type-of-change checkboxes, and a pre-merge checklist (lint / tsc / build / test / changelog / no real credentials).
- **`.github/dependabot.yml`** — weekly grouped npm + GitHub Actions updates with conventional-commit prefixes.

### Changed
- README (EN + RU): added **Community & support** section pointing at all community files; tightened Security section with a private-reporting pointer.
- `CONTRIBUTING.md`: front-matter note linking to Code of Conduct, Support, and Security policy.

### Confirmed
- No code, swagger, or test changes — community-files-only release. All 31 unit tests still pass; 139 tools still exposed.

## [0.1.0] - 2026-05-25

Initial public release.

### Added
- **139 MCP tools** covering 18 Avito API domains (138 endpoints + `meta_get_rate_limits`).
- OAuth `client_credentials` flow with automatic token refresh on 401, exponential backoff on 429/5xx.
- stdio transport — compatible with Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, Zed and any MCP-compatible client.
- Rate-limit observability via `meta_get_rate_limits`.
- npm distribution: `npx -y avito-mcp` for zero-install setup.
- Declarative `tool-factory.ts` — adding a new Avito swagger requires one file in `src/domains/` plus one line in `src/meta/domain-registry.ts`.
- Multipart upload support (`messenger_upload_images`).
- 31 unit tests (vitest) covering core HTTP client, OAuth token store, URL builder.

### Domains covered (139 tools total)
`auth` (3) · `user` (3) · `items` (11) · `messenger` (14) · `autoload` (17) · `orders` (12) · `delivery` (31) · `promotion` (7) · `cpa` (11) · `cpa_target` (5) · `cpa_auction` (2) · `stock` (2) · `hierarchy` (5) · `reviews` (4) · `tariffs` (1) · `trxpromo` (3) · `calltracking` (3) · `msg_discounts` (5) · `meta` (1).

### Not supported in this release
Avito provides separate APIs for the following verticals; their swagger specs are not bundled: Auction, Autostrategy, Autoteka, Jobs/Vacancies, Realty Reports, Short-term rent (STR).

## [0.1.3] - 2026-05-25

### Changed
- **README major rewrite (EN + RU)** for adoption. New collapsible `<details>` sections for every tool group and every supported AI client. Less technical jargon, more concrete use cases.
- **Expanded AI client coverage from 8 to 16+**: added ChatGPT Desktop (Connectors), Codex CLI, VS Code (Copilot Chat), JetBrains AI Assistant, Goose, Roo Code, Kilo Code, LibreChat, Cherry Studio. Generic stdio fallback still listed.
- Added **"Built for autonomous workflows"** section pointing at multi-agent runtimes and cron-scheduled agents as the intended deployment pattern.
- Added **12+ example prompts** organised by use case (analyse, communicate, promote, fulfil, automate) to help users see what's possible at a glance.
- Reworded tool descriptions to be action-oriented rather than implementation-oriented.

### Added
- Documented the **Avito API snapshot date** (`2026-05-25`) in README header (badge) and in the "What's included" section, so users know which point-in-time of Avito's public spec the bundled swaggers reflect.

### Confirmed
- 138/138 swagger endpoints remain fully covered as MCP tools (+1 meta tool = 139). No code, no swagger, no test changes in this release — docs only.

## [0.1.2] - 2026-05-25

### Fixed
- README.ru.md: replaced broken 404 link `https://www.avito.ru/profile/settings/api` (used in the "How to get Profile_id" instructions) with a working description pointing to the main API page and to `user_get_user_info_self` as a programmatic alternative.

## [0.1.1] - 2026-05-25

### Fixed
- README: corrected links in the "Not supported" section. Replaced placeholder URLs (auto/, realty/) with the actual Avito API documentation URLs for the six unbundled verticals: auction, autostrategy, autoteka, job, realty-reports, str.

[0.5.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.5.0
[0.4.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.4.1
[0.4.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.3.0
[0.2.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.2.0
[0.1.4]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.0
