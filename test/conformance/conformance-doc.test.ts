/**
 * M6.2 — the guard that makes `docs/conformance.md` an ARTIFACT rather than a
 * claim.
 *
 * A conformance table is worth exactly as much as its weakest row. The failure
 * mode is not that someone writes a false row on purpose; it is that a test
 * gets renamed, a suite gets split, a requirement gets reworded — and the table
 * keeps asserting a mapping that no longer resolves. At that point the document
 * still reads as proof and proves nothing, which is worse than having no
 * document at all, because it is now believed.
 *
 * So every claim in the table is re-derived here from the repository:
 *
 *   • every row marked «покрыто» must name at least one test, and every named
 *     test must exist — the FILE must be on disk and the TITLE must appear in
 *     it verbatim, wherever in the row it is named (a guard test cited inside a
 *     justification is a claim about this repository too);
 *   • every row NOT marked «покрыто» must carry a justification, and that
 *     justification must RESOLVE — see below;
 *   • every requirement of §1.2.A (all sixteen) must have a row, and blocks
 *     B–E must be represented;
 *   • every source link must name a document that exists in the research
 *     corpus.
 *
 * ── Why the justifications are checked at all ───────────────────────────────
 * The first version of this file checked «покрыто» rows and nothing else, and
 * the hole was not theoretical: row D5 went on saying "not covered — this is
 * the scope of stage M5, which was not carried out on this branch" for the
 * whole time stage M5 was being carried out ON THIS BRANCH, with
 * `test/oauth-conformance.test.ts` sitting in the same commit range. A
 * «покрыто» row rots loudly, because the test it names gets renamed and this
 * file goes red. A «не покрыто» row rots SILENTLY: nothing it names can ever
 * stop existing, because it names nothing.
 *
 * The fix is to make a non-covered row falsifiable in the same way a covered
 * one is, and the only honest way to do that is to make it name something whose
 * DISAPPEARANCE is what proves it wrong. What disappears when a deferral stops
 * being true is the openness of the task it was deferred into. So:
 *
 *   • a «не покрыто» row must name at least one plan task (`M<stage>.<task>`),
 *     and may name no test at all — a test in a row that claims no coverage is
 *     a contradiction, not a citation;
 *   • an «неприменимо» row must name a plan task or an artifact that carries
 *     the decision (an ADR, a module, a guard test), and every path it names
 *     must exist;
 *   • and no non-covered row may defer into a task this repository has already
 *     CLOSED. Closure is read off two things and nothing else: the task named
 *     in a test TITLE (`describe('M5.1 — …')`), and the task named on the
 *     `Context:` line of an accepted ADR. Both are places where naming a task
 *     asserts "the work is here"; a task named in a comment asserts nothing,
 *     which is why comments are not read.
 *
 * That last rule is the one that makes the table self-correcting rather than
 * merely well-intentioned: the commit that closes M5.1 turns every row still
 * deferring to M5.1 red, in the same run, and the only way back to green
 * without deleting the evidence is to rewrite the row.
 *
 * What this CANNOT check, stated rather than implied: whether a cited task
 * exists in the plan at all, or whether it is genuinely open. `MIGRATION_PLAN.md`
 * is untracked (it is not in the package, the image, or a clean checkout), so a
 * typo'd task id resolves to "open" here. The direction that rots — a deferral
 * that outlives its task — is the direction that is checked.
 *
 * The corpus itself is untracked (8.4 MB, deliberately kept out of the package
 * and the image by M0.5), so its file list is frozen below rather than globbed.
 * A link to `docs/mcp-2026-07-28/whatever.md` that is not in that list is a
 * typo or an invention, and either way the citation cannot be followed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = 'docs/conformance.md';

/**
 * The 66 documents of the research corpus captured on 2026-07-28. Frozen, not
 * globbed: the directory is untracked by design, so on a clean checkout (and in
 * CI) there is nothing to glob.
 */
