import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROTOCOL_ERA } from '../src/config.js';
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/version.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/**
 * Paths that must never reach the published tarball: the 2026-07-28 protocol
 * corpus (8.4 MB of research material) and the migration notes. They are
 * untracked by design, so the only thing standing between them and every npm
 * consumer is the `files` allowlist — this gate proves the allowlist holds.
 */
const RESEARCH_DIR = 'docs/mcp-2026-07-28';
const RESEARCH_ONLY_ROOT_FILES = ['MIGRATION_PLAN.md', 'MIGRATION_PROGRESS.md'];
/** Everything under docs/ that is allowed to ship (docs/safety.md backs avito://docs/safety). */
const PACKABLE_DOCS = new Set(['docs/safety.md']);
/** The one file the secret scan is allowed to hold schema digests in. */
const LEGACY_WIRE_BASELINE = 'test/baselines/legacy-1.3.3-wire.json';

/** Paths npm would put in the tarball, resolved without building or touching the network. */
function packedFilePaths(cwd: string): string[] {
  const stdout = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const json = stdout.slice(stdout.indexOf('['));
  const packed = JSON.parse(json) as Array<{ files: Array<{ path: string }> } | undefined>;
  const tarball = packed[0];
  if (!tarball) throw new Error('npm pack --json reported no tarball');
  return tarball.files.map((file) => file.path);
}

/**
 * Packs this package.json against a planted research corpus, so the gate keeps
 * proving something on a clean checkout — CI never has the corpus on disk.
 * The decoys go into a scratch tree rather than the repository: writing them
 * next to a running suite would churn inodes the lease tests depend on.
 */
function packedFilePathsAgainstDecoys(): string[] {
  const temp = mkdtempSync(resolve(tmpdir(), 'avito-pack-gate-'));
  try {
    writeFileSync(resolve(temp, 'package.json'), read('package.json'));
    const decoys = [
      'docs/safety.md',
      `${RESEARCH_DIR}/00-INDEX.md`,
      `${RESEARCH_DIR}/spec-core.md`,
      ...RESEARCH_ONLY_ROOT_FILES,
    ];
    for (const decoy of decoys) {
      const path = resolve(temp, decoy);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '# pack gate decoy\n');
    }
    return packedFilePaths(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function extractRunBlock(workflow: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const stepStart = workflow.indexOf(marker);
  if (stepStart < 0) throw new Error(`workflow step not found: ${stepName}`);
  const nextStep = workflow.indexOf('\n      - ', stepStart + marker.length);
  const step = workflow.slice(stepStart, nextStep < 0 ? undefined : nextStep);
  const runMarker = '        run: |\n';
  const runStart = step.indexOf(runMarker);
  if (runStart < 0) throw new Error(`run block not found: ${stepName}`);
  return step
    .slice(runStart + runMarker.length)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function runReleaseRefCheck(
  cwd: string,
  script: string,
  sha: string,
  tag: string,
  ref = 'refs/heads/main',
) {
  return spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF: ref,
      GITHUB_SHA: sha,
      RELEASE_TAG: tag,
    },
  });
}

