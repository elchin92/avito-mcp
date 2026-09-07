# Release and deployment runbook

[Contributing](../CONTRIBUTING.md) · [Operations](operations.md) · [Migration](../MIGRATION.md)

For maintainers. The executable sources of this procedure are [Publish](../.github/workflows/publish.yml), the [version check](../scripts/check-release-version.mjs), and the [service installer](../deploy/install-services.sh).

## Prepare a release

1. Choose the version using the documented SemVer policy. Update `package.json`, both root version fields in `package-lock.json`, and `server.json` including its npm package version. Update the changelog and both README release markers. Preserve the npm/registry identity mapping: `package.json.mcpName` equals `server.json.name`, and the registry package identifier equals the npm name.
2. Run `npm ci`, then `npm run verify:release`. This builds and regenerates the manifest before checking version consistency. Run both `npm audit --audit-level=high` and `npm audit --omit=dev --audit-level=high`. Review the actual package contents and try `npm run demo` without Avito credentials.
3. Merge the reviewed release commit into `main` and wait for successful **push CI on that exact commit**. Create and push the matching `v<version>` tag on that commit. Treat the release tag as immutable; corrections need a new release version, not a moved tag.

## Publish npm and the MCP Registry

In GitHub Actions, select **Publish → Run workflow**, choose branch **main**, and enter the existing tag in **tag**. For example, the input for package version `2.1.0` is `v2.1.0`.

The workflow requires the dispatch commit, current remote `main`, and release tag to match. It rechecks that relationship before publishing; changes to `main` during the run can stop the release. It also checks the tag/version relationship and successful CI for the dispatched commit.

The `prepare` job reruns release checks and audits, creates one npm tarball, and uploads it with a SHA-256 checksum. The `publish` job uses the existing **`npm-publish` environment**: complete any configured environment approval or protection checks when GitHub requests them. It verifies the downloaded artifact and publishes that tarball with npm trusted publishing/OIDC and provenance. It does not rebuild the package at the publishing step.

The separate **`registry` job has `needs: publish`**. It rechecks the release commit, downloads **MCP Publisher v1.8.1**, verifies the pinned checksum, authenticates with GitHub OIDC, and publishes `server.json` to the public MCP Registry. A green npm job does not imply that registry publication succeeded.

If registry publication fails transiently, rerun the failed registry job rather than the successful npm job: an already published npm version cannot be published again. The release-commit checks still apply on retry. If `main` has moved, stop and resolve the release state without moving the published tag or bypassing the checks. After any ambiguous publication error, read back the npm/registry version before another attempt.

Record both published versions and the successful workflow run in the release notes. A workflow dispatch or an approved environment gate alone is not evidence of publication.

## Deploy the released version

On a Linux/systemd host, use a reviewed checkout of the intended release. The installer requires `.env`, `.remote.env`, `package.json`, `package-lock.json`, and built `dist/server.js` to exist. Keep credentials in those local environment files; `.remote.env` overrides `.env`. See [HTTP configuration](operations.md#remote-mcp-over-http-oauth-21) for HTTPS and OAuth settings.

```bash
npm ci
npm run verify:release
sudo deploy/install-services.sh --start
```

The installer takes an exclusive deployment lock, stages an immutable release under `/opt/avito-mcp/releases/<version>`, installs production dependencies, and renders only allowed settings into `/etc/avito-mcp/avito-mcp.env`. The application runs as the restricted `avito-mcp` service account, with writable state under `/var/lib/avito-mcp`.

It validates configuration and units before atomically switching `/opt/avito-mcp/current`. `--start` enables and starts the service. Without that flag, an already-running service is still restarted; an inactive service remains inactive. An existing release directory is reused: changing source under the same version does not replace its installed code.

When starting or restarting, the installer polls `/readyz`, then checks that `/healthz` reports the intended version. Readiness covers local listener, configuration and state access; it does not prove Avito API permissions or successful business calls. Follow deployment with the read-only [canary checks](adr/0002-canary-protocol.md).

## Recover a failed deployment

During the deployment transaction, errors or handled termination signals trigger restoration of the prior release link, environment, units and previous service state, including managed Caddy settings. Inspect the installer output and service status: recovery can itself encounter an operating-system failure. A deployment rollback does not undo actions already applied to the Avito account.

For a later rollback, review migration and runtime-state compatibility, then redeploy a known-good checkout with its intended configuration through the same installer. Preserve the runtime state and idempotency records; rebuilding or renaming an installed release is not a rollback procedure.
