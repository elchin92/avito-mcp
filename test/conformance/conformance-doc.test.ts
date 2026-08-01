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
 *     test must exist — the FILE must be on disk and the TITLE must be one of
 *     the titles that file declares, MATCHED WHOLE, wherever in the row it is
 *     named (a guard test cited inside a justification is a claim about this
 *     repository too);
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
 *     CLOSED. Closure is read off three things and nothing else: the task named
 *     in a test TITLE (`describe('M5.1 — …')`), the task named on the `Context:`
 *     line of an accepted ADR, and the task a test file claims as its own
 *     subject on the opening line of its header block (`M4.2 acceptance: …`).
 *     All three are places where naming a task asserts "the work is here"; a
 *     task named anywhere else in a comment asserts nothing, which is why the
 *     rest of the comments are not read.
 *
 * ── Why the header block is read, after it was not ──────────────────────────
 * The first version of this rule read titles and ADRs only, and argued that
 * comments assert nothing. The exemption it actually created was its own: THIS
 * file's header opens with `M6.2 — the guard that makes docs/conformance.md an
 * ARTIFACT`, which is the only place M6.2 is claimed anywhere in the repository.
 * So the one task the closure check could never see was the task the closure
 * check itself delivers, and a row deferring "into M6.2" stayed green while the
 * guard it deferred into was running. The same held for `M6.1` (the era matrix
 * lives in `test/support/era-matrix.ts`, a helper with no titles of its own) and
 * for `M3.9`.
 *
 * The distinction that survives is not comment-vs-title, it is claim-vs-mention.
 * A line that OPENS a test file's header block with `M4.2 acceptance:` is the
 * file saying what it delivers; `the limit arrives in M3.8`, mid-sentence in
 * some other paragraph, is a remark about work that may not exist. Only the
 * first form is read, and only in the leading block of a file under `test/`.
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

/** A `describe` / `it` / `test` call, with any modifiers (`.each`, `.skip`, …). */
const SUITE_CALL = /\b(?:describe|it|test)((?:\.\w+)*)\s*\(/g;

/**
 * Reads a quoted literal starting at `at`, returning its TEXT — escapes
 * resolved, so `express.json()\'s` compares equal to what the table quotes.
 * Returns undefined for a template literal carrying a substitution: a title
 * assembled at run time has no verbatim form to cite, and pretending otherwise
 * would let the table cite a title that never appears on any run.
 */
function readLiteral(code: string, at: number): { text: string; end: number } | undefined {
  const quote = code[at];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  let text = '';
  for (let index = at + 1; index < code.length; index += 1) {
    const character = code[index]!;
    if (character === '\\') {
      const escaped = code[index + 1] ?? '';
      text += { n: '\n', t: '\t', r: '\r' }[escaped] ?? escaped;
      index += 1;
      continue;
    }
    if (quote === '`' && character === '$' && code[index + 1] === '{') return undefined;
    if (character === quote) return { text, end: index + 1 };
    text += character;
  }
  return undefined;
}

