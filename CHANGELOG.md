# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

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

[0.1.3]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.0