const CORPUS = new Set([
  '00-INDEX.md',
  'api-1.md',
  'api-2.md',
  'authorization.md',
  'basic.md',
  'blog.md',
  'changelog.md',
  'client-elicitation.md',
  'client-roots.md',
  'client-sampling.md',
  'client.md',
  'concepts.md',
  'deprecated.md',
  'extensions-1.md',
  'extensions-2.md',
  'extensions-auth.md',
  'governance.md',
  'guides-1.md',
  'guides-2.md',
  'guides-3.md',
  'guides-security.md',
  'lifecycle-policy.md',
  'overview-1.md',
  'overview-2.md',
  'patterns.md',
  'registry-1.md',
  'registry-2.md',
  'related.md',
  'schema-1.md',
  'schema-2.md',
  'schema-3.md',
  'sdk-typescript-1.md',
  'sdk-typescript-2.md',
  'sdk-typescript-3.md',
  'sdk-typescript-4.md',
  'sdk-typescript-5.md',
  'sdk-typescript-6.md',
  'sdk-typescript-7.md',
  'sdk.md',
  'seps-1.md',
  'seps-2.md',
  'seps-3.md',
  'seps-4.md',
  'seps-5.md',
  'server-1.md',
  'server-2.md',
  'server-discovery.md',
  'server-overview.md',
  'server-prompts.md',
  'server-resources.md',
  'server-tools.md',
  'site-index.md',
  'spec-architecture.md',
  'spec-authorization.md',
  'spec-basic.md',
  'spec-core.md',
  'spec-overview.md',
  'spec-patterns.md',
  'spec-security.md',
  'spec-transports.md',
  'tool-annotations.md',
  'transports.md',
  'utilities-1.md',
  'utilities-2.md',
  'utilities-3.md',
  'versioning.md',
]);

const STATUSES = ['покрыто', 'не покрыто', 'неприменимо'] as const;

/** `test/x.test.ts` › `a title`, wherever in a row it appears. */
const TEST_REFERENCE = /`(test\/[^`]+\.test\.ts)`\s*›\s*`([^`]+)`/g;

/** A plan task id. Ranges (`M5.1–M5.7`) are expanded by {@link citedTasks}. */
const TASK = /M\d+\.\d+/g;

/**
 * A repository path in backticks: `src/…`, `docs/adr/…`, `scripts/…`. Anchored
 * on a known top-level directory so `package.json` or `avito://state/config` is
 * not mistaken for one.
 */
const REPO_PATH = /`((?:src|test|docs|scripts|deploy)\/[\w./-]+)`/g;

interface TestReference {
  file: string;
  title: string;
}

interface Row {
  id: string;
  requirement: string;
  source: string;
  /** Tests named in the «Тест» column — the coverage claim itself. */
  tests: TestReference[];
  /** Tests named inside the justification — guards, not coverage. */
  guards: TestReference[];
  status: string;
  /** The status word: one of {@link STATUSES}. */
  kind: string;
  /** Everything after the status word. */
  justification: string;
}

function testReferences(cell: string): TestReference[] {
  return [...cell.matchAll(TEST_REFERENCE)].map((match) => ({
    file: match[1]!,
    title: match[2]!,
  }));
}

function parseRows(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 5) continue;
    if (!/^[A-F]\d+[a-z]?$/.test(cells[0]!)) continue;
    const status = cells[4]!;
    const kind = STATUSES.find((candidate) => status.startsWith(candidate)) ?? '';
    rows.push({
      id: cells[0]!,
      requirement: cells[1]!,
      source: cells[2]!,
      tests: testReferences(cells[3]!),
      guards: testReferences(status),
      status,
      kind,
      justification: status.slice(kind.length).trim(),
    });
  }
  return rows;
}

/**
 * Every task id a justification names, with `M5.1–M5.7` expanded into the seven
 * it stands for. A range is how a deferral of a whole stage gets written, and
 * leaving it unexpanded would check the two endpoints and skip the middle.
 */
function citedTasks(text: string): Set<string> {
  const ids = new Set<string>();
  for (const range of text.matchAll(/M(\d+)\.(\d+)\s*[–—-]\s*M(\d+)\.(\d+)/g)) {
    const [, fromStage, fromTask, toStage, toTask] = range;
    if (fromStage !== toStage) continue;
    for (let task = Number(fromTask); task <= Number(toTask); task += 1) {
      ids.add(`M${fromStage}.${task}`);
    }
  }
  for (const id of text.matchAll(TASK)) ids.add(id[0]);
  return ids;
}

function everyFileUnder(directory: string, suffix: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(suffix)) found.push(path);
    }
  };
  if (existsSync(directory)) walk(directory);
  return found;
}

/** The string literal of a `describe(…)` / `it(…)` / `test(…)` call. */
const SUITE_TITLE = /\b(?:describe|it|test)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Plan tasks this repository claims to have CLOSED, mapped to the evidence.
 *
 * Two sources, both of them places where naming a task is an assertion that the
 * work landed:
 *
 *   • a test title — `describe('M5.1 — RFC 9207 issuer identification')` says
 *     the proof is in this file;
 *   • the `Context:` line of an ADR whose `Status:` is `accepted` — the shape a
 *     decision task takes when its outcome is a decision rather than a test.
 *
 * Comments are deliberately NOT read. A comment names tasks freely, including
 * ones nobody has started ("the limit arrives in M3.8"), so reading them would
 * turn this into a check that fires on intent rather than on work.
 */
