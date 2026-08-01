/**
 * Sweeps the scratch root (test/.sandbox) once before the run and once after it.
 *
 * Suites that call createSandbox() explicitly already remove what they created.
 * Configs from test/support/config-fixture.ts cannot: they are built inline, no
 * test owns their teardown, and a worker process that vitest terminates never
 * runs an 'exit' hook. Sweeping the root here is the only place that is
 * guaranteed to run exactly once with nothing else touching the directory.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '.sandbox');

export function setup(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

export function teardown(): void {
  rmSync(ROOT, { recursive: true, force: true });
}
