#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = resolve(import.meta.dirname, '..');
const schemaPath = resolve(import.meta.dirname, 'schemas/mcp-server-2025-12-11.schema.json');
const bytes = readFileSync(schemaPath);
const expectedDigest = '3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0';
if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
  throw new Error(
    'Vendored registry schema changed; review its source and update the pinned digest.',
  );
}
const schema = JSON.parse(bytes.toString('utf8'));
// This is the registry's unmodified draft-07 schema. Strict authoring checks are
// disabled because the upstream schema uses union types; validation, formats and
// all schema keywords remain enabled. No remote schemas are loaded.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const manifest = JSON.parse(
  readFileSync(resolve(process.argv[2] ?? resolve(root, 'server.json')), 'utf8'),
);
if (!validate(manifest)) {
  process.stderr.write(
    `Invalid MCP Registry manifest:\n${ajv.errorsText(validate.errors, { separator: '\n' })}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('MCP Registry manifest validates against the pinned 2025-12-11 schema.\n');
}
