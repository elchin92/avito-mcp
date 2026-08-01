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
 * Two guards keep the snapshot from quietly becoming a picture of the branch:
 *
 *   1. The entrypoint must be OUTSIDE this checkout. Pointing the capture at
 *      `src/server.ts` or at this repository's own `dist/` would make the whole
 *      bench self-referential — the exact defect it exists to fix — so it is
 *      refused here rather than caught in review.
 *   2. The booted process must report `1.3.3` on `/healthz`. A different
 *      version is a different contract and needs a deliberate decision, not a
 *      silent re-baseline.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  BASELINE_PATH,
  BASELINE_RELATIVE_PATH,
  REFERENCE_VERSION,
  REPO_ROOT,
  benchRunId,
  bootServer,
  captureWire,
  serialiseBaseline,
  type Baseline,
} from '../test/support/legacy-wire-bench.js';

const DEFAULT_ENTRY = '/srv/avito_mcp/dist/server.js';

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
