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
