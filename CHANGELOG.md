# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-10

**End-to-end audit remediation release.** A multi-agent review covered the token client, destructive-operation pipeline, OAuth 2.1/HTTP transport, webhook receiver, all bundled OpenAPI contracts, tests, packaging, CI, Docker and systemd deployment. The implementation was then cross-reviewed with deterministic race reproductions. The resulting suite has **331 tests** across 30 files; whole-source coverage is **82.32% statements / 72.79% branches / 83.59% functions / 85.04% lines**. The manifest remains 148 tools, with corrected risk totals: `read:80 / write:40 / money:9 / public:16 / sensitive:3`.

### Security

- **Account-bound Avito token cache.** Persisted records now carry a SHA-256 binding to API origin, client id and profile id. Legacy/unbound/foreign records are ignored; the first valid call obtains a fresh token. Missing state directories are created as `0700`, token files use exclusive `0600` temp files, file and directory `fsync`, atomic rename and cleanup. Invalidation now shares the same lease as refresh and cannot delete another account/process's successor token.
- **Ownership-safe cross-process token lease.** The lock uses a private directory with PID + random owner marker + inode identity. Fresh partial markers receive a grace period, a live PID is never evicted by age, and an atomic transition marker ensures stale removal/release can delete only the generation it claimed, never a replacement owner's lock.
- **Mutation-safe HTTP behavior.** Automatic 429/5xx retry defaults to safe reads; mutations retry only by explicit code opt-in. One deadline now covers waits, token work, fetch and body consumption. JSON/text/binary bodies all use the bounded `AVITO_MCP_MAX_BINARY_MB` reader; retry bodies are cancelled/drained and `Retry-After` is capped with jitter.
- **Strict OAuth 2.1 authorization.** Tokens require the exact `avito:mcp` scope and exact MCP resource. Sessions are bound to the initializing principal; foreign principals receive the same response as unknown sessions. Consent transactions/codes are one-time, DCR metadata and auth methods are validated/bounded, inactive clients are swept/evicted, revoke is owner-aware and revokes the token pair.
- **Durable OAuth state concurrency.** Writes are serialized and fsynced; shutdown waits for the latest snapshot. The single-writer process lease uses a generation marker and atomic transition baton so delayed cleaner/release paths cannot touch a successor. Startup failures release acquired state.
- **OAuth consent and HTTP surface.** The consent page shows client, redirect and resource, is protected against framing, and requires a server-side one-time transaction. Host/Origin validation is fail-closed across OAuth/DCR/MCP routes. Session initialization is atomically capped, active SSE is not reaped as idle, and MCP logs are routed only to their owning session via `AsyncLocalStorage`.
- **Webhook exfiltration closed.** Both registration tools accept only the exact public HTTPS receiver URL configured by the operator; arbitrary destinations are rejected. Dry-run redacts the URL/secret. Registration, blacklist changes and both irreversible CPA complaint tools are now `risk: public`, so default `money_public` mode confirms them.
- **Webhook receiver/storage hardening.** Secret comparison uses fixed-size hashes in constant time, weak secrets fail startup, and bad-secret responses are status/body/minimum-time uniform and rate-limited. Disk logging persists only normalized metadata (no message text/raw payload), uses `0600`, rejects symlinks, rotates at 10 MiB, and is flushed on graceful shutdown.
- **Slow-body webhook oracle closed.** Valid and invalid path secrets now traverse the same 1 MiB body path before authentication changes control flow. An absolute one-second body deadline acknowledges and closes incomplete requests uniformly, while invalid or timed-out deliveries are never recorded and invalid attempts still consume their per-IP rate-limit budget.
- **Canonical webhook secret segment.** Receiver URLs now percent-encode the configured secret as exactly one path segment, so the documented Base64 generator works when a secret contains `/`, `+` or `=`. Existing subscriptions using such a secret must be re-registered with the encoded URL returned by the registration tool; alphanumeric URL-safe secrets are unchanged.
- **Race-safe confirmation and idempotency.** Confirmation is claimed atomically across sessions and remains active through execution/result storage. Pending/in-flight actions cannot produce a second confirmable mutation when the idempotency TTL is short. Keys of any previously valid length are reduced to domain-separated SHA-256 fingerprints before indexing/logging, and the ledger fails closed at 10,000 entries instead of growing without bound.
- **Bounded hard-confirm attempts.** When `AVITO_MCP_CONFIRMATION_SECRET` is configured, `meta_confirm_action` accepts at most 20 calls per minute per authenticated principal (including successful and unknown-id attempts); excess calls return `RATE_LIMITED`. The existing per-action limit still deletes a pending action after five wrong or missing secrets.
- **Descriptor-safe image upload.** The custom uploader now uses the common policy/dry-run/confirmation/idempotency pipeline. Uploads are count/dedup/aggregate-size bounded. Linux opens every path component through anchored descriptors with `O_NOFOLLOW` and inode checks; other platforms revalidate and fail closed. Local paths are redacted.
- **Defence-in-depth redaction.** Pino and MCP logging recursively censor token/password/cookie/API-key fields and local state paths. Auth status/resources expose only account-bound metadata and never token values or filesystem locations.

### API contracts

- Added a generated contract gate covering **18 Swagger files and all 138 endpoint wrappers**: method/path, required fields, scalar/array types, enum/min/max, path/query/body/header wiring, auth defaults, GET bodies, `X-Source`, sandbox metadata and mutation risk. Reviewed exceptions are explicit and limited to upstream spec defects/adapters.
- Added `AVITO_MCP_CPA_SOURCE` (default `avito-mcp`) and send the required allowlisted `X-Source` header on all CPA operations. Static headers reject unknown names and CR/LF values.
- Added the low-level GET-with-body transport required by `trxpromo_get_commissions`.
- Corrected delivery scalar inputs and typed delivery write bodies; fixed autoload schedule/feed types, sorting-center query wiring, analytics grouping, VAS sticker arrays, item statuses, enums, offsets and documented limits across the domain catalogue.
- Marked all documented delivery sandbox operations as `environment: sandbox`; `autoload_upload` is `public`.
- Structured output keeps the legacy `status` field and adds collision-free `http_status` as the authoritative HTTP code. Binary base64 remains in text as required for pre-2025-06-18 MCP clients and is also available in `structuredContent` for current clients.

### Reliability and operations

- Environment parsing is fail-fast for unknown enum/boolean values, malformed or out-of-range integers, unsafe URLs and weak remote secrets. `meta_auth_status` now requires all three Avito credentials and redacts the token path.
- `avito://manifest` reflects the active registration policy; webhook/pending resources follow the corresponding tool allow/deny policy. Tool-domain naming has one source of truth and manifest generation is deterministic.
- Added `/readyz` alongside the minimal unauthenticated `/healthz`; readiness covers complete HTTP credentials, writable token state, OAuth lease state and webhook persistence health without exposing details. HTTP shutdown closes MCP sessions, waits for the listener, flushes webhook/OAuth state and releases leases.
- Runtime baseline is Node.js `>=22.12.0`; CI covers Node 22 and 24. The Node 24 image runs as `node`, keeps code/dependencies root-owned read-only, writes only to its state directory, and probes the actual PID 1 or live `/readyz`.
- Hardened systemd units run as dedicated `avito-mcp`/`caddy` users with `UMask=0077` and sandboxing (`systemd-analyze security`: 3.0/3.2 OK). The installer creates immutable versioned releases, filters runtime env, serializes deploys with `flock`, atomically switches `current`, verifies readiness/version and transactionally restores config/units/services on failure.