describe('release and deployment hardening', () => {
  it('uses supported Node lines and a non-root container', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('FROM node:24-alpine');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('avito-mcp-healthcheck');
    const healthcheck = read('deploy/container-healthcheck.sh');
    expect(healthcheck).toContain('/readyz');
    expect(healthcheck).toContain('AVITO_MCP_HTTP_HOST');
    expect(healthcheck).toContain('probe_host="[$probe_host]"');
    expect(dockerfile).toContain('chmod -R a-w /app/node_modules');
    expect(dockerfile).not.toContain('COPY --chown=node:node');
    expect(dockerfile).toContain('-p 127.0.0.1:3000:3000');
    expect(dockerfile).not.toMatch(/^\s*#\s*-p 3000:3000/m);

    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe('>=22.12.0');
  });

  it('runs both systemd services as dedicated users with sandboxing', () => {
    const app = read('deploy/avito-mcp.service');
    expect(app).toContain('User=avito-mcp');
    expect(app).toContain('UMask=0077');
    expect(app).toContain('NoNewPrivileges=true');
    expect(app).toContain('ProtectSystem=strict');
    expect(app).toContain('WorkingDirectory=/opt/avito-mcp/current');
    expect(app).toContain('EnvironmentFile=/etc/avito-mcp/avito-mcp.env');
    expect(app).not.toContain('User=root');

    const caddy = read('deploy/caddy.service');
    expect(caddy).toContain('User=caddy');
    expect(caddy).toContain('CapabilityBoundingSet=CAP_NET_BIND_SERVICE');
    expect(caddy).toContain('NoNewPrivileges=true');
    expect(caddy).not.toContain('User=root');
  });

  it('installs immutable versioned releases and rolls back failed deployments', () => {
    const installer = read('deploy/install-services.sh');
    expect(installer).toContain('RELEASES_DIR=$INSTALL_ROOT/releases');
    expect(installer).toContain('BASH_SOURCE[0]');
    expect(installer).toContain('flock -n 9');
    expect(installer).toContain("trap 'on_signal 143' TERM");
    expect(installer).toContain('mv -Tf "$next_link" "$CURRENT_LINK"');
    expect(installer).toContain('npm ci --prefix "$STAGING_DIR" --omit=dev');
    expect(installer).toContain('chmod -R a+rX,a-w "$STAGING_DIR"');
    expect(installer).not.toContain('chmod -R a-w "$STAGING_DIR"');
    expect(installer).toContain('migrate_private_state avito-mcp "$STATE_DIR"');
    expect(installer).toContain('/proc/self/mountinfo');
    expect(installer).toContain('Unable to validate application state mounts');
    expect(installer).toContain("stat -c '%d:%f:%h:%u:%g'");
    expect(installer).toContain('validate_private_state "$user" "$state_dir" 0');
    expect(installer).toContain('content is never rolled back or replaced');
    expect(installer).toContain('systemctl stop avito-mcp.service');
    expect(installer).toContain('rollback_release');
    expect(installer).not.toContain('app_was_active -eq 1 &&');
    expect(installer).not.toContain('caddy_was_active -eq 1 &&');
    expect(installer).toContain('render-service-env.mjs');
    expect(installer).toContain('--connect-timeout 1 --max-time 2');
    expect(installer).not.toContain('EnvironmentFile=/srv/avito_mcp/.env');
    expect(installer).toContain('/readyz');
    expect(installer).toContain('systemctl restart avito-mcp.service');
  });

  it('runs CI on every pull request, including a stacked one', () => {
    // M6.4/M6.6. `pull_request: branches: [main]` matches no stacked PR (a
    // feature branch targeting another feature branch), so an entire migration
    // chain can be reviewed and merged with zero checks having run. The absence
    // of the filter is the assertion; without this test it would be restored by
    // the next person tidying the workflow.
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/^ {2}pull_request:\s*$/m);
    expect(ci).not.toMatch(/pull_request:\s*\n\s*branches:/);
    // The push trigger stays pinned to main: a branch push and its PR would
    // otherwise run the whole matrix twice.
    expect(ci).toMatch(/push:\s*\n\s*branches: \[main\]/);
  });

  it('keeps dependency and secret scans blocking and actions SHA-pinned', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toContain('continue-on-error');
    expect(ci).toContain('node-version: [22.x, 24.x]');
    expect(ci).toContain('npm run typecheck:tests');
    expect(ci).toContain('npm run test:coverage');
    expect(ci).toContain('npm pack --json');
    expect(ci).not.toContain('npm pack --silent');
    expect(ci).toContain('deploy-gate:');
    expect(ci).toContain('bash deploy/install-services.sh --start');
    expect(ci).toContain('invalid redeploy unexpectedly succeeded');
    expect(ci).toContain('state symlink unexpectedly migrated');
    expect(ci).toContain('state hardlink unexpectedly migrated');
    expect(ci).toContain('unreachable readiness probe unexpectedly succeeded');
    expect(ci).toContain('AVITO_MCP_OAUTH_STORE_FILE=/var/lib/avito-mcp/oauth-state.json');
    expect(ci).toContain('AVITO_MCP_WEBHOOK_LOG_FILE=/var/lib/avito-mcp/webhook-events.jsonl');
    expect(ci).toContain('systemctl restart avito-mcp.service');
    expect(ci).toContain('sudo -u avito-mcp test -x /opt/avito-mcp/current');
    expect(ci).toContain('PROJECT_AUDIT\\.md');
    expect(ci).toContain('\\.remote\\.env[^/]*');
    expect(ci).toContain('\\.mcp\\.json[^/]*');
    expect(ci).toContain('sudo install -m 0755 /bin/true /usr/local/bin/caddy');
    expect(ci).toContain('npm audit --audit-level=high');
    expect(ci).toContain('npm audit --omit=dev --audit-level=high');
    expect(ci).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(ci).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(ci).toMatch(/gitleaks\/gitleaks-action@[0-9a-f]{40}/);

    expect(existsSync(resolve(root, '.github/workflows/release.yml'))).toBe(false);
    const release = read('.github/workflows/publish.yml');
    expect(release).toContain('workflow_dispatch:');
    expect(release).not.toMatch(/^\s+push:/m);
    expect(release).toContain('id-token: write');
    expect(release.match(/id-token: write/g)).toHaveLength(1);
    expect(release.indexOf('id-token: write')).toBeGreaterThan(release.indexOf('\n  publish:'));
    expect(release).toContain('actions: read');
    expect(release).toContain('environment: npm-publish');
    expect(release).toContain('group: npm-publish');
    expect(release).toContain('fetch-depth: 0');
    expect(release).toContain(
      "git fetch --force --no-tags origin '+refs/heads/main:refs/remotes/origin/main'",
    );
    expect(release).toContain(
      'DISPATCH_COMMIT="$(git rev-parse --verify "${GITHUB_SHA}^{commit}")"',
    );
    expect(release).toContain(
      'MAIN_COMMIT="$(git rev-parse --verify \'refs/remotes/origin/main^{commit}\')"',
    );
    expect(release).toContain(
      'RELEASE_COMMIT="$(git rev-parse --verify "refs/tags/${RELEASE_TAG}^{commit}")"',
    );
    expect(release.match(/git fetch --force --no-tags origin/g)).toHaveLength(4);
    expect(release).not.toContain('merge-base --is-ancestor');
    const firstRefCheck = release.indexOf('- name: Verify release tag is current main');
    const secondRefCheck = release.indexOf(
      '- name: Recheck release tag is current main and publish',
    );
    expect(firstRefCheck).toBeGreaterThan(release.indexOf('actions/checkout@'));
    expect(firstRefCheck).toBeLessThan(release.indexOf('actions/setup-node@'));
    expect(secondRefCheck).toBeGreaterThan(release.indexOf('actions/download-artifact@'));
    expect(secondRefCheck).toBeLessThan(release.indexOf('npm publish "${packages[0]}"'));
    expect(release).toContain('npm@11.15.0');
    expect(release).toContain('npm audit --audit-level=high');
    expect(release).toContain('actions/workflows/ci.yml/runs');
    expect(release).toContain('-f branch=main');
    expect(release).toContain('run.head_branch === "main"');
    expect(release).toContain('run.head_sha === sha');
    expect(release).toContain('run.event === "push"');
    expect(release).toContain('run.conclusion === "success"');
    expect(release).toContain('npm pack --json');
    expect(release).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(release).toMatch(/actions\/download-artifact@[0-9a-f]{40}/);
    expect(release).toContain(
      'npm publish "${packages[0]}" --access public --ignore-scripts --provenance',
    );
    expect(release).toContain('packages=(./release-artifact/*.tgz)');
    expect(release).toContain('overwrite: true');
    expect(read('package.json')).toContain('check:release-version');
    expect(read('scripts/check-release-version.mjs')).toContain('server.json.packages[0].version');
    expect(release).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(release).toMatch(/actions\/setup-node@[0-9a-f]{40}/);

    const dockerignore = read('.dockerignore');
    expect(dockerignore).toContain('.env*');
    expect(dockerignore).toContain('!.env.example');
    expect(dockerignore).toContain('.remote.env*');
    expect(dockerignore).toContain('.mcp.json*');
    expect(dockerignore).toContain('*.pem');
  });

  /**
   * The secret scan has exactly one exemption, and it exists because the 1.3.3
   * wire baseline stores a truncated sha256 of every tool definition — values
   * the generic-api-key rule reads as credentials whenever the tool name
   * contains "auth" or "api". An exemption is only tolerable while it stays too
   * narrow to hide anything else, so this gate re-runs the two regexes the
   * config actually ships against credentials a future commit might drop into
   * the same file or the same directory.
   */
  it('keeps the gitleaks exemption too narrow to hide a real secret', () => {
    const config = read('.gitleaks.toml');

    // The upstream ruleset stays in force: this file only adds an exemption.
    expect(config).toMatch(/\[extend\]\nuseDefault = true/);
    expect(config).not.toContain('disabledRules');
    // Scoped to the one rule that misfires, not to every rule in the scanner.
    expect(config).not.toMatch(/^\[allowlist\]/m);
    expect(config).not.toMatch(/^\[\[allowlists\]\]/m);
    expect(config).toMatch(/\[\[rules\]\]\nid = "generic-api-key"/);
    // Path and value shape must BOTH hold; either alone would exempt too much.
    expect(config).toContain('condition = "AND"');
    expect(config).toContain('regexTarget = "match"');

    const literals = (key: string): string[] =>
      [...config.matchAll(new RegExp(`${key} = \\['''(.+?)'''\\]`, 'g'))].map((m) => m[1]!);

    const paths = literals('paths');
    expect(paths).toHaveLength(1);
    const allowedPath = new RegExp(paths[0]!);
    expect(allowedPath.test(LEGACY_WIRE_BASELINE)).toBe(true);
    // Not the directory, not a sibling, not a lookalike of the baseline itself.
    expect(allowedPath.test('test/baselines/')).toBe(false);
    expect(allowedPath.test('test/baselines/credentials.json')).toBe(false);
    expect(allowedPath.test('test/baselines/legacy-1.3.3-wire.json.bak')).toBe(false);
    expect(allowedPath.test('src/config.ts')).toBe(false);

    const regexes = literals('regexes');
    expect(regexes).toHaveLength(1);
    const allowedMatch = new RegExp(regexes[0]!);

    // The positive cases are read out of the baseline instead of being written
    // here: a literal `<auth-named key>": "<32 hex>"` in this file would be a
    // finding in its own right, because this file is deliberately outside the
    // exemption. Only pinned entries whose names trigger generic-api-key need
    // coverage. Pinning the key/value pair ensures another 32-hex value cannot
    // borrow that exemption. gitleaks hands it the match without its opening
    // quote.
    const baseline = JSON.parse(read(LEGACY_WIRE_BASELINE)) as {
      steps: Record<string, { body?: { perTool?: Record<string, string> } }>;
    };
    const perTool = baseline.steps['04-tools-list']?.body?.perTool;
    expect(perTool).toBeDefined();
    const digests = Object.entries(perTool!);
    expect(digests.length).toBeGreaterThan(100);
    const falsePositives = digests.filter(([tool]) => /auth|api/.test(tool));
    for (const [tool, value] of falsePositives) {
      expect(allowedMatch.test(`${tool}": "${value}"`), `${tool} is not a 32-hex digest`).toBe(
        true,
      );
    }
    // The entries that actually trip the rule are the ones whose names carry a
    // generic-api-key keyword, so those must be among the covered ones.
    expect(falsePositives.length).toBeGreaterThan(0);
    for (const [tool, value] of digests.filter(([tool]) => !/auth|api/.test(tool))) {
      expect(allowedMatch.test(`${tool}": "${value}"`), `${tool} was unnecessarily exempted`).toBe(
        false,
      );
    }

    // Anything that is not exactly a 32-hex digest is still a finding. The
    // counter-examples are derived rather than pasted, for the same reason: a
    // realistic credential literal in a test fixture is itself a leak, and the
    // property under test is the shape, not any particular vendor.
    const sample = digests[0]![1];
    // An exact 32-lowercase-hex value is a common credential shape. Credential
    // keys must remain findings even when the value happens to equal a digest.
    expect(allowedMatch.test(`api_key": "${sample}"`)).toBe(false);
    expect(allowedMatch.test(`meta_auth_token": "${sample}"`)).toBe(false);
    expect(allowedMatch.test(`client_secret": "${sample}"`)).toBe(false);
    const notDigests = [
      `${sample}0123456789abcdef`, // longer than a digest
      sample.slice(1), // shorter than a digest
      sample.toUpperCase(), // not lowercase
      'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNkZWZnaGlqaw', // base64url, not hex
      `${sample} trailing`, // a digest plus a payload
    ];
    for (const value of notDigests) {
      expect(allowedMatch.test(`api_key": "${value}"`), `${value} was exempted`).toBe(false);
      expect(allowedMatch.test(`meta_auth_token": "${value}"`), `${value} was exempted`).toBe(
        false,
      );
    }
  });

  it.skipIf(process.platform === 'win32')(
    'executes the publish ref gate against current, stale, and annotated tags',
    () => {
      const workflow = read('.github/workflows/publish.yml');
      const firstCheck = extractRunBlock(workflow, 'Verify release tag is current main');
      const secondCheck = extractRunBlock(
        workflow,
        'Recheck release tag is current main and publish',
      );
      expect(secondCheck.startsWith(firstCheck)).toBe(true);

      const temp = mkdtempSync(resolve(tmpdir(), 'avito-release-ref-'));
      const remote = resolve(temp, 'remote.git');
      const work = resolve(temp, 'work');
      try {
        git(temp, ['init', '--bare', '--initial-branch=main', remote]);
        git(temp, ['init', '--initial-branch=main', work]);
        git(work, ['config', 'user.email', 'release-test@example.invalid']);
        git(work, ['config', 'user.name', 'Release Test']);
        writeFileSync(resolve(work, 'state.txt'), 'old\n');
        git(work, ['add', 'state.txt']);
        git(work, ['commit', '-m', 'old release candidate']);
        const staleSha = git(work, ['rev-parse', 'HEAD']);
        writeFileSync(resolve(work, 'state.txt'), 'current\n');
        git(work, ['commit', '-am', 'current release candidate']);
        const currentSha = git(work, ['rev-parse', 'HEAD']);
        git(work, ['tag', 'v1.1.9', staleSha]);
        git(work, ['tag', 'v1.2.0', currentSha]);
        git(work, ['tag', '-a', 'v1.2.0-annotated', currentSha, '-m', 'annotated release']);
        git(work, ['remote', 'add', 'origin', remote]);
        git(work, ['push', '--quiet', 'origin', 'main', 'v1.1.9', 'v1.2.0', 'v1.2.0-annotated']);

        expect(runReleaseRefCheck(work, firstCheck, currentSha, 'v1.2.0').status).toBe(0);
        expect(runReleaseRefCheck(work, firstCheck, currentSha, 'v1.2.0-annotated').status).toBe(0);

        const staleTag = runReleaseRefCheck(work, firstCheck, currentSha, 'v1.1.9');
        expect(staleTag.status).not.toBe(0);
        expect(staleTag.stderr).toContain('Dispatch, main and release tag must match');

        expect(runReleaseRefCheck(work, firstCheck, staleSha, 'v1.2.0').status).not.toBe(0);
        expect(
          runReleaseRefCheck(work, firstCheck, currentSha, 'v1.2.0', 'refs/heads/topic').status,
        ).not.toBe(0);

        writeFileSync(resolve(work, 'state.txt'), 'advanced main\n');
        git(work, ['commit', '-am', 'advance main after prepare']);
        git(work, ['push', '--quiet', 'origin', 'main']);
        expect(runReleaseRefCheck(work, firstCheck, currentSha, 'v1.2.0').status).not.toBe(0);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('keeps the research corpus and migration notes out of the published package', () => {
    const excluded = (paths: string[]): string[] =>
      paths.filter(
        (path) =>
          path === RESEARCH_DIR ||
          path.startsWith(`${RESEARCH_DIR}/`) ||
          RESEARCH_ONLY_ROOT_FILES.includes(path),
      );

    // What this checkout would actually publish right now.
    const packed = packedFilePaths(root);
    // The resource body must still ship — excluding the corpus must not empty docs/.
    expect(packed).toContain('docs/safety.md');
    expect(excluded(packed)).toEqual([]);

    // Any future docs/ subtree must be added to the allowlist deliberately,
    // rather than riding along on a directory-wide entry.
    const unexpectedDocs = packed.filter(
      (path) => path.startsWith('docs/') && !PACKABLE_DOCS.has(path),
    );
    expect(unexpectedDocs).toEqual([]);

    // Same packing contract, this time with the corpus present on disk: the gate
    // must fail on a widened allowlist even when CI checks out a corpus-free tree.
    const packedWithDecoys = packedFilePathsAgainstDecoys();
    expect(packedWithDecoys).toContain('docs/safety.md');
    expect(excluded(packedWithDecoys)).toEqual([]);

    // Second barrier: the allowlist itself must name files under docs/, never the directory.
    const pkg = JSON.parse(read('package.json')) as { files?: string[] };
    expect(pkg.files).toBeDefined();
    expect(pkg.files).toContain('docs/safety.md');
    expect(pkg.files?.filter((entry) => /^docs\/?$/.test(entry))).toEqual([]);

    // Third barrier: the same paths never enter the build context or the image.
    const dockerignore = read('.dockerignore');
    expect(dockerignore).toContain(RESEARCH_DIR);
    for (const file of RESEARCH_ONLY_ROOT_FILES) expect(dockerignore).toContain(file);
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('COPY docs/safety.md ./docs/safety.md');
    expect(dockerfile).not.toMatch(/^COPY docs \.\/docs$/m);

    // Fourth barrier: the paths stay untracked, so they can never reach git either.
    const gitignore = read('.gitignore');
    expect(gitignore).toContain(`${RESEARCH_DIR}/`);
    for (const file of RESEARCH_ONLY_ROOT_FILES) expect(gitignore).toContain(file);
  }, 120_000);

  it('keeps the service installer executable', () => {
    expect(statSync(resolve(root, 'deploy/install-services.sh')).mode & 0o111).not.toBe(0);
  });
});

// ───────── E / M7.4 — one statement of supported revisions, on every surface ──

/**
 * The public contract says which protocol revisions this server speaks. It says
 * it in seven places, and the only interesting failure is the one where the
 * places disagree — a registry entry claiming a revision the build cannot serve
 * is a checkably false claim, and it damages trust more than saying nothing.
 *
 * So the declaration is not asserted as a literal here. It is tied to
 * `SUPPORTED_PROTOCOL_VERSIONS`, the constant the runtime itself advertises
 * from, and to the `AVITO_MCP_PROTOCOL_ERA` default that decides which subset a
 * default deployment actually answers.
 */
describe('public contract — supported protocol revisions', () => {
  const REGISTRY_SCHEMA =
    'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
  const PUBLISHER_META = 'io.modelcontextprotocol.registry/publisher-provided';

  interface ServerJson {
    $schema?: string;
    name?: string;
    description?: string;
    packages?: Array<{
      identifier?: string;
      environmentVariables?: Array<{
        name?: string;
        default?: string;
        choices?: string[];
        isRequired?: boolean;
        description?: string;
      }>;
    }>;
    _meta?: Record<string, { protocolRevisions?: Record<string, unknown> }>;
  }

  const serverJson = (): ServerJson => JSON.parse(read('server.json')) as ServerJson;

  /** The `## [Unreleased]` section only — a released section is a different claim. */
  function unreleasedSection(): string {
    const changelog = read('CHANGELOG.md');
    const start = changelog.indexOf('## [Unreleased]');
    expect(start).toBeGreaterThanOrEqual(0);
    const next = changelog.indexOf('\n## [', start + 1);
    return next === -1 ? changelog.slice(start) : changelog.slice(start, next);
  }

  it('declares in server.json exactly the revisions the code advertises', () => {
    const server = serverJson();
    const declared = server._meta?.[PUBLISHER_META]?.protocolRevisions as
      | {
          served?: string[];
          servedByDefault?: string[];
          selectedBy?: {
            environmentVariable?: string;
            default?: string;
            values?: Record<string, string[]>;
          };
          documentation?: string;
        }
      | undefined;
    expect(
      declared,
      `server.json._meta["${PUBLISHER_META}"].protocolRevisions is missing`,
    ).toBeDefined();

    // The claim and the constant the server advertises from are the same list.
    expect(declared?.served).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(declared?.selectedBy?.environmentVariable).toBe('AVITO_MCP_PROTOCOL_ERA');
    expect(declared?.selectedBy?.values).toEqual({
      legacy: [LEGACY_PROTOCOL_VERSION],
      dual: [...SUPPORTED_PROTOCOL_VERSIONS],
      modern: [MODERN_PROTOCOL_VERSION],
    });
    // What a deployment that sets nothing actually answers. Getting this wrong
    // is the difference between "we support 2026-07-28" and "we will, if asked".
    const fallback = declared?.selectedBy?.default ?? '';
    expect(declared?.servedByDefault).toEqual(declared?.selectedBy?.values?.[fallback]);
    expect(fallback).toBe(DEFAULT_PROTOCOL_ERA);
    expect(declared?.documentation).toContain('#protocol-revisions');
  });

  it('describes the era selector as a launch option the registry schema understands', () => {
    const server = serverJson();
    const era = server.packages?.[0]?.environmentVariables?.find(
      (entry) => entry.name === 'AVITO_MCP_PROTOCOL_ERA',
    );
    expect(era, 'server.json does not declare AVITO_MCP_PROTOCOL_ERA').toBeDefined();
    expect(era?.isRequired).toBe(false);
    expect(era?.choices).toEqual(['legacy', 'dual', 'modern']);
    expect(era?.default).toBe(DEFAULT_PROTOCOL_ERA);
    for (const revision of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(era?.description).toContain(revision);
    }
  });

  it('stays on the registry schema that exists, and inside its length limit', () => {
    // WHAT THIS DOES AND DOES NOT CHECK, because the difference was overstated
    // once already: the changelog entry for this work said both additions were
    // "validated against the registry's published 2025-12-11 schema", and no
    // test validates anything against that schema. Fetching it at test time
    // would make the suite depend on a network; vendoring it would need a
    // JSON-Schema validator this package does not depend on, and the document
    // uses `not`, which the converter available here (`z.fromJSONSchema`)
    // cannot express. So the schema was read by hand when the fields were
    // written, and what is re-checked on every run is this: the pin, the one
    // limit the schema imposes on a field we fill, and — in the two assertions
    // above — that every revision claimed matches the code that serves it.
    const server = serverJson();
    // There is no revision-aligned successor to this schema: `/registry/*`
    // carries no protocol-revision marker and no changelog, and the registry
    // asks nothing of a 2026-07-28 server. Moving the pin to a date that looks
    // newer would point at a document that does not exist.
    expect(server.$schema).toBe(REGISTRY_SCHEMA);
    // `description` is capped at 100 characters by that schema, which is why
    // the revision statement lives in `_meta` and in the env-var entry instead.
    expect(server.description?.length).toBeLessThanOrEqual(100);
    // And the publisher block sits under the namespace the schema reserves for
    // it, spelled exactly: `_meta` keys are namespaced strings, and a typo here
    // is metadata no registry would ever read.
    expect(Object.keys(server._meta ?? {})).toContain(PUBLISHER_META);
  });

  it('says in the changelog what is checked against the registry schema, and what is not', () => {
    // The claim that was too strong, held to its correction. A future edit that
    // restores "validated against the schema" has to make it true first.
    const changelog = read('CHANGELOG.md');
    expect(changelog).not.toMatch(/validated against the registry's published/);
    expect(changelog).toContain('A full JSON-Schema validation is not run');
  });

  it('binds package.json and server.json to one identity', () => {
    const pkg = JSON.parse(read('package.json')) as { name?: string; mcpName?: string };
    const server = serverJson();
    expect(pkg.mcpName).toBe(server.name);
    expect(server.packages?.[0]?.identifier).toBe(pkg.name);
    // The release gate has to enforce it too: this test is not in the publish path.
    const gate = read('scripts/check-release-version.mjs');
    expect(gate).toContain('package.json.mcpName');
    expect(gate).toContain('server.json.packages[0].identifier');
  });

  it('names both revisions in the package.json description, and marks the default', () => {
    // The surface this statement was missing from, and the one with the widest
    // audience: `description` is what npm renders on the package page and in
    // `npm search`, so it is where somebody decides whether this server speaks
    // their revision before installing anything. It carried neither date.
    //
    // Why here and not in a new key. `mcpName` is in this file because the MCP
    // registry reads it; no consumer reads an invented `protocolRevisions`
    // field, and this branch already refused to add one to `glama.json` for
    // exactly that reason (see the test below). The registry-facing,
    // machine-readable form of this statement lives in `server.json._meta`,
    // where the schema has a place for it.
    //
    // `version` is untouched: it is the release number, and it is owned by the
    // release gate.
    const pkg = JSON.parse(read('package.json')) as { description?: string; version?: string };
    const description = pkg.description ?? '';
    for (const revision of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(description, `package.json description never names ${revision}`).toContain(revision);
    }
    expect(description).toContain('AVITO_MCP_PROTOCOL_ERA');
    // Which one a default install answers — the same claim `server.json` makes,
    // and the one that would be publicly false rather than merely incomplete.
    const byDefault =
      DEFAULT_PROTOCOL_ERA === 'modern' ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION;
    expect(description).toContain(`${byDefault} (default)`);
    // And it stays a statement about the protocol rather than about the
    // release: a package version in here would have to be updated on every
    // publish, from the one file whose version field the release gate owns.
    expect(
      description,
      'the description names the package version; that belongs to the release gate',
    ).not.toContain(String(pkg.version));
  });

  it('leaves glama.json at the one property its schema defines', () => {
    // https://glama.ai/mcp/schemas/server.json declares `maintainers` and
    // nothing else, so there is no field on that surface for a revision
    // statement. Glama reads the README for everything else; inventing a key
    // here would be metadata no consumer looks at. Recorded as a test so the
    // absence stays a decision instead of turning into an oversight.
    const glama = JSON.parse(read('glama.json')) as Record<string, unknown>;
    expect(Object.keys(glama).sort()).toEqual(['$schema', 'maintainers']);
    expect(glama.$schema).toBe('https://glama.ai/mcp/schemas/server.json');
  });

  it('states the compatibility promise the revisions come with', () => {
    // Naming the two revisions is half of what block E asks the changelog for.
    // The other half is the promise attached to them, and it is the half a
    // reader acts on: whether the upgrade changes anything for the client they
    // already run, and how to undo it if it does. Three parts, each checked
    // against the code rather than against a remembered sentence.
    const unreleased = unreleasedSection();
    const byDefault =
      DEFAULT_PROTOCOL_ERA === 'modern' ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION;
    // 1. Which revision an installation that sets nothing keeps answering.
    expect(unreleased).toContain(DEFAULT_PROTOCOL_ERA);
    expect(unreleased, `the changelog never says a default install answers ${byDefault}`).toMatch(
      new RegExp(`${byDefault}[^.]*\\bonly\\b|\\bdefault\\b[^.]*${byDefault}`),
    );
    // 2. That the new revision is opt-in, not something an upgrade turns on.
    expect(unreleased).toMatch(/[Nn]othing changes for an existing client until/);
    // 3. And that the way back is the same one variable.
    expect(unreleased).toMatch(/rollback|roll back/i);
  });

  it('says the same thing in the changelog and in both READMEs', () => {
    const unreleased = unreleasedSection();
    // Not pinned to a version section: the release that carries this is the
    // owner's to cut, and a numbered heading here would date a claim twice.
    expect(unreleased).not.toMatch(/^## \[\d/m);
    for (const revision of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(unreleased, `CHANGELOG [Unreleased] never names ${revision}`).toContain(revision);
    }
    expect(unreleased).toContain('AVITO_MCP_PROTOCOL_ERA');

    // Both locales carry the section, at the same line, in the same order —
    // server.json points a registry consumer at the English anchor, and a
    // Russian reader who follows the same link must land on the same table.
    const headings: Record<string, string> = {
      'README.md': '### Protocol revisions',
      'README.ru.md': '### Ревизии протокола',
    };
    const lineOf: number[] = [];
    for (const [locale, heading] of Object.entries(headings)) {
      const lines = read(locale).split('\n');
      const at = lines.indexOf(heading);
      expect(at, `${locale} has no "${heading}" section`).toBeGreaterThanOrEqual(0);
      lineOf.push(at);
      const body = lines.slice(at, at + 40).join('\n');
      for (const revision of SUPPORTED_PROTOCOL_VERSIONS) {
        expect(body, `${locale} names ${revision} outside its era section`).toContain(revision);
      }
      expect(body).toContain('AVITO_MCP_PROTOCOL_ERA');
    }
    expect(new Set(lineOf).size, 'the era section sits on different lines per locale').toBe(1);
    expect(read('README.md').split('\n').length).toBe(read('README.ru.md').split('\n').length);
  });
});
