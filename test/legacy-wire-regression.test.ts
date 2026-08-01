/**
 * The regression bench: this branch's LEGACY leg against the published 1.3.3
 * wire.
 *
 * Every other 2025-era suite here compares the branch with itself —
 * `test/http-dual-era.test.ts` runs `era=dual` against `era=legacy`,
 * `test/protocol-era.test.ts` walks the era matrix, `test/wire-conformance.test.ts`
 * pins `schema_hash` (tool input schemas, and nothing else). A change that moves
 * both sides of a self-comparison the same way is invisible to all of them, and
 * `schema_hash` cannot see the shape of an error at all. This file is the one
 * that looks outward.
 *
 * The branch side is a REAL child process: `tsx src/server.ts` with
 * `AVITO_MCP_PROTOCOL_ERA=legacy`, booted with byte-identical environment to the
 * one the reference was captured under, driven over loopback HTTP with raw
 * JSON-RPC. Not the in-process rig, and not an SDK `Client`: an SDK client
 * normalises exactly the things under test here (it turns a JSON-RPC error into
 * a thrown `McpError` and a `result` with `isError` into a returned value, so
 * the single most important distinction in this file would be erased before any
 * assertion could see it).
 *
 * The reference side is `test/baselines/legacy-1.3.3-wire.json`, captured from
 * a genuine 1.3.3 build by `npm run capture:legacy-baseline`. See the header of
 * `test/support/legacy-wire-bench.ts` for why it is a committed snapshot and
 * what that costs.
 *
 * ONE ASSERTION PER STEP, ON PURPOSE. A single deep-equal over the whole
 * capture would report "the wire changed" and stop; a red list of named steps
 * says which exchanges moved and leaves the rest standing as evidence that the
 * transport, the handshake and the happy paths did not.
 *
 * TWO steps are allowed to differ from 1.3.3, and neither is waved through: a
 * `KnownAddition` names a single field and the value it must hold, a
 * `DeclaredDivergence` names both sides' values at every path it checks. Both
 * fail when they stop being true — an exception that outlives its argument is
 * indistinguishable from a regression nobody noticed, which is the failure mode
 * this whole file exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSandbox, removeSandbox } from './support/sandbox.js';
import {
  BASELINE_PATH,
  BASELINE_RELATIVE_PATH,
  LEGACY_WIRE_STEPS,
  REFERENCE_VERSION,
  REPO_ROOT,
  applyKnownAdditions,
  bootServer,
  canonical,
  captureWire,
  readPath,
  type Baseline,
  type BootedServer,
  type WireCapture,
} from './support/legacy-wire-bench.js';

/**
 * Booting a tsx child with 148 tools registered is seconds, not milliseconds,
 * and CI runners are slower than a laptop. The budget is generous because a
 * flaky timeout here would be read as "the wire moved", which is the one
 * conclusion this file must never produce by accident.
 */
const BOOT_BUDGET_MS = 180_000;

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;

let server: BootedServer | undefined;
let sandbox: string | undefined;
let actual: WireCapture = {};
let bootFailure: unknown;

beforeAll(async () => {
  sandbox = await createSandbox('legacy-wire-bench');
  try {
    server = await bootServer({
      command: join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      args: [join(REPO_ROOT, 'src', 'server.ts')],
      cwd: REPO_ROOT,
      sandbox,
      // The whole point: the leg under test is the one a 1.3.x operator gets by
      // default. `legacy` is also the default of the variable, set explicitly so
      // the test still means what it says if that default ever changes.
      env: { AVITO_MCP_PROTOCOL_ERA: 'legacy' },
    });
    actual = await captureWire(server);
  } catch (err) {
    bootFailure = err;
  }
}, BOOT_BUDGET_MS);

afterAll(async () => {
  await server?.stop();
  if (sandbox) await removeSandbox(sandbox);
});

describe('legacy wire vs the published 1.3.3 build', () => {
  it('the baseline was captured from a real 1.3.3, not from this checkout', () => {
    expect(bootFailure).toBeUndefined();
    expect(baseline.$provenance.reference.health.name).toBe('avito-mcp');
    expect(baseline.$provenance.reference.health.version).toBe(REFERENCE_VERSION);
    // A path inside this checkout would mean the snapshot is a picture of the
    // branch and the comparison below proves nothing.
    expect(baseline.$provenance.reference.entrypoint.startsWith(REPO_ROOT)).toBe(false);
  });

  it('the branch answered every step in the plan', () => {
    expect(bootFailure).toBeUndefined();
    const planned = LEGACY_WIRE_STEPS.map((step) => step.id);
    expect(Object.keys(actual)).toEqual(planned);
    expect(Object.keys(baseline.steps).sort()).toEqual([...planned].sort());
  });

  for (const step of LEGACY_WIRE_STEPS) {
    it(`${step.id}: ${step.note}`, () => {
      expect(bootFailure).toBeUndefined();
      const expected = baseline.steps[step.id];
      expect(
        expected,
        `no reference answer for ${step.id}; regenerate ${BASELINE_RELATIVE_PATH} ` +
          'with `npm run capture:legacy-baseline`',
      ).toBeDefined();

      const divergence = step.divergence;
      if (divergence !== undefined) {
        // A declared divergence replaces the comparison, so it has to carry its
        // own weight: both sides are pinned at every declared path, and the two
        // must still differ. A declaration that has become true of 1.3.3 as
        // well is stale, and stale is how an exception outlives its argument.
        for (const fact of divergence.facts) {
          const where = fact.path.join('.');
          expect(readPath(expected, fact.path), `1.3.3 at ${where}: ${divergence.why}`).toEqual(
            fact.reference,
          );
          expect(
            readPath(actual[step.id], fact.path),
            `this branch at ${where}: ${divergence.why}`,
          ).toEqual(fact.branch);
          expect(
            fact.branch,
            `${where} is declared a DIVERGENCE but both sides hold the same value; ` +
              'delete the declaration',
          ).not.toEqual(fact.reference);
        }
        return;
      }

      // A declared addition is only an allowance while it is still true of both
      // sides. Checking it here — rather than only letting the reconciliation
      // paper over the diff — means a stale entry fails instead of hiding.
      for (const addition of step.knownAdditions ?? []) {
        const where = addition.path.join('.');
        expect(
          readPath(expected, addition.path),
          `${where} is declared as an ADDITION, but 1.3.3 already answers it — ` +
            `delete the entry in LEGACY_WIRE_STEPS. Reason on record: ${addition.why}`,
        ).toBeUndefined();
        expect(
          readPath(actual[step.id], addition.path),
          `${where} is declared as an addition this branch makes, and it is not ` +
            `there. Reason on record: ${addition.why}`,
        ).toEqual(addition.value);
      }

      expect(canonical(actual[step.id])).toEqual(
        canonical(applyKnownAdditions(expected, step.knownAdditions)),
      );
    });
  }
});