### Tests and release pipeline

- `npm test` is self-contained (`pretest` generates the manifest); tests/scripts/source all have strict TypeScript checks. Coverage includes every `src/**/*.ts` file with blocking thresholds.
- CI actions are SHA-pinned. Dependency audit and gitleaks are blocking; jobs cover the real npm tarball, CLI, Docker health/immutability, HTTP restart, systemd syntax, OpenAPI contracts and Node 22/24.
- npm's install-script policy explicitly approves only the reviewed, version-pinned `esbuild@0.28.1` development postinstall; dependency upgrades surface a new review warning instead of inheriting a name-wide approval.
- Added a manual, read-only production smoke workflow with explicit opt-in and a main-only, manually approved npm trusted-publishing workflow (Node 24 + npm 11.15 + OIDC).
- Updated compatible development dependencies (`prettier` 3.9.5 and `typescript-eslint` 8.63.x). Full and production `npm audit` both report zero vulnerabilities.

### Upgrade notes

- **Node 20 is no longer supported.** Upgrade to Node `>=22.12.0`.
- A legacy or differently bound Avito token cache is ignored and replaced automatically on the next API call. A stale pre-1.2 file-style `{tokenFile}.lock` cannot be reclaimed with an atomic ownership check; after verifying that no older avito-mcp process is running, remove that one legacy lock manually. New directory leases reclaim dead owners automatically.
- OAuth artifacts without exact scope/resource binding are rejected; affected remote clients must authorize again. One running process may own an `AVITO_MCP_OAUTH_STORE_FILE`; use distinct files for multiple instances. A stale legacy file-style `.process.lock` is intentionally not removed automatically and must be inspected/removed by the operator.
- Webhook registration no longer accepts arbitrary URLs. Configure `AVITO_MCP_WEBHOOK_SECRET` and the public receiver URL, then pass that exact URL or use `messenger_register_webhook`.
- Legacy raw `webhook-events.jsonl` files are never migrated into service state. Inspect and securely delete or archive them according to your retention policy; new persistence contains normalized metadata only.
- Default confirmation now also covers webhook registration, blacklist changes and CPA complaints because they moved from `write` to `public`. `autoload_upload` likewise moves to `public`.
- Several Zod inputs that contradicted bundled Swagger are intentionally corrected (notably delivery scalar/write schemas, schedules, arrays, enums and limits). Clients generated from the old incorrect schemas should refresh `tools/list`.
- Invalid env values that previously fell back silently now stop startup with a diagnostic.

## [1.1.1] - 2026-07-09

