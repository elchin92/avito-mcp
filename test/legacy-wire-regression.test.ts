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
 * That it IS a 1.3.3 snapshot is the first thing asserted, and not by taking the
 * snapshot's word for it: this branch reports 1.3.3 on `/healthz` too, so the
 * three provenance assertions below check what the reference answered, what its
 * recorded commit contains, and whether this branch can still be told apart from
 * it at all.
 *
 * ONE ASSERTION PER STEP, ON PURPOSE. A single deep-equal over the whole
 * capture would report "the wire changed" and stop; a red list of named steps
 * says which exchanges moved and leaves the rest standing as evidence that the
 * transport, the handshake and the happy paths did not.
 *
 * THREE kinds of difference from 1.3.3 are allowed, and none is waved through:
 * a `KnownAddition` names a single field and the value it must hold, a
 * `DeclaredDivergence` names both sides' values at every path it checks, and a
 * `RebasedValue` recomputes one reference value from a live repository file
 * (the documentation this server serves as a resource is not part of the wire).
 * All three fail when they stop being true — an exception that outlives its
 * argument is indistinguishable from a regression nobody noticed, which is the
 * failure mode this whole file exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSandbox, removeSandbox } from './support/sandbox.js';
import {
  BASELINE_PATH,
  BASELINE_RELATIVE_PATH,
  DUAL_ERA_DELTAS,
  LEGACY_WIRE_STEPS,
  REFERENCE_VERSION,
  REPO_ROOT,
  applyEraDelta,
  applyKnownAdditions,
  applyRebases,
  bootServer,
  canonical,
  captureWire,
  foreignReferenceViolations,
  readPath,
  referenceProbes,
  sameWireValue,
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

let dualServer: BootedServer | undefined;
let dualSandbox: string | undefined;
let dualActual: WireCapture = {};
let dualBootFailure: unknown;

/** Boots one process and drives the whole plan against it. */
async function capture(
  era: 'legacy' | 'dual',
): Promise<{ server?: BootedServer; sandbox: string; capture: WireCapture; failure?: unknown }> {
  const scratch = await createSandbox(`legacy-wire-bench-${era}`);
  try {
    const booted = await bootServer({
      command: join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      args: [join(REPO_ROOT, 'src', 'server.ts')],
      cwd: REPO_ROOT,
      sandbox: scratch,
      env: { AVITO_MCP_PROTOCOL_ERA: era },
    });
    return { server: booted, sandbox: scratch, capture: await captureWire(booted) };
  } catch (err) {
    return { sandbox: scratch, capture: {}, failure: err };
  }
}

beforeAll(async () => {
  // TWO processes, one plan.
  //
  //   • `legacy` is the posture a 1.3.x operator gets by default — set
  //     explicitly so this still means what it says if the default moves;
  //   • `dual` is the posture block F of the criterion puts into production,
  //     and therefore the one the compatibility promise is actually about. A
  //     bench that only ever booted `legacy` could not have seen a regression
  //     in the leg the promise will be kept on.
  //
  // Sequential, not parallel: a `tsx` boot with 148 tools is CPU-bound, and two
  // of them racing on a CI runner is how a bench starts timing out and being
  // read as "the wire moved".
  const legacy = await capture('legacy');
  server = legacy.server;
  sandbox = legacy.sandbox;
  actual = legacy.capture;
  bootFailure = legacy.failure;

  const dual = await capture('dual');
  dualServer = dual.server;
  dualSandbox = dual.sandbox;
  dualActual = dual.capture;
  dualBootFailure = dual.failure;
}, BOOT_BUDGET_MS);

afterAll(async () => {
  await server?.stop();
  await dualServer?.stop();
  if (sandbox) await removeSandbox(sandbox);
  if (dualSandbox) await removeSandbox(dualSandbox);
});

/** `git` inside this checkout. Never throws; the caller reads `status`. */
function git(args: readonly string[]): { status: number | null; out: string } {
  const result = spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
  return { status: result.status, out: (result.stdout ?? '').trim() };
}

describe('legacy wire vs the published 1.3.3 build', () => {
  it('the baseline was captured from a real 1.3.3, not from this checkout', () => {
    expect(bootFailure).toBeUndefined();
    expect(baseline.$provenance.reference.health.name).toBe('avito-mcp');
    expect(baseline.$provenance.reference.health.version).toBe(REFERENCE_VERSION);
    // A path inside this checkout would mean the snapshot is a picture of the
    // branch and the comparison below proves nothing.
    //
    // Necessary and NOT sufficient, which is why the next three assertions
    // exist: `/healthz` reports `package.json`, and this branch's package.json
    // also says 1.3.3 — the migration started there and has not released — so a
    // branch process in a second worktree satisfies both of the checks above.
    expect(baseline.$provenance.reference.entrypoint.startsWith(REPO_ROOT)).toBe(false);
  });

  it('the reference ANSWERED what only 1.3.3 answers', () => {
    // The provenance check that does not depend on what the reference said
    // about itself. Every probe is derived from a difference this branch has
    // already declared: an M3 key that 1.3.3 does not put on `state/config`, and
    // the M2 call that 1.3.3 refuses and this branch accepts. A snapshot taken
    // from any build of this branch carries the branch's side of at least one of
    // them, whatever its version string, its path, or its git head says.
    expect(foreignReferenceViolations(baseline.steps)).toEqual([]);
  });

  it('keeps probes that a build of this branch actually fails', () => {
    // A guard on the guard above. It is worth exactly as many probes as it has,
    // so: there must be some; each must declare two different values; and the
    // branch process booted for this run must really answer the branch side of
    // every one of them. The day this branch stops differing from 1.3.3
    // everywhere, the provenance check degenerates into a tautology — and this
    // assertion is what says so, instead of letting it pass quietly forever.
    expect(bootFailure).toBeUndefined();
    const probes = referenceProbes();
    expect(probes.length).toBeGreaterThan(0);
    const toothless: string[] = [];
    for (const probe of probes) {
      const where = `${probe.step}.${probe.path.join('.')}`;
      if (sameWireValue(probe.reference, probe.branch)) {
        toothless.push(`${where}: declares the same value for 1.3.3 and for this branch`);
      }
      const live = readPath(actual[probe.step], probe.path);
      if (!sameWireValue(live, probe.branch)) {
        toothless.push(
          `${where}: this branch answers ${JSON.stringify(live)}, not the declared ` +
            `${JSON.stringify(probe.branch)} — the probe no longer separates the two`,
        );
      }
    }
    expect(toothless).toEqual([]);
  });

  it('names a reference commit that cannot be a build of this branch', () => {
    // The third layer, and the only one that can speak about the checkout the
    // reference was built from. `gitHead` is recorded by the capture; here it is
    // re-derived from THIS repository's own history, so a provenance block
    // edited by hand has to name a commit that really is pre-migration code.
    const { gitHead } = baseline.$provenance.reference;
    expect(gitHead, `${BASELINE_RELATIVE_PATH} records no reference commit`).toMatch(
      /^[0-9a-f]{40}$/,
    );
    const head = gitHead!;

    const shallow = git(['rev-parse', '--is-shallow-repository']);
    // No usable git at all (a source copy without `.git`): there is no history
    // to cross-check against, and the two assertions above — which need neither
    // git nor the reference checkout — are what stands. Everywhere this suite
    // normally runs, git is here.
    if (shallow.status !== 0) return;

    if (git(['cat-file', '-e', `${head}^{commit}`]).status !== 0) {
      // The one legitimate reason the commit is missing: a shallow clone (CI
      // checks out with the default depth). Asserted rather than assumed — an
      // unknown commit in a FULL clone means the provenance names a commit that
      // does not exist, which is the forgery this assertion is about.
      expect(
        shallow.out,
        `${head} is unknown to this repository and this is not a shallow clone`,
      ).toBe('true');
      return;
    }

    const manifest = git(['cat-file', '-p', `${head}:package.json`]);
    expect(manifest.status, `cannot read package.json at ${head}`).toBe(0);
    const reference = JSON.parse(manifest.out) as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    const dependencies = reference.dependencies ?? {};

    expect(reference.version, `${head} is not a ${REFERENCE_VERSION} tree`).toBe(REFERENCE_VERSION);
    // Pre-M2: the 1.x line runs on the v1 SDK package. Every build from this
    // branch — M2 onwards, including one whose package.json still says 1.3.3 —
    // runs on the v2 packages, and this is what separates them. It is the check
    // that catches the case the era keys below cannot: an M2 build, which has
    // none of M3's additions.
    expect(Object.keys(dependencies), `${head} does not depend on the v1 SDK`).toContain(
      '@modelcontextprotocol/sdk',
    );
    expect(
      Object.keys(dependencies).filter((name) => name.startsWith('@modelcontextprotocol/server')),
      `${head} already depends on the v2 server packages, so it is a migration build`,
    ).toEqual([]);
    // Pre-M3: the era switch is the first thing the dual-era work adds.
    expect(
      git(['grep', '-l', 'AVITO_MCP_PROTOCOL_ERA', head, '--', 'src']).out,
      `${head} already carries the era switch, so it is a migration build`,
    ).toBe('');
    // And it is on the line of history this branch descends from, not a
    // sibling's tip that happens to look old.
    expect(
      git(['merge-base', '--is-ancestor', head, 'HEAD']).status,
      `${head} is not an ancestor of this branch`,
    ).toBe(0);
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

      // A rebase recomputes a reference value from a live repository file, so a
      // path it names must already exist in the capture — otherwise it is a
      // typo silently asserting nothing, which is worse than no rebase at all.
      for (const rebase of step.rebase ?? []) {
        const where = rebase.path.join('.');
        expect(
          readPath(expected, rebase.path),
          `${where} is declared as a REBASE, but 1.3.3 has no value there — ` +
            `fix the path in LEGACY_WIRE_STEPS. Reason on record: ${rebase.why}`,
        ).toBeDefined();
      }

      expect(canonical(actual[step.id])).toEqual(
        canonical(applyRebases(applyKnownAdditions(expected, step.knownAdditions), step.rebase)),
      );
    });
  }
});