/** Index just past the `)` matching the `(` at `at - 1`. Skips string literals. */
function skipArguments(code: string, at: number): number {
  let depth = 1;
  for (let index = at; index < code.length; index += 1) {
    const character = code[index]!;
    if (character === "'" || character === '"' || character === '`') {
      let scan = index + 1;
      while (scan < code.length && code[scan] !== character) scan += code[scan] === '\\' ? 2 : 1;
      index = scan;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Every suite/case title a file DECLARES, as whole strings.
 *
 * Whole strings, because the check that uses this used to be
 * `source.includes(title)` — and a substring match does not rot. Extend
 * `answers -32022` into `answers -32022 with data.requested` and the table goes
 * on citing the old, now non-existent title with a green run behind it: exactly
 * the silent decay this file exists to prevent, one level down.
 *
 * `it.each(cases)('…')` is parsed too. The parameterised titles are four of the
 * ones the table cites, and a scanner that skipped them would have made those
 * four rows unfalsifiable rather than merely unchecked.
 */
function suiteTitles(code: string): string[] {
  const titles: string[] = [];
  SUITE_CALL.lastIndex = 0;
  for (let call = SUITE_CALL.exec(code); call !== null; call = SUITE_CALL.exec(code)) {
    let at = call.index + call[0].length;
    if (call[1]!.includes('.each')) {
      at = skipArguments(code, at);
      if (at === -1) continue;
      while (/\s/.test(code[at] ?? '')) at += 1;
      if (code[at] !== '(') continue;
      at += 1;
    }
    while (/\s/.test(code[at] ?? '')) at += 1;
    const literal = readLiteral(code, at);
    if (literal !== undefined) titles.push(literal.text);
  }
  return titles;
}

/**
 * A task a test file claims as its own subject, on the opening line of its
 * header block: `M4.2 acceptance: …`, `M6.2 — …`, `M3.1 / M3.2 — …`.
 *
 * Deliberately narrow. The claim has to BEGIN the line and be followed by a
 * dash, a colon or the word "acceptance", which is the form a file uses to say
 * what it delivers. Every other mention — `(F1 / M3.10)` inside a bullet,
 * "pagination lands in M4.3" mid-sentence — is a remark, and remarks close
 * nothing.
 */
const OWNERSHIP_CLAIM =
  /^((?:M\d+\.\d+)(?:\s*(?:[–—/-]|and)\s*M?\d+(?:\.\d+)?)*)\s*(?:[–—:-]|acceptance\b)/;

/**
 * The opening line of a file's leading `/** … *\/` block, with the comment
 * furniture stripped. Only that line: a claim is what a file leads with, and
 * reading the whole block would pick up every task the prose below argues
 * about.
 */
function headerOpening(source: string): string {
  const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (block === null) return '';
  return (
    block[1]!
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .find((line) => line.length > 0) ?? ''
  );
}

/**
 * Plan tasks this repository claims to have CLOSED, mapped to the evidence.
 *
 * Two sources, both of them places where naming a task is an assertion that the
 * work landed:
 *
 *   • a test title — `describe('M5.1 — RFC 9207 issuer identification')` says
 *     the proof is in this file;
 *   • the `Context:` line of an ADR whose `Status:` is `accepted` — the shape a
 *     decision task takes when its outcome is a decision rather than a test;
 *   • the OWNERSHIP CLAIM opening a test file's header block — `M4.2
 *     acceptance: …` — which is how a suite that has no room for the id in any
 *     one title, and a helper that declares no titles at all, say what they
 *     deliver.
 *
 * The rest of the comments are deliberately NOT read. A comment names tasks
 * freely, including ones nobody has started ("the limit arrives in M3.8"), so
 * reading them all would turn this into a check that fires on intent rather
 * than on work. Reading NONE of them was the previous rule, and it exempted
 * this very file: M6.2 is claimed in the block above and nowhere else, so the
 * check could not see the task it is itself the delivery of.
 */
function closedTasks(): Map<string, string> {
  const closed = new Map<string, string>();
  const record = (id: string, evidence: string): void => {
    if (!closed.has(id)) closed.set(id, evidence);
  };

  for (const file of everyFileUnder(join(root, 'test'), '.ts')) {
    const source = readFileSync(file, 'utf8');
    // The header block is read FIRST and only in its claim form, then thrown
    // away with the rest of the comments: the example this file's own header
    // spells out mid-paragraph (`describe('M5.1 — …')`) must not close M5.1 by
    // being talked about, and it does not — it opens no line.
    const claim = OWNERSHIP_CLAIM.exec(headerOpening(source));
    if (claim !== null) {
      for (const id of citedTasks(claim[1]!)) {
        record(id, `${relative(root, file)} (header block claims «${claim[1]!.trim()}»)`);
      }
    }
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const title of suiteTitles(code)) {
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
/** Files are parsed once: the table cites the same suite dozens of times. */
const declared = new Map<string, Set<string>>();
const titlesOf = (file: string): Set<string> => {
  if (!declared.has(file)) {
    const code = readFileSync(join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    declared.set(file, new Set(suiteTitles(code)));
  }
  return declared.get(file)!;
};

describe('M6.2 — docs/conformance.md is checkable, not merely written', () => {
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
    //
    // WHOLE TITLES, not substrings. `source.includes(title)` was the first
    // version and it only half-rotted: renaming a test breaks it, but WIDENING
    // one does not — `answers -32022` goes on resolving after the test it names
    // has become `answers -32022 on the modern leg only`, and the row keeps
    // citing a title no run will ever print. The scope of a citation is part of
    // the claim, so the citation has to move when the scope does.
    const misses: string[] = [];
    for (const row of rows) {
      for (const test of namedTests(row)) {
        if (!existsSync(join(root, test.file))) continue;
        const titles = titlesOf(test.file);
        if (titles.has(test.title)) continue;
        const widened = [...titles].filter(
          (title) => title.includes(test.title) || test.title.includes(title),
        );
        misses.push(
          `${row.id}: "${test.title}" is not a title in ${test.file}` +
            (widened.length > 0 ? ` — did it become ${JSON.stringify(widened)}?` : ''),
        );
      }
    }
    expect(misses).toEqual([]);
  });

  it('reads whole titles, including the parameterised ones', () => {
    // A guard on the assertion above: it is only as strong as the parser
    // feeding it, and a parser that silently stops recognising a form turns
    // every citation of that form into a miss — or, if it had been written to
    // skip what it cannot read, into a citation nobody checks. Both shapes the
    // table cites must be readable here.
    const titles = titlesOf('test/conformance/public-contract.test.ts');
    expect(titles.has('%s names every revision the code advertises')).toBe(true);
    expect(titlesOf('test/conformance/errors.test.ts').size).toBeGreaterThan(10);
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

  it('is not exempt from itself: the task this file delivers reads as closed', () => {
    // The hole this assertion pins shut. Closure used to be read from titles
    // and ADRs alone, and M6.2 — the task that IS this file — is claimed in the
    // header block above and in no title anywhere, so the one deferral the
    // guard could never falsify was a deferral into the guard. A row saying
    // "не покрыто — таблица проверяется задачей M6.2" passed, with the check it
    // named running in the same process.
    //
    // Named tasks, not a count: `closed.size > 0` is satisfied by any other
    // file and would go on passing the day this one stops being read.
    for (const task of ['M6.2', 'M6.1', 'M3.9']) {
      expect(closed.get(task), `${task} does not read as closed anywhere`).toBeDefined();
    }
    expect(closed.get('M6.2')).toContain('conformance-doc.test.ts');
  });

  it('closes a task on a claim, never on a mention', () => {
    // The other half: reading header blocks must not turn every task a comment
    // discusses into a closed one. M4.3 (`tools/list` pagination) is named in
    // `test/caching-hints.test.ts` in the middle of a comment about what this
    // suite deliberately does NOT do, and M8.7 — the scope split D6 defers to —
    // is named in the table itself. Neither is work that landed.
    for (const task of ['M4.3', 'M8.7', 'M5.10']) {
      expect(closed.get(task), `${task} reads as closed on a mention alone`).toBeUndefined();
    }
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
