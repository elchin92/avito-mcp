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

## [0.1.1] - 2026-05-25

### Fixed
- README: corrected links in the "Not supported" section. Replaced placeholder URLs (auto/, realty/) with the actual Avito API documentation URLs for the six unbundled verticals: auction, autostrategy, autoteka, job, realty-reports, str.

[0.1.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.1.0
