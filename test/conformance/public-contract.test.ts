/**
 * Block E of the plan's §1.2 — the public contract.
 *
 * The requirement is that every document a human or a machine reads to learn
 * WHICH REVISIONS THIS SERVER SPEAKS agrees with the code, and that no text
 * heading for a model names a method the era it is describing has removed.
 *
 * The second half is already guarded on the wire (`test/modern-hardening.test.ts`,
 * "F6 — model-facing text never names a method the era removed"). This file
 * guards the first half, which no test covered: the prose and the machine
 * metadata. Prose drifts silently — nothing fails when a README keeps promising
 * `resources/subscribe` to a 2026 client, or when a fourth era value is added
 * to the config parser and documented in one locale only.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE. `CHANGELOG.md`, `server.json` and
 * `glama.json` do not yet mention the revisions at all. That is not drift, it
 * is sequencing: those three artifacts are version-stamped and are written by
 * the release tasks (M7.4 for the metadata, M3.11/M4.16 for the changelog
 * entry), and `scripts/check-release-version.mjs` already fails a release whose
 * version is not synchronised across all six machine locations. Asserting a
 * revision string in them today would either encode a lie or force a release
 * that this stage is not making. `docs/conformance.md` records them as "не
 * покрыто" with exactly this reason rather than letting a green suite imply a
 * coverage that does not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSION } from '../../src/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const LOCALES = ['README.md', 'README.ru.md'] as const;
/** Every value `AVITO_MCP_PROTOCOL_ERA` accepts, per `src/config.ts`. */
const ERA_VALUES = ['legacy', 'dual', 'modern'] as const;

describe('E — the documented revisions agree with the code', () => {
  it.each(LOCALES)('%s names every revision the code advertises', (locale) => {
    const text = read(locale);
    for (const revision of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(text, `${locale} must name ${revision}`).toContain(revision);
    }
  });

  it.each(LOCALES)('%s documents all three era values', (locale) => {
    const text = read(locale);
    for (const era of ERA_VALUES) {
      expect(text, `${locale} must document era=${era}`).toContain(`\`${era}\``);
    }
    expect(text).toContain('AVITO_MCP_PROTOCOL_ERA');
  });

  it('claims no revision newer than the one the code actually serves', () => {
    // The failure this catches is the aspirational one: a README that promises
    // support for a revision written into prose before it exists in code. Older
    // revisions (2025-06-18 and friends) are deliberately allowed — they appear
    // in the compatibility history, which is a fact, not a promise. ISO dates
    // compare correctly as strings.
    for (const locale of LOCALES) {
      for (const revision of read(locale).match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? []) {
        expect(
          revision <= MODERN_PROTOCOL_VERSION,
          `${locale} claims ${revision}, newer than the served ${MODERN_PROTOCOL_VERSION}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the two locales in revision parity', () => {
    // Not a line-for-line parity check (M7.6 owns that) — parity of the ONE
    // fact this block is about: which revisions each locale claims.
    const revisionsOf = (locale: string): string[] =>
      [...new Set(read(locale).match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? [])].sort();
    expect(revisionsOf('README.ru.md')).toEqual(revisionsOf('README.md'));
  });

  it('documents the era switch in .env.example with the same three values', () => {
    const env = read('.env.example');
    expect(env).toContain('AVITO_MCP_PROTOCOL_ERA');
    for (const era of ERA_VALUES) expect(env).toContain(era);
    expect(env).toContain(MODERN_PROTOCOL_VERSION);
  });

  it('marks the session limits as legacy-only wherever they are documented', () => {
    // These two variables have no meaning on the modern leg — the revision
    // removed sessions. An operator reading either README must not size a 2026
    // deployment with them.
    for (const locale of [...LOCALES, '.env.example']) {
      const text = read(locale);
      const index = text.indexOf('AVITO_MCP_HTTP_MAX_SESSIONS');
      expect(index, `${locale} must document AVITO_MCP_HTTP_MAX_SESSIONS`).toBeGreaterThan(-1);
      const nearby = text.slice(Math.max(0, index - 700), index + 700);
      expect(
        /legacy|2025-11-25/i.test(nearby),
        `${locale}: sessions must be scoped to the legacy era`,
      ).toBe(true);
    }
  });

  it('documents the quantitative limits that replaced them on the modern leg', () => {
    for (const locale of [...LOCALES, '.env.example']) {
      const text = read(locale);
      expect(text, locale).toContain('AVITO_MCP_HTTP_MAX_INFLIGHT');
      expect(text, locale).toContain('AVITO_MCP_HTTP_MAX_STREAMS');
    }
  });

  it('keeps the package metadata self-consistent', () => {
    const pkg = JSON.parse(read('package.json')) as {
      name: string;
      version: string;
      mcpName: string;
    };
    const server = JSON.parse(read('server.json')) as {
      name: string;
      version: string;
      packages: Array<{ identifier: string; version: string }>;
    };
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    for (const entry of server.packages) {
      expect(entry.identifier).toBe(pkg.name);
      expect(entry.version).toBe(pkg.version);
    }
  });

  it('never advertises a removed method as a live capability in either README', () => {
    // The 2026 sections specifically: the legacy sections may (and must) keep
    // naming `resources/subscribe`, because on that era it still exists.
    for (const locale of LOCALES) {
      const text = read(locale);
      for (const removed of [
        'resources/subscribe',
        'resources/unsubscribe',
        'logging/setLevel',
        'ping',
      ]) {
        // Backticked only: these are method names, and prose words like
        // "shipping" or "ping me to approve" are not claims about the protocol.
        const occurrences = [
          ...text.matchAll(new RegExp(`\`${removed.replace('/', '\\/')}\``, 'g')),
        ];
        for (const match of occurrences) {
          const context = text.slice(Math.max(0, match.index - 400), match.index + 400);
          expect(
            /2025-11-25|legacy|устарел|deprecated|removed|удал|заменён|replaced|subscriptions\/listen/i.test(
              context,
            ),
            `${locale}: "${removed}" is mentioned without saying which era it belongs to`,
          ).toBe(true);
        }
      }
    }
  });
});
