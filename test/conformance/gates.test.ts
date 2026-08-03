/**
 * M6.5 — the quality gates, asserted rather than trusted.
 *
 * The plan states the rule in one line: "пороги покрытия НЕ ПОНИЖАЮТСЯ — новый
 * транспортный слой покрывается тестами, а не понижением порога". The risk it
 * names is not technical, it is procedural: the moment a release is blocked by
 * a coverage threshold at 22:00, editing `vitest.config.ts` is a one-line fix
 * that looks like configuration and reads like nothing in a diff.
 *
 * So the floor lives in a test. Lowering a threshold now requires editing this
 * file too, which is a review-visible act that has to be argued for in the PR —
 * which is exactly what M6.5 asks for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/** The floor as of 1.3.3. Raising these is welcome; lowering them is the bug. */
const FLOOR = { statements: 74, branches: 65, functions: 70, lines: 75 } as const;

describe('C7 / M6.5 — the gates that keep the migration honest', () => {
  it('keeps every coverage threshold at or above the 1.3.3 floor', () => {
    const config = read('vitest.config.ts');
    for (const [metric, floor] of Object.entries(FLOOR)) {
      const match = config.match(new RegExp(`${metric}:\\s*(\\d+)`));
      expect(match, `vitest.config.ts declares no ${metric} threshold`).not.toBeNull();
      expect(Number(match![1]), `${metric} threshold was lowered`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('keeps npm run verify covering lint, all three typechecks and coverage', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const verify = pkg.scripts.verify!;
    for (const step of [
      'npm run lint',
      'npm run typecheck',
      'npm run typecheck:scripts',
      'npm run typecheck:tests',
      'npm run test:coverage',
    ]) {
      expect(verify, `verify must run ${step}`).toContain(step);
    }
  });

  it('collects the conformance suites in the default test run', () => {
    // `test/conformance/` is a nested directory; a narrower `include` pattern
    // would silently stop collecting the very suites that prove conformance.
    const config = read('vitest.config.ts');
    expect(config).toContain("include: ['test/**/*.test.ts']");
  });
});
