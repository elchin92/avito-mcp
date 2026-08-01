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

/**
 * M3.1 — the protocol revisions this server declares support for, newest first
 * (order = preference).
 *
 * This constant is OURS on purpose. The v2 SDK deliberately publishes no
 * `"2026-07-28"` constant: `LATEST_PROTOCOL_VERSION` in
 * `@modelcontextprotocol/core` is still `"2025-11-25"` (the legacy value used by
 * the `initialize` handshake) and the modern revision lives in an internal
 * `MODERN_WIRE_REVISION` marked "Internal only — deliberately NOT a public
 * constant (G-D2-4)". The SDK keeps two disjoint lists — the legacy
 * `SUPPORTED_PROTOCOL_VERSIONS` for `initialize` and an internal modern list for
 * `server/discover` — so that "adding a revision here can never leak a modern
 * version string into a 2025-era handshake".
 *
 * Consequences for this codebase:
 *   • The era of a live connection is NEVER decided by comparing against these
 *     strings. It is decided by the SDK (`ProtocolEra`, `server/discover`,
 *     `isLegacyRequest`) — see `src/http/mcp-http.ts` and `src/server.ts`.
 *   • This list is the single source of truth for what we *advertise*: the
 *     `data.supported` payload of a future `-32022` (M3.5) and any
 *     documentation of supported revisions.
 *   • `test/protocol-era.test.ts` asserts every entry here is known to the SDK,
 *     so the list can never drift into advertising a revision the SDK cannot
 *     actually speak.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'] as const;

/** One of the protocol revisions named in {@link SUPPORTED_PROTOCOL_VERSIONS}. */
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

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
