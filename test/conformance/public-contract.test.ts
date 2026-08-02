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
 * WHAT IS ASSERTED ELSEWHERE, AND WHY IT IS NOT HERE. `CHANGELOG.md`,
 * `server.json` and `glama.json` are version-stamped artifacts, so their
 * revision claims are checked next to the release gate that stamps them —
 * `test/release-hardening.test.ts`, rows E8 and E9 of `docs/conformance.md`.
 * That split is deliberate: `scripts/check-release-version.mjs` already fails a
 * release whose version is not synchronised across all six machine locations,
 * and a claim about a released artifact belongs beside the check that releases
 * it. An earlier version of this header said those three files "do not yet
 * mention the revisions at all" and pointed at "не покрыто" rows that no longer
 * exist; the rows went green and the paragraph did not, which is exactly the
 * prose drift this file exists to catch one level up.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * `SECURITY.md` is the surface of block E that no test reached, and the one
 * where being out of date is not merely untidy. A security policy is read by
 * someone deciding whether what they found is worth reporting; a policy still
 * describing a threat model the code left behind trains that person to file
 * the wrong thing, or nothing.
 *
 * Every assertion below re-derives its expectation from `src/`, never from a
 * neighbouring sentence in the same document. A number quoted in prose that no
 * longer matches the parser is the failure mode, so the numbers are read out of
 * the parser.
 */
