#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const server = readJson('server.json');
const manifest = readJson('dist/manifest.json');
const expected = pkg.version;
const mismatches = [];

for (const [source, actual] of [
  ['package-lock.json.version', lock.version],
  ['package-lock.json.packages[""].version', lock.packages?.['']?.version],
  ['server.json.version', server.version],
  ['server.json.packages[0].version', server.packages?.[0]?.version],
  ['dist/manifest.json.version', manifest.version],
]) {
  if (actual !== expected) mismatches.push(`${source}=${String(actual)}`);
}

if (!read('CHANGELOG.md').includes(`## [${expected}]`)) {
  mismatches.push(`CHANGELOG.md lacks ## [${expected}]`);
}
for (const [path, marker] of [
  ['README.md', `New in v${expected}`],
  ['README.ru.md', `v${expected}`],
]) {
  if (!read(path).includes(marker)) {
    mismatches.push(`${path} lacks ${marker}`);
  }
}

if (mismatches.length > 0) {
  process.stderr.write(
    `Release version mismatch: package.json=${expected}\n${mismatches.map((item) => `- ${item}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(`Release version consistency: ${expected}\n`);
