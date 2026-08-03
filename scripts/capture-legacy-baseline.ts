/**
 * Regenerates `test/baselines/legacy-1.3.3-wire.json` from a REAL 1.3.3 build.
 *
 *   npm run capture:legacy-baseline
 *   AVITO_MCP_REFERENCE_ENTRY=/path/to/1.3.3/dist/server.js npm run capture:legacy-baseline
 *
 * The bench in `test/legacy-wire-regression.test.ts` compares this branch's
 * legacy leg with the published 1.3.3 wire. CI has no 1.3.3 checkout, so the
 * reference side is captured here, once, and committed. See the header of
 * `test/support/legacy-wire-bench.ts` for what that buys and what it costs.
 *
 * Four guards keep the snapshot from quietly becoming a picture of the branch:
 *
 *   1. The entrypoint must be OUTSIDE this checkout. Pointing the capture at
 *      `src/server.ts` or at this repository's own `dist/` would make the whole
 *      bench self-referential — the exact defect it exists to fix — so it is
 *      refused here rather than caught in review.
 *   2. The booted process must report `1.3.3` on `/healthz`.
 *   3. …which is NOT enough on its own, because this branch reports 1.3.3 too:
 *      the migration started from that version and has not released one. So the
 *      reference CHECKOUT is inspected as well — a tree that depends on the v2
 *      packages (M2) or carries the era switch (M3) is a build of the migration
 *      wearing the old version number, and is refused. Guard 1 does not exclude
 *      it: a second worktree of this repository is outside this checkout.
 *   4. The captured ANSWERS must be 1.3.3's. `foreignReferenceViolations`
 *      replays every difference this branch has declared against the fresh
 *      capture, and the branch's own value showing up in it aborts the write
 *      before the file is touched. This one needs nothing to be true about
 *      paths, versions or metadata, and it is the same function the suite runs
 *      on the committed file.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  BASELINE_PATH,
  BASELINE_RELATIVE_PATH,
  REFERENCE_VERSION,
  REPO_ROOT,
  benchRunId,
  bootServer,
  captureWire,
  foreignReferenceViolations,
  serialiseBaseline,
  type Baseline,
} from '../test/support/legacy-wire-bench.js';

const DEFAULT_ENTRY = '/srv/avito_mcp/dist/server.js';

/**
 * Refuses a reference checkout that is a build of the migration.
 *
 * The version number cannot tell them apart: this branch's `package.json` also
 * says 1.3.3, so `/healthz` says 1.3.3 from either side. Two facts about the
 * TREE can, and neither of them is a version:
 *
 *   • the 1.x line runs on `@modelcontextprotocol/sdk` (v1). M2 replaces it
 *     with the v2 packages, and no build after that point has it;
 *   • M3 adds `AVITO_MCP_PROTOCOL_ERA`, which appears nowhere before it.
 *
 * A reference with no readable `package.json` is refused too: an entrypoint
 * whose checkout cannot be identified is exactly what this is here to stop.
 */
function assertPreMigrationTree(referenceRoot: string, entry: string): void {
  const manifestPath = join(referenceRoot, 'package.json');
  let manifest: { version?: string; dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    throw new Error(
      `Refusing to capture from ${entry}: ${manifestPath} is missing or unreadable, so ` +
        'there is no way to tell a 1.3.3 checkout from a build of this migration.',
    );
  }

  const dependencies = Object.keys(manifest.dependencies ?? {});
  const v2 = dependencies.filter((name) =>
    /^@modelcontextprotocol\/(server|node|express)/.test(name),
  );
  if (v2.length > 0 || !dependencies.includes('@modelcontextprotocol/sdk')) {
    throw new Error(
      `Refusing to capture from ${entry}: ${referenceRoot} depends on ${v2.join(', ') || 'no v1 SDK'}, ` +
        'so it is a build of the 2026-07-28 migration and not of the 1.x line — whatever its ' +
        `version says (${String(manifest.version)}). A second worktree of this repository is ` +
        'OUTSIDE this checkout and still is not a reference.',
    );
  }

  const era = findEraSwitch(join(referenceRoot, 'src'));
  if (era !== null) {
    throw new Error(
      `Refusing to capture from ${entry}: ${era} carries the era switch, so ${referenceRoot} ` +
        'is a dual-era build and not a 1.3.3 one.',
    );
  }
}