function closedTasks(): Map<string, string> {
  const closed = new Map<string, string>();
  const record = (id: string, evidence: string): void => {
    if (!closed.has(id)) closed.set(id, evidence);
  };

  for (const file of everyFileUnder(join(root, 'test'), '.ts')) {
    // Comments are stripped BEFORE the titles are read, which is the whole
    // point: this very file documents the convention with a `describe('M5.1 —
    // …')` example in its header, and reading it would close M5.1 by talking
    // about it. That is exactly the failure the rule exists to avoid.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const call of code.matchAll(SUITE_TITLE)) {
      const title = call[2]!;
      for (const id of title.matchAll(TASK)) {
        record(id[0], `${relative(root, file)} › «${title}»`);
      }
    }
  }

  for (const file of everyFileUnder(join(root, 'docs', 'adr'), '.md')) {
    const text = readFileSync(file, 'utf8');
    if (!/^Status:\s*accepted/im.test(text)) continue;
    const context = /^Context:.*$/m.exec(text)?.[0] ?? '';
    for (const id of context.matchAll(TASK)) {
      record(id[0], `${relative(root, file)} (${context.trim()})`);
    }
  }

  return closed;
}

const markdown = readFileSync(join(root, DOC), 'utf8');
const rows = parseRows(markdown);
const closed = closedTasks();
/** Every test a row names, in the «Тест» column and in the justification alike. */
const namedTests = (row: Row): TestReference[] => [...row.tests, ...row.guards];
/** Files are read once: the table cites the same suite dozens of times. */
const sources = new Map<string, string>();
const sourceOf = (file: string): string => {
  if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), 'utf8'));
  return sources.get(file)!;
};