/**
 * The same plan, the same reference, against `AVITO_MCP_PROTOCOL_ERA=dual`.
 *
 * WHY THIS IS NOT A DUPLICATE OF THE SUITE ABOVE. The promise "a 2025 client
 * keeps working" is a promise about the process an operator runs, and block F
 * of the criterion puts `dual` into production — so `legacy` is the posture the
 * promise is about only until M7.7 lands, and `dual` is the posture it is about
 * afterwards. Proving compatibility exclusively on the leg that will be turned
 * off is proving it on the wrong process.
 *
 * The comparison is against the SAME 1.3.3 capture, reconciled the same way,
 * with one extra layer: `DUAL_ERA_DELTAS`, which names every path where dual
 * does not answer what 1.3.3 answered, with BOTH values. Running this the first
 * time is what turned up steps 37 and 41 — two malformed frames that parse as
 * JSON, are answered `-32700` by 1.3.3 and `-32600` by dual, and were covered
 * by no argument anywhere: `src/http/app.ts` reasons only about the bodies that
 * do not parse. They are declared rather than silenced, and the declaration
 * fails the day either side moves or the two converge.
 */
describe('the same plan on era=dual — the posture production will run', () => {
  it('booted a dual process and drove the whole plan against it', () => {
    expect(dualBootFailure).toBeUndefined();
    expect(Object.keys(dualActual)).toEqual(LEGACY_WIRE_STEPS.map((step) => step.id));
  });

  it('differs from the legacy leg on exactly the steps declared, and no others', () => {
    // The assertion that keeps the delta list honest in BOTH directions, and
    // the only one here that does not consult the reference: a new difference
    // between the two legs fails even if someone remembers to update the
    // baseline, and a declaration that has become unnecessary fails too.
    expect(bootFailure).toBeUndefined();
    expect(dualBootFailure).toBeUndefined();
    const differing = LEGACY_WIRE_STEPS.filter(
      (step) =>
        JSON.stringify(canonical(actual[step.id])) !==
        JSON.stringify(canonical(dualActual[step.id])),
    ).map((step) => step.id);
    expect(differing.sort()).toEqual(Object.keys(DUAL_ERA_DELTAS).sort());
  });

  for (const step of LEGACY_WIRE_STEPS) {
    it(`dual ${step.id}: ${step.note}`, () => {
      expect(dualBootFailure).toBeUndefined();
      const reference = baseline.steps[step.id];
      expect(
        reference,
        `no reference answer for ${step.id}; regenerate ${BASELINE_RELATIVE_PATH} ` +
          'with `npm run capture:legacy-baseline`',
      ).toBeDefined();

      const delta = DUAL_ERA_DELTAS[step.id];
      if (delta !== undefined) {
        // Both sides pinned, exactly like a DeclaredDivergence: the entry fails
        // if the legacy leg stops answering what it is said to answer, if dual
        // stops answering what it is said to answer, or if the difference goes
        // away and the declaration outlives its reason.
        for (const fact of delta.facts) {
          const where = fact.path.join('.');
          expect(
            readPath(actual[step.id], fact.path),
            `era=legacy at ${where}: ${delta.why}`,
          ).toEqual(fact.legacy);
          expect(
            readPath(dualActual[step.id], fact.path),
            `era=dual at ${where}: ${delta.why}`,
          ).toEqual(fact.dual);
          expect(
            fact.dual,
            `${where} is declared an ERA DELTA but both eras hold the same value; ` +
              'delete the entry in DUAL_ERA_DELTAS',
          ).not.toEqual(fact.legacy);
        }
      }

      const divergence = step.divergence;
      if (divergence !== undefined) {
        // A divergence from 1.3.3 is a property of the branch, not of the era,
        // so dual has to show the branch side of it too.
        for (const fact of divergence.facts) {
          expect(
            readPath(dualActual[step.id], fact.path),
            `era=dual at ${fact.path.join('.')}: ${divergence.why}`,
          ).toEqual(fact.branch);
        }
        return;
      }

      // Everything the delta does not name is compared against 1.3.3 exactly as
      // it is for the legacy leg — status, content type, session header, `Allow`
      // and every other byte of the body.
      expect(canonical(dualActual[step.id])).toEqual(
        canonical(
          applyEraDelta(
            applyRebases(applyKnownAdditions(reference, step.knownAdditions), step.rebase),
            delta,
          ),
        ),
      );
    });
  }
});
