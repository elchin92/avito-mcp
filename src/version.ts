import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// dev (tsx): src/version.ts → ../package.json
// build (node): dist/version.js → ../package.json
const pkgRaw = readFileSync(join(here, '..', 'package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw) as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
export const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`;

export function readManifestMetadata(): { schemaHash: string | null; tools: unknown[] } {
  const candidates = [
    join(here, 'manifest.json'),
    join(here, '..', 'dist', 'manifest.json'),
  ];
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        schema_hash?: string;
        tools?: unknown[];
      };
      return { schemaHash: manifest.schema_hash ?? null, tools: manifest.tools ?? [] };
    } catch {
      // Development before generate:manifest; try the next canonical location.
    }
  }
  return { schemaHash: null, tools: [] };
}
