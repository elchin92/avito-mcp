#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const [packageJson, baseEnv, remoteEnv, outputFile] = process.argv.slice(2);
if (!packageJson || !baseEnv || !remoteEnv || !outputFile) {
  process.stderr.write(
    'Usage: render-service-env.mjs <release-package.json> <base.env> <remote.env> <output>\n',
  );
  process.exit(2);
}

const require = createRequire(packageJson);
const { parse } = require('dotenv');
const base = parse(readFileSync(baseEnv));
const remote = parse(readFileSync(remoteEnv));
const merged = { ...base, ...remote };

// Match config.ts aliases exactly. A deployed API server must not silently start
// in introspection-only mode because a credential line was malformed or filtered.
const credentials = [
  remote.Client_id ?? remote.CLIENT_ID ?? base.Client_id ?? base.CLIENT_ID,
  remote.Client_secret ?? remote.CLIENT_SECRET ?? base.Client_secret ?? base.CLIENT_SECRET,
  remote.Profile_id ?? remote.PROFILE_ID ?? base.Profile_id ?? base.PROFILE_ID,
];
if (credentials.some((value) => typeof value !== 'string' || value.trim() === '')) {
  throw new Error('Deployment requires Client_id, Client_secret, and Profile_id');
}

// Canonicalize aliases so an override using the other supported spelling cannot
// leave two conflicting variables for config.ts to resolve in the wrong order.
for (const key of [
  'Client_id',
  'Client_secret',
  'Profile_id',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'PROFILE_ID',
]) {
  delete merged[key];
}
[merged.Client_id, merged.Client_secret, merged.Profile_id] = credentials;

const serviceStateDirectory = '/var/lib/avito-mcp';
for (const key of [
  'AVITO_TOKEN_FILE',
  'AVITO_MCP_OAUTH_STORE_FILE',
  'AVITO_MCP_WEBHOOK_LOG_FILE',
]) {
  const value = merged[key];
  if (typeof value !== 'string' || value === '') continue;
  const resolved = resolve(value);
  const rel = relative(serviceStateDirectory, resolved);
  if (
    !isAbsolute(value) ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`${key} must be an absolute file path inside ${serviceStateDirectory}`);
  }
}

const exactKeys = new Set([
  'Client_id',
  'Client_secret',
  'Profile_id',
  'AVITO_BASE_URL',
  'AVITO_TOKEN_FILE',
  'AVITO_SAFE_MODE',
  'LOG_LEVEL',
]);
const allowed = (key) =>
  exactKeys.has(key) ||
  (/^AVITO_MCP_[A-Za-z0-9_]+$/.test(key) && key !== 'AVITO_MCP_DEPLOY_HEALTH_URL');

const quote = (value, key) => {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (containsControlCharacter) {
    throw new Error(`${key} contains a control character and cannot enter EnvironmentFile`);
  }
  // With C0/DEL rejected, JSON.stringify only escapes quote/backslash and is
  // compatible with systemd's double-quoted EnvironmentFile grammar.
  return JSON.stringify(value);
};

const portValue = (merged.AVITO_MCP_HTTP_PORT ?? '3000').trim();
if (!/^[1-9]\d*$/.test(portValue) || Number(portValue) > 65_535) {
  throw new Error('AVITO_MCP_HTTP_PORT must be an integer from 1 to 65535');
}
const bindHost = (merged.AVITO_MCP_HTTP_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const probeHost = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost === '::' ? '::1' : bindHost;
const urlHost = isIP(probeHost) === 6 ? `[${probeHost}]` : probeHost;

const lines = Object.entries(merged)
  .filter(([key]) => allowed(key))
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}=${quote(value, key)}`);
writeFileSync(outputFile, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

process.stdout.write(`http://${urlHost}:${portValue}`);
