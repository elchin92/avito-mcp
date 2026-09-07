import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
const checker = fileURLToPath(new URL('../scripts/check-docs.mjs', import.meta.url));
function fixture(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'avito-docs-'));
  directories.push(dir);
  execFileSync('git', ['init', '--quiet', dir]);
  writeFileSync(join(dir, 'README.md'), source);
  writeFileSync(join(dir, 'guide.md'), '# Начало\n\n## Setup `npx`\n\n## Setup `npx`\n');
  return spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
}
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

it('checks reference links, Unicode headings and duplicate anchors without parsing code examples as links', () => {
  const result = fixture(
    '# Guide\n\n[Start][start]\n\n[start]: guide.md#%D0%BD%D0%B0%D1%87%D0%B0%D0%BB%D0%BE\n\n[Setup](guide.md#setup-npx-1)\n\n```md\n[Example](missing.md)\n```\n',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('2 local links');
});

it('rejects missing files, missing sections and images without alt text', () => {
  const result = fixture(
    '# Guide\n\n[Missing](missing.md)\n\n[Section](guide.md#absent)\n\n![](guide.md)\n',
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('missing local target missing.md');
  expect(result.stderr).toContain('missing section guide.md#absent');
  expect(result.stderr).toContain('image needs descriptive alt text');
});
