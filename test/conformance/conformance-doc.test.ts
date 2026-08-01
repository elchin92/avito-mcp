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
 *     it verbatim;
 *   • every row NOT marked «покрыто» must carry a justification, so "не
 *     покрыто" can never be a silent shrug;
 *   • every requirement of §1.2.A (all sixteen) must have a row, and blocks
 *     B–E must be represented;
 *   • every source link must name a document that exists in the research
 *     corpus.
 *
 * The corpus itself is untracked (8.4 MB, deliberately kept out of the package
 * and the image by M0.5), so its file list is frozen below rather than globbed.
 * A link to `docs/mcp-2026-07-28/whatever.md` that is not in that list is a
 * typo or an invention, and either way the citation cannot be followed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = 'docs/conformance.md';

/**
 * The 65 documents of the research corpus captured on 2026-07-28. Frozen, not
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

interface Row {
  id: string;
  requirement: string;
  source: string;
  tests: Array<{ file: string; title: string }>;
  status: string;
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
    const tests: Array<{ file: string; title: string }> = [];
    for (const match of cells[3]!.matchAll(/`(test\/[^`]+\.test\.ts)`\s*›\s*`([^`]+)`/g)) {
      tests.push({ file: match[1]!, title: match[2]! });
    }
    rows.push({
      id: cells[0]!,
      requirement: cells[1]!,
      source: cells[2]!,
      tests,
      status: cells[4]!,
    });
  }
  return rows;
}

const markdown = readFileSync(join(root, DOC), 'utf8');
const rows = parseRows(markdown);
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
      for (const test of row.tests) {
        expect(existsSync(join(root, test.file)), `${row.id}: no such file ${test.file}`).toBe(
          true,
        );
      }
    }
  });

  it('finds every referenced test TITLE verbatim in the file it names', () => {
    // The single most valuable assertion in this file. A renamed test silently
    // turns a "покрыто" row into fiction, and grepping the titles by hand is
    // exactly the review step that gets skipped.
    const misses: string[] = [];
    for (const row of rows) {
      for (const test of row.tests) {
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
      if (row.status.startsWith('покрыто')) continue;
      const justification = row.status.replace(/^(не покрыто|неприменимо)/, '').trim();
      expect(
        justification.length,
        `${row.id}: status "${row.status}" carries no justification`,
      ).toBeGreaterThan(20);
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
