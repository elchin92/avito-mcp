#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import GithubSlugger from 'github-slugger';

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const publicFiles = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const published = new Set(publicFiles);
const files = publicFiles.filter((path) => path.endsWith('.md'));
const documents = new Map();
const problems = [];

function visit(node, fn) {
  fn(node);
  for (const child of node.children ?? []) visit(child, fn);
}

function plainText(node) {
  if (node.type === 'html') return '';
  return node.value ?? node.alt ?? (node.children ?? []).map(plainText).join('');
}

function document(path) {
  if (documents.has(path)) return documents.get(path);
  const tree = fromMarkdown(readFileSync(path, 'utf8'));
  const anchors = new Set();
  const definitions = new Map();
  const slugger = new GithubSlugger();
  visit(tree, (node) => {
    if (node.type === 'heading') anchors.add(slugger.slug(plainText(node)));
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/\b(?:id|name)=["']([^"']+)["']/g))
        anchors.add(match[1]);
    }
  });
  const result = { tree, anchors, definitions };
  documents.set(path, result);
  return result;
}

let links = 0;
for (const file of files) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue; // A staged deletion has no document to inspect.
  const parsed = document(path);
  visit(parsed.tree, (node) => {
    const image = node.type === 'image' || node.type === 'imageReference';
    if (!['link', 'linkReference', 'image', 'imageReference'].includes(node.type)) return;
    const location = `${file}:${node.position?.start.line ?? 1}`;
    if (image && !node.alt?.trim()) problems.push(`${location}: image needs descriptive alt text`);
    const url = node.url ?? parsed.definitions.get(node.identifier);
    if (!url) {
      problems.push(`${location}: unresolved link reference`);
      return;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return;
    links++;
    const [targetPart, fragment] = url.split('#', 2);
    let target;
    let anchor;
    try {
      const decoded = decodeURIComponent(targetPart.split('?', 1)[0]);
      target = decoded
        ? resolve(decoded.startsWith('/') ? root : dirname(path), decoded.replace(/^\//, ''))
        : path;
      anchor = fragment ? decodeURIComponent(fragment) : '';
    } catch {
      problems.push(`${location}: invalid URL encoding`);
      return;
    }
    if (relative(root, target).startsWith('..') || !existsSync(target)) {
      problems.push(`${location}: missing local target ${url}`);
      return;
    }
    const repositoryPath = relative(root, target).replaceAll('\\', '/');
    if (
      !published.has(repositoryPath) &&
      !publicFiles.some((entry) => entry.startsWith(repositoryPath + '/'))
    ) {
      problems.push(`${location}: target is not a public repository file ${url}`);
      return;
    }
    if (
      anchor &&
      extname(target).toLowerCase() === '.md' &&
      statSync(target).isFile() &&
      !document(target).anchors.has(anchor)
    ) {
      problems.push(`${location}: missing section ${url}`);
    }
  });
}

if (problems.length) {
  process.stderr.write(
    `Documentation checks failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Documentation checked: ${files.length} Markdown files, ${links} local links and anchors.\n`,
  );
}
