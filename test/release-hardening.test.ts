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