describe('docs/conformance.md is checkable, not merely written', () => {
  it('parses into rows at all', () => {
    expect(rows.length).toBeGreaterThan(30);
  });

  it('covers every one of the sixteen requirements of §1.2.A', () => {
    const covered = new Set(rows.map((row) => row.id.replace(/[a-z]$/, '')));
    for (let index = 1; index <= 16; index += 1) {
      expect(covered.has(`A${index}`), `§1.2.A item ${index} has no row`).toBe(true);
    }
  });

  it('represents blocks B, C, D and E as well', () => {
    for (const block of ['B', 'C', 'D', 'E']) {
      const inBlock = rows.filter((row) => row.id.startsWith(block));
      expect(inBlock.length, `block ${block} has no rows`).toBeGreaterThan(0);
    }
  });

  it('uses only the three defined statuses', () => {
    for (const row of rows) {
      const known = STATUSES.some((status) => row.status.startsWith(status));
      expect(known, `${row.id}: unknown status "${row.status}"`).toBe(true);
    }
  });

  it('names at least one test on every row it calls покрыто', () => {
    for (const row of rows) {
      if (!row.status.startsWith('покрыто')) continue;
      expect(row.tests.length, `${row.id} claims покрыто with no test reference`).toBeGreaterThan(
        0,
      );
    }
  });

  it('resolves every referenced test file to a file on disk', () => {
    for (const row of rows) {
      for (const test of namedTests(row)) {
        expect(existsSync(join(root, test.file)), `${row.id}: no such file ${test.file}`).toBe(
          true,
        );
      }
    }
  });

  it('finds every referenced test TITLE verbatim in the file it names', () => {
    // The single most valuable assertion in this file. A renamed test silently
    // turns a "покрыто" row into fiction, and grepping the titles by hand is
    // exactly the review step that gets skipped. Guard tests cited inside a
    // justification are held to the same standard: an «неприменимо» row that
    // says "the guard against this is over there" is making a claim about this
    // repository, and it decays the same way.
    const misses: string[] = [];
    for (const row of rows) {
      for (const test of namedTests(row)) {
        if (!existsSync(join(root, test.file))) continue;
        if (!sourceOf(test.file).includes(test.title)) {
          misses.push(`${row.id}: "${test.title}" not found in ${test.file}`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('justifies every row that is not покрыто', () => {
    for (const row of rows) {
      if (row.kind === 'покрыто') continue;
      expect(
        row.justification.length,
        `${row.id}: status "${row.status}" carries no justification`,
      ).toBeGreaterThan(20);
    }
  });

  it('names no test anywhere in a row it calls не покрыто', () => {
    // «неприменимо» may cite a test in either cell, and several do: the
    // requirement is out of scope AND a guard keeps it out (A3f, A13d). «не
    // покрыто» may not — it asserts that nothing in the repository proves this
    // requirement, so a test named in the same breath refutes it, and the
    // reader has no way to tell which of the two statements is the false one.
    for (const row of rows) {
      if (row.kind !== 'не покрыто') continue;
      expect(
        namedTests(row).map((test) => `${test.file} › ${test.title}`),
        `${row.id} claims не покрыто and names a test that would cover it`,
      ).toEqual([]);
    }
  });

  it('anchors every row that is not покрыто to a plan task or to an artifact', () => {
    // What makes a justification checkable at all. "Out of scope" with nothing
    // named is a sentence; "deferred into M8.7" and "decided in
    // docs/adr/0005-scopes.md" are statements the next two assertions can
    // falsify.
    const unanchored: string[] = [];
    for (const row of rows) {
      if (row.kind === 'покрыто') continue;
      const tasks = citedTasks(row.justification);
      const paths = [...row.justification.matchAll(REPO_PATH)].map((match) => match[1]!);
      if (row.kind === 'не покрыто' && tasks.size === 0) {
        unanchored.push(`${row.id}: не покрыто names no plan task`);
        continue;
      }
      if (tasks.size === 0 && paths.length === 0 && namedTests(row).length === 0) {
        unanchored.push(`${row.id}: неприменимо names no plan task, file or guard test`);
      }
    }
    expect(unanchored).toEqual([]);
  });

  it('resolves every repository path named in a justification', () => {
    const missing: string[] = [];
    for (const row of rows) {
      for (const match of row.justification.matchAll(REPO_PATH)) {
        if (!existsSync(join(root, match[1]!)))
          missing.push(`${row.id}: no such file ${match[1]!}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('refuses a justification that defers to a task this repository has closed', () => {
    // THE assertion this file was extended for. D5 said "this is the scope of
    // stage M5, which was not carried out on this branch" while
    // test/oauth-conformance.test.ts — `describe('M5.1 — …')` — sat two commits
    // away in the same branch. Nothing could go red, because the row named
    // nothing that could stop existing.
    //
    // Now the closing commit is what turns it red: the moment a task appears in
    // a test title or on the Context: line of an accepted ADR, every row still
    // deferring into it fails, and the failure names the evidence so the fix is
    // a rewrite of the row rather than a hunt.
    const stale: string[] = [];
    for (const row of rows) {
      if (row.kind === 'покрыто') continue;
      for (const task of citedTasks(row.justification)) {
        const evidence = closed.get(task);
        if (evidence !== undefined) {
          stale.push(
            `${row.id}: status "${row.kind}" defers to ${task}, but ${task} is closed — ${evidence}`,
          );
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it('reads closure from titles and accepted ADRs, and finds some', () => {
    // A guard on the guard: if the extraction above ever stops matching (a
    // rename of `describe`, a change of ADR front matter), the previous
    // assertion would pass vacuously and go on passing forever.
    expect(closed.size).toBeGreaterThan(0);
    expect([...closed.keys()].some((task) => task.startsWith('M5.'))).toBe(true);
  });

  it('cites only documents that exist in the research corpus', () => {
    const unknown: string[] = [];
    for (const match of markdown.matchAll(/mcp-2026-07-28\/([A-Za-z0-9._-]+\.md)/g)) {
      if (!CORPUS.has(match[1]!)) unknown.push(match[1]!);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('cites the corpus on every row of block A', () => {
    // Blocks B–E are about this repository's own promises (wire compatibility,
    // the test seam, the security posture, the public contract) and are cited
    // to the migration plan; block A is the revision itself, and a normative
    // claim with no document behind it is the thing this table exists to
    // prevent.
    for (const row of rows) {
      expect(row.source.length, `${row.id} has an empty source cell`).toBeGreaterThan(3);
      if (!row.id.startsWith('A')) continue;
      expect(
        /mcp-2026-07-28\/[A-Za-z0-9._-]+\.md/.test(row.source),
        `${row.id} cites no corpus document`,
      ).toBe(true);
    }
  });

  it('records the state of the external verification required by M6.7', () => {
    // The one thing no self-written test can supply. The plan allows "no
    // third-party client was available" as an answer, but not silence.
    expect(markdown).toContain('Внешняя верификация');
    expect(markdown).toMatch(/M6\.7/);
  });
});