describe('M7.3 — SECURITY.md describes the threat model this code actually has', () => {
  const security = read('SECURITY.md');
  const config = read('src/config.ts');
  const pending = read('src/core/pending-actions.ts');
  const provider = read('src/http/oauth/provider.ts');

  /** The default `parsePositiveInt` gives a variable, read from the parser. */
  const defaultOf = (variable: string): string => {
    const found = new RegExp(
      `parsePositiveInt\\(\\s*process\\.env\\.${variable},\\s*([\\d_]+)`,
    ).exec(config);
    expect(found, `src/config.ts no longer parses ${variable} this way`).not.toBeNull();
    return found![1]!.replace(/_/g, '');
  };

  it('names every principal form callerPrincipal() can actually return', () => {
    // The three branches are the whole of caller identity on a sessionless
    // revision, and the document's claim is that it lists them. Extracted from
    // the function rather than listed here, so adding a fourth branch — or
    // renaming the stdio fallback — turns the document red instead of leaving
    // it quietly incomplete.
    const body = /export function callerPrincipal\([\s\S]*?\n}/.exec(pending)?.[0];
    expect(body, 'callerPrincipal() is no longer where this claim was checked').toBeDefined();
    const forms = [...body!.matchAll(/`(oauth|bearer|session):/g)].map((match) => match[1]!);
    expect(new Set(forms).size, 'expected three principal forms to check against').toBe(3);
    for (const form of new Set(forms)) {
      expect(security, `SECURITY.md does not name the ${form}: principal`).toContain(`${form}:`);
    }
    expect(security).toContain('callerPrincipal()');
    expect(security).toContain('src/core/pending-actions.ts');
  });

  it('never calls a session hijackable without saying which era still has sessions', () => {
    // The rewrite this file guards. "session-hijacking attacks on the
    // Streamable HTTP transport" was true of 1.3.3 and is false of the 2026
    // leg, where there is no session to hijack — and it is the sentence a
    // reporter would have aimed at.
    // Scoped to the LINE that carries the word, not to a window around it. A
    // window is what let the first version of this assertion pass while the
    // stale sentence was still in the file: the bullet immediately below it
    // said "state handle", 200 characters away, and vouched for its neighbour.
    // A claim about the threat is made by the sentence making it.
    const mentions = security
      .split('\n')
      .filter((line) => /hijack/i.test(line));
    expect(mentions.length, 'the threat is not named at all').toBeGreaterThan(0);
    for (const line of mentions) {
      expect(
        /2025-11-25|legacy|state handle|confirmation_id/i.test(line),
        `"${line.trim()}" names hijacking without saying whether it is the legacy session or the state handle`,
      ).toBe(true);
    }
    expect(security).toMatch(/State handle hijacking/i);
    expect(security).toMatch(/[Pp]ossession of a handle is not authentication/);
  });

  it('states the handle bounds with the numbers the code uses, and the bound it does not have', () => {
    const entropyBytes = /const id = randomBytes\((\d+)\)/.exec(pending)?.[1];
    expect(entropyBytes, 'the pending id is no longer minted with randomBytes').toBeDefined();
    expect(security, 'SECURITY.md must state the entropy in bits').toContain(
      `${Number(entropyBytes) * 8} bits`,
    );
    expect(security).toContain('AVITO_MCP_CONFIRMATION_TTL_SEC');
    expect(security).toContain(defaultOf('AVITO_MCP_CONFIRMATION_TTL_SEC'));
    expect(security).toContain('AVITO_MCP_CONFIRMATION_SECRET');
    expect(security).toContain('AVITO_MCP_APPROVAL_MODE=external');
    // The honest half. `meta_confirm_action` does not compare the confirming
    // principal with `pending.initiator` outside external-approval mode, and a
    // policy that implied it did would be the worst kind of wrong.
    expect(security).toMatch(/does \*\*not\*\*\s*\n?\s*require the confirming principal/);
  });

  it('names the four server MUSTs and resolves the module claimed for each', () => {
    for (const obligation of [
      'Validate all tool inputs',
      'Implement proper access controls',
      'Rate limit tool invocations',
      'Sanitize tool outputs',
    ]) {
      expect(security, `SECURITY.md does not name the MUST "${obligation}"`).toContain(obligation);
    }
    // Every repository path the document offers as an implementation must be a
    // path this repository has. A policy pointing at a module that was renamed
    // sends a reporter to a file that is not there.
    const paths = [...security.matchAll(/`((?:src|test|docs|scripts|deploy)\/[\w./-]+)`/g)].map(
      (match) => match[1]!,
    );
    expect(paths.length, 'SECURITY.md names no module at all').toBeGreaterThan(4);
    for (const path of new Set(paths)) {
      expect(existsSync(join(root, path)), `SECURITY.md names ${path}, which does not exist`).toBe(
        true,
      );
    }
  });

  it('names the surfaces the revision added and the limits that bound them', () => {
    expect(security).toContain('subscriptions/listen');
    expect(security).toContain('src/core/subscriptions.ts');
    expect(security).toContain('_meta');
    for (const code of ['-32602', '-32020', '-32021', '-32022']) {
      expect(security, `SECURITY.md does not mention ${code}`).toContain(code);
    }
    for (const variable of ['AVITO_MCP_HTTP_MAX_INFLIGHT', 'AVITO_MCP_HTTP_MAX_STREAMS']) {
      expect(security, `SECURITY.md does not name ${variable}`).toContain(variable);
      expect(
        security,
        `SECURITY.md quotes a default for ${variable} that src/config.ts does not parse`,
      ).toContain(defaultOf(variable));
    }
    // And the retired pair must be named as retired, not silently dropped: an
    // operator sizing a 2026 deployment with them is the failure.
    const index = security.indexOf('AVITO_MCP_HTTP_MAX_SESSIONS');
    expect(index, 'SECURITY.md must say what happened to the session limits').toBeGreaterThan(-1);
    expect(security.slice(index, index + 400)).toMatch(/bound[s]? nothing|legacy/i);
  });

  it('draws the stdio trust boundary and cites the ADR that owns the era pin', () => {
    expect(security).toMatch(/no authentication/i);
    expect(security).toContain('AVITO_MCP_HTTP_AUTH=oauth');
    const adr = 'docs/adr/0001-protocol-era-limitations.md';
    expect(security, 'the era pin must be cited, not paraphrased').toContain(adr);
    // Cited as a decision, so it has to still BE one.
    expect(read(adr)).toMatch(/^Status:\s*accepted/m);
  });

  it('records the DCR/CIMD decision with the limits the provider enforces', () => {
    expect(security).toMatch(/Client ID Metadata Documents/i);
    expect(security).toMatch(/SSRF/);
    const dcrBytes = /const MAX_DCR_BYTES = (\d+) \* 1024/.exec(provider)?.[1];
    expect(dcrBytes, 'MAX_DCR_BYTES is no longer declared this way').toBeDefined();
    expect(security).toContain(`${dcrBytes} KiB`);
    const redirectBound = /redirect_uris\.length > (\d+)/.exec(provider)?.[1];
    expect(redirectBound, 'the redirect_uris bound moved').toBeDefined();
    expect(security).toContain(`1 and ${redirectBound} entries`);
    expect(security).toContain('application_type');
  });

  it('keeps the token-store risk acceptance the storage decision rests on', () => {
    // M5.9 shipped this section; it is asserted here so a later tidy-up of the
    // document cannot drop the one place the accepted risk is written down.
    const adr = 'docs/adr/0006-token-storage.md';
    expect(security).toContain('AVITO_MCP_OAUTH_STORE_FILE');
    expect(security).toContain(adr);
    expect(read(adr)).toMatch(/^Status:\s*accepted/m);
  });
});
