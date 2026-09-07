#!/usr/bin/env node
// Render the real offline walkthrough output as a readable README illustration.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = execFileSync(process.execPath, [resolve(root, 'dist/server.js'), '--demo'], {
  encoding: 'utf8',
});
const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const lines = output.trimEnd().split('\n');
const height = 90 + lines.length * 27;
const body = lines
  .map(
    (line, index) =>
      `<text x="28" y="${82 + index * 27}" fill="${index > 7 && index < 11 ? '#83e1b4' : '#d5deef'}">${escape(line)}</text>`,
  )
  .join('\n');
mkdirSync(resolve(root, 'docs/assets'), { recursive: true });
writeFileSync(
  resolve(root, 'docs/assets/demo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="${height}" viewBox="0 0 1040 ${height}" role="img" aria-labelledby="title desc">
<title id="title">Avito MCP local demo</title>
<desc id="desc">${escape(output.trim())}</desc>
<rect width="1040" height="${height}" rx="16" fill="#101827"/>
<g font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="16">
<text x="28" y="35" fill="#91baff">$ npx -y avito-mcp@2 --demo</text>
${body}
</g></svg>\n`,
);
process.stdout.write('Rendered docs/assets/demo.svg from the local walkthrough.\n');