/** The first source file under `directory` that names the era switch. */
function findEraSwitch(directory: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findEraSwitch(path);
      if (found !== null) return found;
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
      if (readFileSync(path, 'utf8').includes('AVITO_MCP_PROTOCOL_ERA')) return path;
    }
  }
  return null;
}

function gitHeadOf(directory: string): string | null {
  try {
    return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const entry = resolve(process.env.AVITO_MCP_REFERENCE_ENTRY ?? DEFAULT_ENTRY);
  const outside = relative(REPO_ROOT, entry).startsWith('..');
  if (!outside) {
    throw new Error(
      `Refusing to capture a baseline from ${entry}: it is inside this checkout.\n` +
        'The reference must be a separate 1.3.3 build — capturing the branch against ' +
        'itself is precisely the blind spot this bench exists to close.\n' +
        'Point AVITO_MCP_REFERENCE_ENTRY at a 1.3.3 dist/server.js.',
    );
  }

  // The reference build resolves its package.json, manifest and swaggers
  // relative to its own checkout, so it must run from there.
  const referenceRoot = resolve(dirname(entry), '..');
  assertPreMigrationTree(referenceRoot, entry);

  const sandbox = join(REPO_ROOT, 'test', '.sandbox', `legacy-baseline-${benchRunId()}`);
  mkdirSync(sandbox, { recursive: true, mode: 0o700 });

  console.log(`booting the reference: node ${entry} (cwd ${referenceRoot})`);
  const server = await bootServer({
    command: process.execPath,
    args: [entry],
    cwd: referenceRoot,
    sandbox,
  });

  try {
    if (server.health.version !== REFERENCE_VERSION) {
      throw new Error(
        `${entry} reports version ${String(server.health.version)}, expected ` +
          `${REFERENCE_VERSION}. Capture aborted — the baseline names its reference.`,
      );
    }
    console.log(
      `reference is up on ${server.base} (${server.health.name} ${server.health.version})`,
    );

    const steps = await captureWire(server);
    const impostor = foreignReferenceViolations(steps);
    if (impostor.length > 0) {
      throw new Error(
        `Refusing to write ${BASELINE_RELATIVE_PATH}: the process at ${entry} did not answer ` +
          'like 1.3.3.\n' +
          `${impostor.map((line) => `  - ${line}`).join('\n')}\n` +
          'Either the reference is a build of this branch, or 1.3.3 itself now answers ' +
          'differently — and the second one is a decision to make in LEGACY_WIRE_STEPS, in ' +
          'daylight, not a file to overwrite.',
      );
    }

    const baseline: Baseline = {
      $provenance: {
        regenerateWith: 'npm run capture:legacy-baseline',
        capturedAt: new Date().toISOString(),
        capturedByNode: process.version,
        reference: {
          entrypoint: entry,
          health: server.health,
          gitHead: gitHeadOf(referenceRoot),
        },
        warning:
          'CAPTURED FROM A REAL 1.3.3 BUILD, NOT FROM THIS BRANCH. Regenerating this ' +
          'file changes what "compatible with 1.3.3" means. Do it only after ' +
          're-measuring an actual 1.3.3 process, and review the diff as a ' +
          'wire-compatibility decision.',
      },
      steps,
    };

    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, serialiseBaseline(baseline));
    console.log(`wrote ${BASELINE_RELATIVE_PATH} (${Object.keys(steps).length} steps)`);
  } finally {
    await server.stop();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
