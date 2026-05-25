# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.2.0
[0.1.4]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.0
