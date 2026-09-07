#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const issues = [];
const pkg = JSON.parse(read('package.json'));

// npm's `files` field is the boundary: adding a new public document requires an
// explicit entry. A directory or Markdown glob would also publish local notes.
const approved = new Set(['package.json', 'README.md', 'LICENSE', 'NOTICE']);
for (const entry of pkg.files ?? []) {
  if (entry === 'dist/') continue;
  if (
    typeof entry !== 'string' ||
    /[*!?[\]{}\\]/.test(entry) ||
    entry.startsWith('/') ||
    entry.split('/').includes('..')
  ) {
    issues.push(`package.json files: expected an explicit relative file, got ${String(entry)}`);
    continue;
  }
  try {
    if (!lstatSync(resolve(root, entry)).isFile()) {
      issues.push(`package.json files: ${entry} must be a regular file`);
      continue;
    }
  } catch {
    issues.push(`package.json files: missing ${entry}`);
    continue;
  }
  approved.add(entry);
}
if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  issues.push('package.json must declare a nonempty files allowlist');
}

function privatePath(path) {
  const name = basename(path);
  if (['.env.example', '.mcp.json.example'].includes(name)) return false;
  return (
    /(^|\/)(?:\.claude|\.codex|\.wire-baseline|conversations?|transcripts?|chat-exports?|session-notes|mcp-2026-07-28)(?:\/|$)/i.test(
      path,
    ) ||
    /^(?:MIGRATION_(?:PLAN|PROGRESS)|PROJECT_AUDIT|AUDIT-.*)\.md$/i.test(name) ||
    /^(?:conversation|transcript|chat-export|session-notes)[._-].*\.(?:md|txt|json|html)$/i.test(
      name,
    ) ||
    /^(?:\.env(?:\..*)?|\.remote\.env.*|\.avito-token\.json.*|\.mcp\.json.*|\.npmrc.*)$/.test(
      name,
    ) ||
    /\.(?:jsonl|pid|log|pem|key)(?:\.[^/]*)?$/.test(name)
  );
}

function inspect(path, surface) {
  if (privatePath(path)) issues.push(`${surface}: private/local path ${path}`);
  // These are records of a working conversation, not technical ADR decisions.
  // Secret scanning remains a separate CI check; this is not a DLP classifier.
  if (/\.(?:md|mdx|txt)$/i.test(path)) {
    const text = read(path);
    if (
      /owner acknowledgement|reported owner consent|полученное сообщение о согласии/i.test(text)
    ) {
      issues.push(`${surface}: conversation acknowledgement in ${path}`);
    }
    if (
      /^\s*\[(?:system|user|assistant)\]\s*$/im.test(text) &&
      (text.match(/^\s*\[(?:user|assistant)\]\s*$/gim) ?? []).length >= 4
    ) {
      issues.push(`${surface}: conversation transcript in ${path}`);
    }
  }
}

// Use Git's index, not the working directory: private files may legitimately
// exist beside a checkout, but they must not be staged or tracked for release.
const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
for (const path of tracked) inspect(path, 'Git');

const npmArgs = ['pack', '--dry-run', '--ignore-scripts', '--json'];
let npmCli = process.env.npm_execpath;
if (!npmCli && process.platform === 'win32') {
  // Direct `node scripts/check-publication.mjs` has no npm_execpath. Standard
  // Windows installations keep the JS entry point next to node.exe/npm.cmd.
  // Resolve that file instead of running a .cmd shim through a shell.
  npmCli = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]
    .filter(Boolean)
    .map((directory) => resolve(directory, 'node_modules/npm/bin/npm-cli.js'))
    .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
  if (!npmCli) {
    throw new Error('Cannot locate the npm CLI. Run npm run check:publication instead.');
  }
}
const output = execFileSync(
  npmCli ? process.execPath : 'npm',
  npmCli ? [npmCli, ...npmArgs] : npmArgs,
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
);
const packed = JSON.parse(output.slice(output.indexOf('[')))[0];
if (!packed?.files?.length) throw new Error('npm pack reported no files');
for (const { path } of packed.files) {
  inspect(path, 'npm');
  const compiled = /^dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|d\.ts)(?:\.map)?$/.test(path);
  if (!approved.has(path) && !compiled && path !== 'dist/manifest.json') {
    issues.push(`npm: file outside the publication allowlist: ${path}`);
  }
}

if (issues.length) {
  process.stderr.write(
    `Publication check failed:\n${[...new Set(issues)].map((item) => `- ${item}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  // prepack inherits stdout from `npm pack --json`; keep that stream valid JSON.
  process.stderr.write(
    `Publication check passed: ${tracked.length} Git files; ${packed.files.length} npm files.\n`,
  );
}