**Dependency security patch.** Clears the transitive `npm audit` advisories reported in [#21](https://github.com/elchin92/avito-mcp/issues/21) — no application code changed, lockfile only. `npm audit` now reports **0 vulnerabilities**; `tsc`, `eslint` and 212 tests pass, and the manifest stays at 148 tools with unchanged `counts_by_risk`. The `package.json` ranges already permitted the patched versions, so this is a pure `package-lock.json` bump (also generated by `npm audit fix`).

### Security (fixed)

- **`hono` ≤ 4.12.24 → 4.12.28 (high).** A batch of advisories in the `hono` framework that `@modelcontextprotocol/sdk` pulls in transitively (CORS wildcard-reflection with credentials [GHSA-88fw-hqm2-52qc], `serve-static` path traversal, body-limit bypass, `Set-Cookie` merging, Lambda@Edge header dropping). This server runs on **Express and does not use `hono` at runtime**, so it was not directly exploitable here — the bump exists so `npm audit` stays clean for anyone vetting the package before connecting a live Avito account. (`package-lock.json`)
- **`esbuild` 0.28.0 → 0.28.1 (low, dev-only).** [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) — the esbuild dev-server can be made to reflect requests. Reachable only via `tsx`/`vitest` at development time; never shipped in the published package. (`package-lock.json`)

### Compatibility

- **Lockfile-only.** No runtime code, tools, schemas or env vars changed; behaviour is identical to v1.1.0. Manifest stays at 148 tools, `counts_by_risk` unchanged.

## [1.1.0] - 2026-06-18

**Security sweep.** An automated audit ("Codex Cyber") surfaced seven medium-severity issues across the destructive-operation, credential, webhook and binary surfaces; each was fixed in its own PR, then independently re-reviewed (adversarial multi-agent pass) before merge. The re-review found one real regression in a fix and a minor leak, both corrected here. Minor bump (not patch) because two fixes change behaviour: arbitrary webhook URL overrides are removed, and `AVITO_MCP_CONFIRMATION_SECRET` now requires ≥32 characters. `tsc`, `eslint` and 212 tests pass; the manifest stays at 148 tools with unchanged `counts_by_risk`.

### Security (fixed)

- **Cached-token introspection bypass** — `AvitoClient` now asserts all three credentials (`Client_id` + `Client_secret` + `Profile_id`) _before_ reading any token, so a token persisted on disk can no longer authenticate Avito calls when the server is started without full credentials. The v0.7.4 introspection-without-credentials feature is preserved (the guard only fires on authenticated requests; `tools/list` / resources / prompts still work creds-free). (`src/core/client.ts`)
- **Idempotency double-spend race** — concurrent destructive calls sharing one `idempotencyKey` could each create an independently-confirmable pending action (double charge on `money`/`public` tools). A new atomic `IdempotencyStore.runExclusive` coalesces them, and a duplicate pre-confirmation call now returns the same `confirmation_id` instead of a second pending action. (`src/core/idempotency.ts`, `src/core/tool-factory.ts`)
- **Webhook-redirect exfiltration** — `messenger_register_webhook` now registers **only** the operator-configured receiver URL; an arbitrary `url` override (which could redirect all incoming customer chat events to an attacker host) is rejected. (`src/domains/webhook.ts`) **Behaviour change:** the `url` parameter is accepted only when it equals the configured receiver URL.
- **Pending-actions resource policy gap** — the `avito://state/pending-actions` MCP resource is now gated by the same allow/deny policy as the `meta_list_pending_actions` tool, so it cannot leak confirmation ids when that tool is denied. (`src/resources.ts`)
- **Oversized binary responses without `Content-Length`** — binary bodies are now read as a stream with a running byte cap (`AVITO_MCP_MAX_BINARY_MB`), so a response that omits `Content-Length` can no longer blow past the limit; the declared-length pre-check is kept. (`src/core/client.ts`)
- **Hard-confirmation hardening** — `meta_confirm_action` secret checks are tightened (constant-time compare; 5 wrong/missing attempts delete the pending action to blunt brute-forcing). `AVITO_MCP_CONFIRMATION_SECRET` must now be **≥32 characters** (the server refuses to start otherwise). (`src/domains/meta.ts`, `src/config.ts`) **Breaking:** a deployment using a shorter secret must lengthen it.
- **Unconfirmed image uploads** — `messenger_upload_images` (a custom, non-`defineTool` handler) now also routes through the confirmation flow in `all_destructive` mode, closing a gap where it executed immediately. (`src/domains/messenger.ts`)

### Fixed (review findings on the above)

- **Stale-replay wedge** introduced by the idempotency change: a remembered `requires_confirmation` payload was never evicted when its pending action was cancelled or expired, so (because the pending TTL is shorter than the idempotency TTL) a retry with the same key replayed a dead `confirmation_id` for up to ~45 min. The ledger entry is now evicted on lookup when its pending action is gone, so the retry creates a fresh, confirmable pending action. Regression test added. (`src/core/idempotency.ts`, `src/core/tool-factory.ts`, `test/confirmation.test.ts`)
- **Failed-attempt counter leak**: the per-id confirmation-attempt counter is now cleared on `meta_cancel_action` and on a confirm against a missing pending, so the lockout map cannot grow unbounded. (`src/domains/meta.ts`)
- Dropped a now-misleading "or pass `url` explicitly" hint from the webhook reachability error, and made the `resourcesCount` startup log accurate when the pending-actions resource is hidden. (`src/domains/webhook.ts`, `src/resources.ts`)

### Compatibility

- No tools added/removed/renamed; manifest stays at 148 tools, `counts_by_risk` unchanged (read:80/write:46/money:9/public:10/sensitive:3).
- **Two intentional behaviour changes:** (1) `messenger_register_webhook` no longer accepts an arbitrary `url` override (security); (2) `AVITO_MCP_CONFIRMATION_SECRET` must be ≥32 chars or the server won't start. The credential guard's `Profile_id` requirement matches the already-documented contract (every authenticated call already needed all three creds).

## [1.0.3] - 2026-06-18

**Tool-definition polish on the lowest-scoring tools (Glama TDQS).** After v1.0.2 the server reached a 4.5/5 TDQS average (grade A); this release lifts the bottom tier — the tools that drag the score via the 40%-weighted minimum. Pure metadata: no tools added/removed/renamed, no schema or behaviour change; manifest stays at 148 and `counts_by_risk` is unchanged. `tsc`, `eslint` and 200 tests pass.

### Fixed

- **`autoload_upload` no longer claims "No parameters".** It is a destructive tool, so the factory adds the optional `dryRun` / `idempotencyKey` controls — the old "No parameters" line contradicted the input schema and cost the tool points on three TDQS dimensions (it was the joint-lowest at 3.6/5). The description now states it takes no business inputs, only the standard `dryRun` (preview) and `idempotencyKey` (duplicate protection). Verified that the other "no parameters" tools are genuinely parameterless reads (no contradiction).

### Changed

- **Lower-tier delivery tools enriched** per the TDQS rubric (return values, when-to-use, and sibling disambiguation, kept concise): `delivery_change_parcels`, `delivery_prohibit_order_acceptance`, `delivery_v1_create_announcement`, `delivery_create_sandbox_parcel_v2`, `delivery_sandbox_cancel_parcel`, `delivery_set_order_real_address`, `delivery_v1_change_parcel`. Each now discloses its result, states it is for delivery-service partners (a regular account gets 403/404), and points at its bulk/single or sandbox/production sibling.

### Compatibility

- No tools added/removed/renamed; no env vars or schemas changed. Description text only — runtime behaviour identical to v1.0.2.

## [1.0.2] - 2026-06-18

**Tool-definition consistency pass (annotation ↔ description).** A Glama [TDQS](https://glama.ai/blog/2026-04-03-tool-definition-quality-score-tdqs) re-score flagged that several tools' descriptions used destructive wording ("replaces the tariff's terminal set", "overwrites…") while their `destructiveHint` MCP annotation was `false` — a contradiction the scorer penalizes with 1/5 on the side-effects dimension. Ironically the v1.0.1 wording pass introduced some of these by prefixing delivery tools with `WRITE (replaces…)`. This release makes every tool's description and its `destructiveHint` hint tell the same story. Pure metadata: no tools added/removed/renamed, no schema or behaviour change; the manifest stays at 148 tools and `counts_by_risk` is unchanged. `tsc`, `eslint` and 200 tests pass.

### Fixed

- **`destructiveHint` now matches the described effect on every tool.** A sweep across all 18 domains aligned the annotation with the wording:
  - Tools that genuinely **replace/overwrite existing state** now declare `destructiveHint: true`: `delivery_add_terminals_sandbox` (the tool Glama scored 1/5 — "replaces the tariff's terminal set"), `delivery_set_order_properties`, `delivery_add_tariff_sandbox_v2`, `delivery_custom_area_schedule`, `autoload_create_or_update_profile`, `autoload_create_or_update_profile_v2` (upsert overwrites profile settings), `autoload_upload` (re-publishes/updates live listings), and `meta_cancel_action`.
  - Tools that only **append/record an event** keep `destructiveHint: false` and no longer use destructive-sounding wording: `delivery_tracking` and `delivery_sandbox_track_announcement` had their `WRITE (records state…)` prefix removed and now read "Appends one event; does not modify existing history"; `messenger_chat_read` reworded to make its additive, non-message-mutating nature explicit.
- **`messenger_register_webhook` kept consistent with its sibling.** It subscribes the same `/messenger/v3/webhook` endpoint as `messenger_post_webhook_v3` (an additive subscription), so it stays `destructiveHint: false` with additive wording, rather than being mislabeled as a destructive "replace".

### Changed

- Removed the awkward `WRITE (…)` pseudo-prefixes added in v1.0.1; descriptions now lead with a plain accurate verb (Glama also scores conciseness).

### Compatibility

- No tools added/removed/renamed; no env vars or schemas changed. `destructiveHint` is a client-facing MCP hint only — it does not affect the confirmation flow (driven solely by `risk`), so runtime behaviour is identical to v1.0.1. Safe to upgrade with no config changes.

## [1.0.1] - 2026-06-10

**Risk-classification fix + tool-definition polish.** A Glama [TDQS](https://glama.ai/blog/2026-04-03-tool-definition-quality-score-tdqs) re-score surfaced one tool whose annotations contradicted its description; an audit of every `risk: 'read'` tool across all 17 domains found a second instance of the same bug, and both are fixed here. No tools added/removed/renamed; the manifest stays at 148. `tsc`, `eslint` and 200 tests pass.

### Fixed

- **Two delivery sandbox POSTs that record tracking events were misclassified as `read`** — `delivery_tracking` (`POST /delivery-sandbox/order/tracking`) and `delivery_sandbox_track_announcement` (`POST /delivery-sandbox/announcements/track`) both **append an event on Avito's side** (they mutate state) but carried `risk: 'read'`, which made the factory emit `readOnlyHint: true` — directly contradicting their own descriptions ("it is a write, not a status read"). An MCP client trusting `readOnlyHint` could call them believing they were side-effect-free. Both are now `risk: 'write'` (correct `readOnlyHint: false`). The remaining 15 domains' read-risk tools were audited and confirmed correct (POST-as-query analytics endpoints are legitimately `read`).
- This shifts `counts_by_risk` in `dist/manifest.json` from `read: 82 / write: 44` to `read: 80 / write: 46`. The two tools are sandbox endpoints for delivery-service partners (no impact on regular sellers), but the fix means they are now correctly hidden under `AVITO_MCP_MODE=read_only` and reported as writes to clients.

### Changed

- **Tool-definition quality pass on the lowest-scoring tools** (Glama TDQS rubric): `delivery_tracking`, `delivery_sandbox_track_announcement`, `delivery_set_order_properties`, `delivery_add_terminals_sandbox` and `delivery_add_tariff_sandbox_v2` had their descriptions rewritten to front-load the WRITE/side-effect nature, state the return value and idempotency, and disambiguate each from its sibling tools. Pure metadata — no schema or behaviour change.

### Compatibility

- No tools added/removed/renamed; no env vars changed. The only behavioural delta is the corrected risk class on the two sandbox tracking tools (a bug fix). Safe to upgrade from 1.0.0 with no config changes.

## [1.0.0] - 2026-06-09

**Security-hardening pass over the v0.9.0 surface + the 1.0 stability commitment.** A 33-finding multi-agent audit of the new remote-MCP / OAuth 2.1 / webhook code was run right after v0.9.0 shipped; every confirmed finding is fixed here, with 28 new tests pinning the fixes (172 → **200 passing**). With the surface audited and the public API stable since v0.7.x, this release declares **1.0**: tool names, env vars, resource URIs and the safety model are now covered by SemVer — breaking changes only with a major bump. `tsc`, `eslint` and the full suite pass.

### Security (fixed)

- **`avito://state/config` leaked the v0.9.0 secrets** — `sanitizeConfig()` only redacted four top-level keys, so the nested `http.oauthOwnerPassword`, `http.authTokens` and `webhook.secret` (plus the `http.oauthStoreFile` / `webhook.logFile` paths) passed through verbatim to ANY connected MCP client. Now explicitly redacted, with a recursive secret-key sweep (`/(secret|password|token|credential)s?$/i`) as defence in depth so a future config field can't leak through this resource again. (`src/resources.ts`)
- **Owner-password endpoint was brute-forceable** — the SDK rate-limits `/authorize`, `/token` and `/register`, but our custom `POST /authorize/approve` (the one endpoint that actually verifies `AVITO_MCP_OAUTH_OWNER_PASSWORD`) had no limiter: with open DCR an attacker could hammer it at line speed. Now rate-limited to 10 attempts / 15 min / IP (`express-rate-limit`, new runtime dependency — already in the tree via the SDK). (`src/http/oauth/index.ts`)
- **DNS-rebinding protection was silently OFF by default**, contrary to the config docs and the MCP spec's Origin-validation MUST. With `AVITO_MCP_HTTP_ALLOWED_HOSTS`/`_ORIGINS` unset, allowlists are now **derived** from the public URL + bind address and protection is ON; the only opt-out is a wildcard bind (`0.0.0.0`/`::`) with no explicit public URL, where there is nothing to derive from (loudly warned). (`src/http/mcp-http.ts`)
- **Unauthenticated `/healthz` described the whole deployment** (exact version, auth scheme, safety mode, public URLs, credentials flag). It now answers only `{ok, name, version}`; the rich snapshot stays on the local-only `--health` CLI. (`src/http/app.ts`)
- **Logger redaction was shallower than documented** — pino `*` wildcards match exactly one level, so nested shapes (`err.response.headers.authorization`) logged secrets in clear, and the MCP log mirror (`bindMcpLogger`) bypassed redaction entirely. Redact paths now cover 1–3 levels + known deep shapes, and the mirror payload runs through a recursive censor before leaving the process. (`src/logger.ts`)
- **`.dockerignore` missed the v0.9.0 secret files** — `.remote.env` (owner password + webhook secret), `.npmrc` (npm token), `*.jsonl` (real chat events) and `deploy/Caddyfile` could enter the Docker build context. All excluded now.

### Fixed

- **OAuth: RFC 8252 loopback clients could never finish the flow** — `approveConsent` re-validated `redirect_uri` with an exact string match while the SDK's `GET /authorize` (correctly) allows any port on loopback hosts; native clients died with `Unregistered redirect_uri` _after_ the owner typed the password. Now uses the SDK's `redirectUriMatches` semantics at both validation points. (`src/http/oauth/provider.ts`)
- **OAuth: token store grew without bound** — expired entries were only collected when that exact token was presented again, and refresh rotation never revoked the abandoned access token (one orphan per refresh, forever, in memory and in `AVITO_MCP_OAUTH_STORE_FILE`). Added a 60-second expired-entry sweeper (`unref`'d) and eager revocation of the paired access token on rotation. (`src/http/oauth/store.ts`, `provider.ts`)
- **Streamable HTTP: unknown session ids answered 400 instead of the spec-mandated 404** — clients that lost their session to a server restart got wedged instead of re-initializing. Missing-id → 400 (`Mcp-Session-Id header is required`); unknown-id → **404 `-32001 Session not found`**. (`src/http/mcp-http.ts`)
- **Streamable HTTP: abandoned sessions lived forever** — a client that vanished without `DELETE` pinned a full 148-tool `McpServer` until process exit, with no cap on session creation. New: `AVITO_MCP_HTTP_MAX_SESSIONS` (default `100`, `initialize` beyond it → 503) and `AVITO_MCP_HTTP_SESSION_IDLE_SEC` (default `1800`) idle reaping.
- **Per-session listener leak** — every HTTP session subscribed two listeners on the process-wide pending/webhook stores via `registerResources` and never unsubscribed; closed sessions kept receiving (and failing) `sendResourceUpdated` calls forever. Subscriptions are now torn down on server close, covered by a test. (`src/resources.ts`)
- **Webhook receiver: malformed JSON returned an HTML 400 with a full stack trace** (Express default error page), bypassing both the documented always-200 contract and the secret check. A final error handler now answers **200 `{ok:true}`** for genuine deliveries (correct secret) even on a parse failure — Avito never retries/disables the subscription — and a terse JSON 400/500 elsewhere. A catch-all JSON 404 also makes "wrong secret" byte-identical to "no such route", as the receiver always intended. (`src/http/app.ts`)
- **`messenger_register_webhook` could subscribe Avito to `http://127.0.0.1:3000`** — with only `AVITO_MCP_WEBHOOK_SECRET` set, the default URL silently fell back to the loopback HTTP base and the tool happily registered an unreachable address with production Avito. The computed/overridden URL is now validated (HTTPS, non-loopback, non-private) with a clear error, and the server warns at startup when the effective webhook public URL is loopback.
- **`messenger_register_webhook` `url` override was dead** when the local receiver wasn't configured — `defaults()` threw before the override was merged. Validation moved to the body `transform`, which sees the merged body; the documented override now works.
- **`AVITO_MCP_WEBHOOK_ENABLED` was broken in both directions** — `=0` could not disable the receiver while a secret was set, and `=1` without a secret mounted a dead receiver that 404'd everything while the status tool reported it ready. Now: the explicit flag wins for disabling; a secret is required for enabling (warned at startup otherwise). (`src/config.ts`)
- **`AVITO_MCP_WEBHOOK_PATH` without a leading slash registered an unmatchable route** (Express accepts it silently; every delivery 404'd). The path is now normalized.
- **Webhook JSONL log failed silently** — `fs.appendFile` doesn't create parent directories and errors were logged at `debug` (invisible at the default level), so a typo'd `AVITO_MCP_WEBHOOK_LOG_FILE` lost every event with zero signal. The directory is created at construction and append failures log at `warn` (throttled to once a minute).
- **No graceful shutdown** — nothing handled SIGTERM/SIGINT (the normal Docker/systemd stop path), so in-flight `/mcp` responses were killed and the OAuth store never flushed; `closeAll()` also cleared the session map before closing, orphaning the per-session servers. Both fixed.

### Changed

- **`express-rate-limit` is now a direct runtime dependency** (was already present transitively via the MCP SDK).
- **`trust proxy = 'loopback'`** on the Express app — `req.ip` (rate-limit keying, logs) is the real client address behind the documented local reverse proxy, while a spoofed `X-Forwarded-For` on a direct connection is never believed.
- **Documentation rewritten for 1.0.** Both READMEs rewritten as stable-product docs: version-stamped headings (`(v0.6.0)`, `(v0.7.0)`, `(v0.9.0)`) removed, a new **Versioning & stability** section states the SemVer commitment, and factual corrections landed throughout — protected-resource metadata path is `/.well-known/oauth-protected-resource/mcp` (RFC 9728), the Caddy snippet matches it (wildcard) and proxies `/revoke`, the nginx alternation gains `revoke`, the tests badge reads 200, env tables document the new session/rebinding semantics. `CONTRIBUTING.md` (148-tool architecture, English tool definitions, real CI command list), `SECURITY.md` (remote HTTP + webhook surfaces in scope) and `SUPPORT.md` refreshed. `.env.example` tool counts corrected (≈82 read-only / ≈125 guarded); `docs/safety.md` updated (webhook tools classified, `AVITO_MCP_CONFIRMATION_SECRET` is shipped since v0.5.0 — no longer "future work", stale counts fixed).
- Dev dependencies bumped (`@types/node`, `@vitest/coverage-v8`, `eslint`, `tsx`, `typescript-eslint`); CI actions bumped (`actions/checkout` v4→v6, `actions/setup-node` v4→v6, `gitleaks/gitleaks-action` v2→v3).

### Compatibility

- **No tools added/removed/renamed** — the manifest stays at 148 tools. stdio behaviour is unchanged.
- New env vars (`AVITO_MCP_HTTP_MAX_SESSIONS`, `AVITO_MCP_HTTP_SESSION_IDLE_SEC`) have safe defaults.
- Three deliberate behaviour changes, all fail-safe hardening: (1) DNS-rebinding protection defaults ON for HTTP deployments — wildcard-bind LAN setups that relied on it being off must set `AVITO_MCP_HTTP_ALLOWED_HOSTS`; (2) `AVITO_MCP_WEBHOOK_ENABLED=1` without a secret no longer pretends to enable the receiver; (3) `/healthz` no longer exposes deployment details — probes that parsed more than `{ok}` must use `--health` locally.

## [0.9.0] - 2026-06-09

**Remote MCP + webhook receiver.** Two big additive capabilities: the server can now be served over the network as a **remote MCP** (Streamable HTTP) secured by **OAuth 2.1**, and it can **receive Avito webhooks** (real-time chat/message events) instead of only polling. stdio remains the default and is unchanged — every existing local deployment keeps working byte-for-byte. `tsc`, `eslint` and the full suite pass.

### Added

- **Remote MCP over HTTP (Streamable HTTP transport).** New `AVITO_MCP_TRANSPORT = stdio` (default) `| http | both` (CLI: `--http`). In `http`/`both` mode the server exposes the MCP endpoint at `/mcp` plus a full **OAuth 2.1** authorization server:
  - `AVITO_MCP_HTTP_HOST` (default `127.0.0.1`), `AVITO_MCP_HTTP_PORT` (default `3000`), `AVITO_MCP_HTTP_PUBLIC_URL` (e.g. `https://mcp.example.com` — used to build OAuth issuer / resource metadata; no trailing slash).
  - `AVITO_MCP_HTTP_AUTH = oauth` (default) `| bearer | none`. In **oauth** mode clients self-register (**DCR**, `/register`), run **authorization-code + PKCE**, a human approves at `/authorize` by entering the **owner password** (`AVITO_MCP_OAUTH_OWNER_PASSWORD`, **required** in oauth mode — the only person who can mint a token), and the issued bearer token then guards `/mcp`. Token TTL via `AVITO_MCP_OAUTH_TOKEN_TTL_SEC` (default `3600`); optional on-disk persistence via `AVITO_MCP_OAUTH_STORE_FILE`.
  - **bearer** mode uses one or more shared secrets (`AVITO_MCP_HTTP_AUTH_TOKEN`, comma-separated). **none** disables auth — refused on a non-loopback host unless `AVITO_MCP_HTTP_ALLOW_NO_AUTH=1` (discouraged).
  - **DNS-rebinding protection** via `AVITO_MCP_HTTP_ALLOWED_HOSTS` / `AVITO_MCP_HTTP_ALLOWED_ORIGINS` (CSV).
  - Endpoints exposed: `/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/authorize`, `/token`, `/register`, `/healthz`. Node binds `127.0.0.1`; TLS is terminated by a reverse proxy (nginx/Caddy) — ready-to-paste configs in both READMEs.
- **Avito webhook receiver** — the server can now accept Avito's real-time messenger push (new messages / chat events) at a secret-guarded URL, so agents react to events instead of polling. Works **even in pure stdio mode** (Avito needs a public URL; the MCP client does not).
  - `AVITO_MCP_WEBHOOK_SECRET` (enables the receiver; the secret is a path segment so the URL is unguessable) or `AVITO_MCP_WEBHOOK_ENABLED`. `AVITO_MCP_WEBHOOK_PUBLIC_URL` (public base Avito POSTs to; defaults to the HTTP public URL), `AVITO_MCP_WEBHOOK_PATH` (default `/avito/webhook`), `AVITO_MCP_WEBHOOK_BUFFER` (ring-buffer size, default `100`), `AVITO_MCP_WEBHOOK_LOG_FILE` (optional JSONL audit log).
  - Receiver endpoint: `POST {PUBLIC_URL}{PATH}/{SECRET}` → `200 {"ok":true}` in well under Avito's 2-second deadline.
- **3 new tools** (all in the `messenger` domain): `messenger_get_webhook_events` (read — drains the buffered events), `messenger_get_webhook_status` (read — receiver stats: retained / total received / last received), `messenger_register_webhook` (write — subscribes the configured public URL with Avito).
- **New subscribable resource** `avito://webhook/events` — clients can `resources/subscribe` and receive `notifications/resources/updated` as events arrive.

### Changed

- **Tool count 145 → 148** (+3 webhook tools). `dist/manifest.json` updated; `counts_by_risk` gains 2 `read` + 1 `write`.
- **`express` added as a runtime dependency** (Express 5) — backs the HTTP transport, the OAuth endpoints and the webhook receiver. Pulled in lazily; pure-stdio deployments never start the HTTP listener.
- **Swagger filenames in `swaggers/` are now English** (`messenger.json`, `items.json`, `orders.json`, `delivery.json`, …) instead of the previous Cyrillic names. The `avito://swaggers/{slug}` resource slugs and the `complete` autocomplete follow the new names. (Supersedes the v0.8.0 note that the on-disk specs kept Russian filenames.)

### Compatibility

- **stdio is still the default** — with no `AVITO_MCP_TRANSPORT` set, behaviour is identical to v0.8.0. The HTTP listener, OAuth endpoints and webhook receiver are all opt-in.
- No tools removed or renamed; the 145 existing tools are unchanged. New env vars all have safe defaults.

## [0.8.0] - 2026-05-29

**Internationalization (i18n) pass.** All tool definitions, code comments and runtime-facing strings are now in English for a global audience of developers and AI agents; MCP prompts are bilingual (English + Russian). No tools added/removed/renamed, no schema or behaviour change — pure surface-language metadata. `tsc`, `eslint` and 144/144 tests pass.

### Changed

- **All 145 tool `title` / `description` / parameter docs → English.** The Russian display titles added in v0.7.1 are translated; the `⚠️` destructive prefix is preserved. Tool name slugs, API field names, paths and enum values are unchanged.
- **MCP prompts are now bilingual** (`src/prompts.ts`) — English first, then Russian, so both audiences can use them. Tool names and JSON snippets inside the prompts are untouched.
- **Code comments across `src/`, `scripts/` and tests translated to English.**
- **Runtime-facing strings → English** — the MCP server `instructions` / `description`, the `dryRun` / `idempotencyKey` parameter docs on destructive tools, the confirmation-flow response messages (`meta_*_action`), and every `avito://` resource title/description. The server `description` tool count was also corrected from a stale "142" to 145.
- **`registry.test.ts` convention flipped** — tool descriptions are now asserted to be English (no Cyrillic), guarding against regressions in CI.

### Notes

- Swagger filenames in `swaggers/` (e.g. `Доставка.json`) keep their Russian names — they are the real on-disk Avito spec files.
- Avito API response strings matched in tests (e.g. error-message regexes) are unchanged — they reflect what Avito itself returns.

## [0.7.5] - 2026-05-29

**Tool-definition quality pass.** Every one of the 137 API tools had its description and parameter docs rewritten for agent legibility, following Glama's Tool Definition Quality rubric (purpose → usage → behaviour/side-effects → parameter semantics → disambiguation). Pure metadata: no tool added/removed/renamed, no schema/behaviour change. `tsc`, `eslint` and 144/144 tests all pass.

### Changed

- **Enriched all tool descriptions** — each now front-loads a clear verb + resource, states when (and when _not_) to use it, flags side effects and visibility (money / public-to-buyer / irreversible), and disambiguates version-suffixed or sandbox-vs-prod siblings (`_v1`/`_v2`/`_v3`, `[SANDBOX]` vs `[3PL]`).
- **Every input parameter now has a meaningful `.describe()`** — formats, units, constraints and enum values sourced from the bundled swagger snapshot. Previously-opaque params (e.g. `announcementID`, delivery nested bodies) are explained.
- **Honest `destructiveHint` annotations** — cancellations, deletions, removals, unsubscribes and account re-links are policy-`write` but irreversible, so they now report `destructiveHint: true` to MCP clients instead of inheriting `false`. New optional `ToolSpec.destructiveHint` override drives this; risk classification and confirmation policy are unchanged.

### Added

- **`glama.json`** (repo root) — claims ownership of the Glama listing (`maintainers: [elchin92]`) and lets Glama pick up metadata; closes the "No glama.json" profile-completion gap.

### Compatibility

- No tools added/removed/renamed; manifest stays at 145 tools (141 introspectable without `AVITO_MCP_EXPOSE_AUTH_TOOLS`). Behaviour identical to v0.7.4 — descriptions, parameter docs and one annotation hint are the only changes.

## [0.7.4] - 2026-05-28

**Introspection without credentials + Docker.** The server now starts and serves `tools/list`, resources and prompts even when `Client_id` / `Client_secret` / `Profile_id` are absent — needed by registry indexers (Glama) to score the server, by MCP inspectors, and so `npx avito-mcp` can preview the catalogue before configuration. Credentials are enforced lazily.

### Changed

- **Credentials are optional at startup** — `config.ts` no longer `process.exit(1)` when `Client_id`/`Client_secret`/`Profile_id` are missing. The full 145-tool catalogue still registers; `tools/list` works with zero config. A clear startup `WARNING` notes "introspection-only mode".
- **Lazy credential enforcement** — the first tool call that needs to hit Avito throws a new `MissingCredentialsError`, surfaced as a structured `CONFIG_ERROR` (`structuredContent.error.type`), not a network attempt. No empty-credential request is ever sent to Avito's `/token`.
- `Config.profileId` is now `number | undefined`; `injectProfileId` only injects when a profile id is configured.

### Added

- **`Dockerfile`** (multi-stage, `node:20-alpine`) + **`.dockerignore`** — builds and runs the stdio server; verified to start and answer `tools/list` (141 tools) with no credentials. Registry indexers can build + introspect it. Run: `docker run --rm -i -e Client_id=… -e Client_secret=… -e Profile_id=… avito-mcp`.
- **New error type `CONFIG_ERROR`** in the structured taxonomy, with `MissingCredentialsError`.
- Tests: `test/no-credentials.test.ts` (3) — tools/list without creds, tool call → `CONFIG_ERROR` (no fetch), full registry loads unconfigured. **Total: 144 passing (was 141).**
- The registry `server.json` description is now agent-focused ("for autonomous AI agents … not a scraper") and ships to the official MCP Registry with this version.

### Compatibility

- Configured deployments are unaffected — credentials present → identical behaviour to v0.7.3.
- No tools added/removed/renamed; manifest stays at 145 tools.

## [0.7.3] - 2026-05-28

**Registry metadata.** Adds the `mcpName` field (`io.github.elchin92/avito-mcp`) to `package.json` so the package can be published to and verified by the [official MCP Registry](https://registry.modelcontextprotocol.io). No code change — pure metadata for discovery. The registry verifies ownership by matching this `mcpName` against the `name` in the server's `server.json`.

### Added

- `package.json` → `mcpName: "io.github.elchin92/avito-mcp"` — ownership-verification anchor for the official MCP Registry (npm package-type verification).
- `server.json` (repo root) — server manifest for the official registry: name, description, repository, npm package reference (stdio transport), and the required env vars `Client_id` / `Client_secret` / `Profile_id`.

## [0.7.2] - 2026-05-28

**Bugfix sweep.** Five more tools had input schemas that didn't match the real Avito request body (same class as the v0.7.1 BBIP-create bug) plus a docs-count correction. All six fixes verified against the bundled swagger snapshot. No new features, no tool added/removed/renamed; manifest stays at 145 tools and 141/141 tests pass.

### Fixed

- **`stock_update_stocks`** — `src/domains/stock.ts`. Each item was `{ item_id, stock }`, but `PUT /stock-management/1/stocks` requires `{ item_id, quantity }` (both required) with optional `external_id`. The wrong `stock` field meant quantity updates silently failed. High impact — live inventory.
- **`promotion_get_bbip_forecasts_by_items_v1`** — `src/domains/promotion.ts`. Still used the old `ItemBudget` (`{ itemId, budget }`), but `BbipForecastRequestByItemV1` requires the **same** `{ itemId, duration, oldPrice, price }` as BBIP-create. v0.7.1 fixed only the create tool; this fixes forecasts too. The now-unused `ItemBudget` schema was removed; `BbipOrderItem` is shared by both tools.
- **`items_post_account_spendings`** — `src/domains/items.ts`. `grouping` was an object `{ period }` but `SpendingsRequest.grouping` is a **string enum** `"day" | "week" | "month"`. Also dropped the non-existent `filter.employeeIDs`; the valid filter fields are `categoryIDs` / `itemIDs` / `locationIDs`.
- **`promotion_list_orders_by_user_v1`** — `src/domains/promotion.ts`. Pagination field was `per_page`; the API expects `perPage` (camelCase). Page size was being ignored.
- **`delivery_custom_area_schedule`** — `src/domains/delivery.ts`. `customAreaScheduleRequest` is a top-level JSON **array**, but the tool wrapped it as `{ schedules: [...] }`. Now sends the array directly via `transform`, matching the five neighbouring array-body delivery tools. (Sandbox endpoint — low impact.)
- **`delivery_create_parcel`** — `src/domains/delivery.ts`. Declared only `barcodes`, but `CreateParcelRequest` requires `orderID`, `parcelID`, `items`, `sender`, `receiver`, `payment` (with `barcodes` / `directOrderID` / `options` / `package` optional). (3PL partner endpoint — low impact on regular accounts.)
- **README tool count** — `README.md` / `README.ru.md`. v0.7.0 added 3 meta tools but the docs still said "4 local/meta = 142". Corrected to "7 local/meta = 145" across headline, configuration table, prose and architecture diagram in both languages.

### Added

- **Human-readable `title` on all 145 tools.** v0.6.0 introduced `ToolSpec.title` but only 17 high-traffic tools carried one; the other 128 fell back to their snake_case `name` in MCP clients. This release backfills Russian display titles across every domain (auth, autoload, calltracking, cpa, cpa_auction, cpa_target, delivery, hierarchy, items, messenger, msg_discounts, orders, promotion, reviews, stock, tariffs, trxpromo). Destructive tools are prefixed `⚠️`. The manifest snapshot test now asserts **full title coverage** as an invariant — a new tool without a title fails CI. (Additive metadata; no behaviour change.)

## [0.7.1] - 2026-05-28

**Bugfix.** BBIP order creation was unusable: Avito rejected every `promotion_create_bbip_order_for_items_v1` call with «Не удалось найти бюджет продвижения по указанным параметрам», so no client could ever launch a BBIP campaign. Pure fix — no new features, no other tool surface changed.

### Fixed

- **`promotion_create_bbip_order_for_items_v1` input schema now matches the Avito `BbipOrderByItemV1` contract** — `src/domains/promotion.ts`. The tool declared each item as `{ itemId, budget? }`, but `PUT /promotion/v1/items/services/bbip/orders/create` actually requires `{ itemId, duration, oldPrice, price }` — all required, `oldPrice`/`price` in **kopecks per day**, `duration` in **days**. The non-existent `budget` field made every payload invalid. Added a dedicated `BbipOrderItem` schema for the create tool; `ItemBudget` is kept for `promotion_get_bbip_forecasts_by_items_v1` (which does take a per-item `budget`). The create tool description now documents the suggests→create flow: take `budgets[].{oldPrice,price}` and `duration.recommended` from `promotion_get_bbip_suggests_by_items_v1`; full budget = `price × duration`. No other tool changed; manifest snapshot test unaffected (141/141 pass).

## [0.7.0] - 2026-05-26

**Universal package hardening.** Pure-additive defaults: every change is opt-in via env or CLI flag, no existing user-facing tool surface changed. Brings five public-package primitives: cross-process token lock, structured error taxonomy, idempotency ledger, dry-run middleware, and health/auth/capabilities meta-tools — without any tie-in to a specific user, business, or backend.

### Added

- **Cross-process token file-lock** — `src/core/file-lock.ts`. OAuth refresh in `TokenStore.refresh` is now guarded by a `{tokenFile}.lock` file with PID + timestamp + stale-detection (`process.kill(pid, 0)`). Inside the lock a double-check re-reads the token file — if another process already refreshed, no extra `/token` call is made. Defends against thundering-herd from multiple workers / cron / CLI hitting Avito's `/token` endpoint at once. Configurable via `AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS` (default 30000ms).
- **Structured error taxonomy** — `errorToMcpContent` now classifies errors into a formal `ErrorType` union: `AVITO_BAD_REQUEST` / `AVITO_UNAUTHORIZED` / `AVITO_FORBIDDEN` / `AVITO_NOT_FOUND` / `AVITO_RATE_LIMIT` / `AVITO_SERVER_ERROR` / `AVITO_API_ERROR` / `NETWORK_ERROR` / `TIMEOUT` / `INTERNAL_ERROR`. The envelope carries `retryable: boolean`, `retryAfter?: number` and `httpStatus?: number` — agents make programmatic retry decisions without regex over text. Legacy `error_kind` preserved for v0.6.x consumers.
- **Idempotency ledger** — `src/core/idempotency.ts`. Every write/money/public tool now accepts an optional `idempotencyKey: string` parameter (min 8 chars) in its input schema. With an `IdempotencyStore` attached to `ToolContext`: same key + identical args replays the cached `CallToolResult` (marked `structuredContent.idempotent_replay: true`); same key + different args returns a structured conflict error. TTL via `AVITO_MCP_IDEMPOTENCY_TTL_SEC` (default 3600s). Argument hashing is order-stable (`sha256` over sorted JSON). In-memory only; persistent backends are an extension point.
- **Dry-run middleware** — every destructive tool now accepts `dryRun: boolean` in its input schema. When `true` (or when `AVITO_MCP_DRY_RUN_DEFAULT=true`), the tool returns a structured preview `{ dryRun, explicit_request, operation, request_preview }` without calling Avito — agents and operators can inspect _what would happen_ before going live. Dry-run bypasses both confirmation flow and idempotency ledger (no effect to dedupe).
- **Three new meta-tools with strict `outputSchema` (zod)** — `meta_health`, `meta_auth_status`, `meta_capabilities`. All read-only, local environment, no Avito API calls. `meta_auth_status` returns only token _metadata_ (presence, `expiresInSec`, last refresh error) — the access token value itself is NEVER returned, even with `probe: true`.
- **CLI flags** — `--readonly`, `--guarded`, `--dry-run`, `--no-confirmation` as syntactic sugar for the corresponding env vars (env wins if both set). `--health` prints a JSON health snapshot and exits without opening stdio transport — perfect for container/k8s probes or quick diagnostics.
- **pino redact paths for token defence-in-depth** — `logger.ts` now redacts any field named `Authorization`, `authorization`, `accessToken`, `access_token`, `refresh_token`, `refreshToken`, `client_secret`, `clientSecret`, `bearer`, `Bearer`, `token` from logged objects. Current code never logged these, but future regressions are caught automatically.

### Test coverage

5 new test files, 31 additional cases. **Total: 141 passing (was 110, +31).**

- `test/file-lock.test.ts` — 5: serialisation, stale-by-PID, stale-by-age, timeout, release-on-throw
- `test/idempotency.test.ts` — 6: stable hash, hit/miss, cross-tool isolation, TTL expiry, conflict, list()
- `test/dry-run.test.ts` — 5: schema injection only on destructive, preview without HTTP, dryRun=false executes, env default, bypasses confirmation
- `test/meta-tools.test.ts` — 4: health snapshot, capabilities reflects config, auth_status without token, auth_status without leaking token value
- `test/error-taxonomy.test.ts` — 10: every HTTP status class, network/timeout, internal, retryable/retryAfter propagation

### Manifest

- `dist/manifest.json` tool_count: 142 → **145** (+3 new meta tools, all `risk: read`).
- `counts_by_risk.read`: 77 → 80.
- New per-tool `_meta` flags: `supportsDryRun: true`, `supportsIdempotency: true` for destructive tools — programmatic discoverability of v0.7.0 features.

### New env vars (all opt-in, safe defaults)

- `AVITO_MCP_DRY_RUN_DEFAULT` — `true|false` (default `false`)
- `AVITO_MCP_IDEMPOTENCY_TTL_SEC` — positive integer (default `3600`)
- `AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS` — positive integer (default `30000`)

### Compatibility

- No tools removed, no tools renamed, no defaults changed for existing knobs.
- Every existing v0.6.x client continues to work unchanged — the new `dryRun` and `idempotencyKey` parameters are _optional_; if not passed, behaviour is identical to v0.6.x.
- Test fixtures that construct `Config` objects in user code may need three new fields (`dryRunDefault`, `idempotencyTtlSec`, `tokenLockTimeoutMs`); using the zod-parsed loader (`config.ts`) requires no changes.

## [0.6.0] - 2026-05-25

MCP **2025-11-25 alignment release**. Adds first-class **Resources**, **Prompts**, **structured tool outputs**, **MCP logging** and a richer **server `Implementation`**. Pure additive on the protocol layer — every v0.5.x client continues to work unchanged; clients that understand the new MCP fields just see more.

### Added

- **MCP Resources** — new module `src/resources.ts` registers 5 static resources + 1 dynamic template:
  - `avito://docs/safety` — markdown guide for safety modes / confirmation / hard-confirmation (same body as `docs/safety.md`).
  - `avito://manifest` — live `dist/manifest.json` (tool catalogue with risk / domain / annotations / titles).
  - `avito://state/config` — sanitized snapshot of the active config. Secrets (`clientId`, `clientSecret`, `confirmationSecret`, `tokenFile`) replaced with `'[redacted]'` or `null` — never leak.
  - `avito://state/rate-limits` — latest `X-RateLimit-*` per logical Avito API domain.
  - `avito://state/pending-actions` — **subscribable**: clients can `resources/subscribe` and get `notifications/resources/updated` on every create/confirm/cancel/expire in the in-memory pending store. Backed by a new `onChange` hook on `PendingActionStore`.
  - `avito://swaggers/{slug}` — ResourceTemplate over `swaggers/*.json` with `list` + autocomplete via `complete`. Path-traversal guarded (no `..`, `/`, `\0`; resolved path must stay under `swaggers/`).
- **MCP Prompts** — new module `src/prompts.ts` exposes 5 ready prompts:
  - `avito_daily_overview` (`days?`) — orchestrates balance + active items + spendings.
  - `avito_check_unread_chats` (`limit?`) — read-only triage of unread chats; explicit guard "do not send / blacklist".
  - `avito_safety_report` — consult `state/config` + `manifest` + `docs/safety` to explain current mode.
  - `avito_explain_tool` (`tool_name`) — cross-reference manifest entry + matching swagger.
  - `avito_promote_item` (`item_id`) — gather everything needed before a paid VAS purchase; explicit "не покупай" guard.
- **`structuredContent`** on every tool response — the standard `content[]` text block is preserved, and a parallel JSON `structuredContent` is added for clients that prefer to parse without regex:
  - Object responses → `{ status, ...data }`.
  - Array responses → `{ status, items, count }`.
  - Binary responses (PDF labels, audio recordings) → `{ status, mimeType, sizeBytes, base64 }`.
  - Errors (`AvitoApiError` / `AvitoTransportError`) → `{ error_kind, status?, request, body? }` with `isError: true`.
- **MCP logging** — `bindMcpLogger(server)` in `src/logger.ts` mirrors pino events to MCP `notifications/message` (`debug`/`info`/`warning`/`error`/`critical`) so connected clients can stream logs without reading stderr. Pino → stderr behaviour preserved. Capability declared as `logging: {}` in `ServerCapabilities`.
- **Tool `title`** — new optional `ToolSpec.title` plumbed through `registerTool`. Russian human-readable display names on the highest-traffic tools (user / items / messenger / meta). MCP display precedence: `title` → `annotations.title` → `name`. Manifest now carries `title` per entry; snapshot test asserts ≥7 tools with Cyrillic titles.
- **Server `Implementation`** enrichment — `McpServer` now ships with `title: 'Avito MCP'`, a multi-line `description`, `websiteUrl`, declared capabilities (`tools`/`resources`/`prompts`/`logging`), and `instructions` pointing to `avito://docs/safety` + `avito://manifest`. Inspector-class clients render these in the connection picker.
- **Resource subscribe/unsubscribe handlers** — SDK doesn't auto-register them when `resources.subscribe: true` is declared, so `src/resources.ts` adds tiny handlers that track subscribers per URI and route `sendResourceUpdated` only to subscribed URIs.
- **New tests** — `test/resources.test.ts` (5 cases: listing, sanitized config, live pending-actions, subscribe→notify roundtrip, swagger template + path-traversal reject), `test/prompts.test.ts` (4 cases: list, daily_overview substitution, promote_item guards, unread_chats read-only guard), `test/structured-content.test.ts` (5 cases: object, array, binary, error, text). Manifest snapshot test gained a "titles are Cyrillic" assertion. **Total: 110 passing (was 95, +15).**

### Changed

- `dist/manifest.json` entries now include optional `title` field. Same `tool_count: 142` and same `counts_by_risk`. Snapshot test unchanged (inventory is `risk + domain + name`).
- `PendingActionStore` emits change events through a new `onChange(listener)` subscription. Existing call sites (`meta_confirm_action`, `meta_cancel_action`) unchanged — events are fan-out only.
- `errorToMcpContent` always returns `structuredContent` alongside `isError: true` text.
- `ToolContext` gained optional `server?: McpServer` so resources/prompts modules can reach `sendResourceUpdated`, `sendLoggingMessage`.

### Compatibility

- No new env vars. No tool removals or renames. Defaults unchanged.
- Same 142 tools, same `risk` classification, same safety contract.
- Clients that don't understand the new MCP fields ignore them; structured/text content remains backward-compatible.

## [0.5.1] - 2026-05-25

External audit pass. Closes the four remaining polish items the v0.5.0 reviewer flagged.

### Fixed

- **Policy was not applied to `meta_confirm_action`, `meta_cancel_action`, `meta_list_pending_actions`.** They bypassed `AVITO_MCP_ALLOW_TOOLS` / `AVITO_MCP_DENY_TOOLS`, breaking the documented "deny wins" / "allowlist is literal" contract. Each confirmation tool now goes through `evaluatePolicy` individually. Tests added for: allowlist excludes confirm tools, denylist hides them (deny wins), `read_only` mode hides write meta tools but keeps the read-class `meta_list_pending_actions`.
- **DX warning at startup**: if confirmation is enabled but `meta_confirm_action` is hidden by policy, the server logs a warning that pending actions will be unconfirmable, with the fix recipe (add to allowlist or set `AVITO_MCP_CONFIRMATION_MODE=off`).
- **`dist/manifest.json` now includes `environment` and `accessesLocalFiles`** on every tool entry. Previously these were only in runtime `_meta` but the manifest had only `risk`. Now `messenger_upload_images` shows `environment: "prod", accessesLocalFiles: true`; `meta_*` tools show `environment: "local"`. CHANGELOG claim ↔ artifact now match.
- **CHANGELOG v0.4.0 typo**: "24 new tests (74 → 98 total)" → "24 new tests (50 → 74 total)".
- **README counts**: replaced the imprecise "139 tools" with an honest breakdown — "138 Avito API tools + 4 local/meta = up to 142 MCP tools" — plus a configuration→count table.
- **`docs/` added to npm `files` whitelist** so the README link to `docs/safety.md` resolves inside the published package, not just on GitHub.

### Added

- **`AVITO_MCP_MAX_BINARY_MB`** (default `20`) — caps the size of binary responses (PDF labels, audio recordings). Fails fast on `Content-Length` header if available; falls back to checking actual body size. Drains the response to avoid lingering sockets. Audit-recommended production hardening for `orders_download_label` and `calltracking_get_record_by_call_id`.
- 7 new tests (95 total, +7 from v0.5.0): 4 for meta-tool policy gating, 3 for binary size limit (Content-Length reject, body-size reject, accepts under-limit).

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
- **24 new tests** (50 → 74 total): 10 for confirmation flow (pending creation, one-shot confirm, double-confirm rejected, cancel, expiry, list, mode toggles, policy re-evaluation), 14 for upload guard (every reason path: outside dirs, symlink escape, extension mismatch, magic-byte mismatch, size limit, directory disguised as file, naive prefix attack, empty allowlist, path traversal).
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
  - `read_only` — registers only `risk='read'` tools (~79 tools). Agent literally cannot see anything else in `tools/list`.
  - `guarded` — registers `read` + `write` (~120 tools); hides `money` and `public`. Agent can edit own data but can't spend or talk to customers.
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

[0.9.0]: https://github.com/elchin92/avito-mcp/releases/tag/v0.9.0
[0.5.1]: https://github.com/elchin92/avito-mcp/releases/tag/v0.5.1
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
