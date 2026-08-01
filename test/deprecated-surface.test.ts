/**
 * M0.4 — guard against reintroducing deprecated MCP surfaces.
 *
 * The MCP revision 2026-07-28 keeps a registry of Deprecated features:
 * https://modelcontextprotocol.io/specification/2026-07-28/deprecated
 *
 * Four of its rows are things this server has never used, and must not start
 * using while the migration is in flight: Roots, Sampling, the
 * `includeContext` values "thisServer" / "allServers", and the HTTP+SSE
 * transport. Adopting any of them now buys a feature with a known removal
 * date and an already-published migration path.
 *
 * This test freezes that status quo: at the time it was written, every grep
 * below was empty in `src/`.
 *
 * How it looks: the file is parsed with the TypeScript parser, and only
 * *code* tokens are inspected — identifiers, string literals and template
 * literal chunks. Comments are trivia and are deliberately NOT scanned, for
 * two reasons: (1) the ban has to be explainable where it applies, and a
 * guard that forbids writing "do not add sampling/createMessage here" in a
 * comment would forbid documenting itself; (2) matching raw text would make
 * the rule depend on prose, so a doc-comment quoting the spec would break the
 * build while the actual wire surface stayed clean. Parsing instead of
 * regexing the raw source also means a `//` inside a URL string cannot
 * silently truncate a line and hide a real violation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REGISTRY = 'https://modelcontextprotocol.io/specification/2026-07-28/deprecated';

interface Rule {
  /** Registry row this rule protects. */
  readonly feature: string;
  /** What to do instead, per the registry's migration column. */
  readonly migration: string;
  /** Exact identifier names (the SDK-level spelling of the feature). */
  readonly identifiers?: readonly string[];
  /** String / template literals whose full text equals one of these. */
  readonly literalEquals?: readonly string[];
  /** String / template literals containing one of these (wire method names, module specifiers). */
  readonly literalContains?: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    feature: 'Sampling (`sampling/createMessage`) — Deprecated in 2026-07-28 by SEP-2577',
    migration:
      'integrate with an LLM provider directly; a server that needs something back from the caller uses the multi round-trip request pattern, not a server-initiated request',
    identifiers: ['createMessage'],
    literalContains: ['sampling/createMessage'],
  },
  {
    feature: 'Roots (`roots/list`) — Deprecated in 2026-07-28 by SEP-2577',
    migration:
      'pass directories and files through tool parameters, resource URIs or server configuration (avito-mcp already does this via AVITO_MCP_ALLOWED_UPLOAD_DIRS)',
    identifiers: ['listRoots'],
    // Also catches `notifications/roots/list_changed`, which 2026-07-28 removed outright.
    literalContains: ['roots/list'],
  },
  {
    feature: '`includeContext: "thisServer" | "allServers"` — Deprecated by SEP-2596',
    migration:
      'omit the field or use "none" — but note the field only exists on Sampling requests, which this server does not send at all',
    identifiers: ['includeContext'],
    literalEquals: ['thisServer', 'allServers'],
  },
  {
    feature: 'HTTP+SSE transport — Deprecated by SEP-2596 (soft-deprecated since 2025-03-26)',
    migration:
      'use the Streamable HTTP transport, which src/http/mcp-http.ts already uses (StreamableHTTPServerTransport)',
    identifiers: ['SSEServerTransport'],
    literalContains: ['server/sse.js', 'client/sse.js'],
  },
  {
    // M2: added when the server moved onto the @modelcontextprotocol/*@2 line.
    // In test/ and scripts/ a leftover v1 specifier is caught by tsc (the
    // package is gone, so TS2307), but src/ is the half where a v1 path could
    // still resolve through a transitive copy and quietly pull in a second,
    // incompatible set of protocol types.
    feature: 'The retired v1 SDK package `@modelcontextprotocol/sdk`',
    migration:
      'import from the v2 line — @modelcontextprotocol/{core,server,node,express,client}; the frozen authorization-server helpers live in @modelcontextprotocol/server-legacy/auth',
    literalContains: ['@modelcontextprotocol/sdk'],
  },
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly token: string;
  readonly rule: Rule;
}

/** Collect every `.ts` file under a directory, sorted for deterministic output. */
function collectSources(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, root, out);
    else if (entry.name.endsWith('.ts')) out.push(relative(root, full));
  }
  return out;
}

function matchRule(rule: Rule, kind: 'identifier' | 'literal', text: string): boolean {
  if (kind === 'identifier') return (rule.identifiers ?? []).includes(text);
  if ((rule.literalEquals ?? []).includes(text)) return true;
  return (rule.literalContains ?? []).some((needle) => text.includes(needle));
}

/**
 * Parse one source and report code tokens hitting a rule.
 * Exported shape kept tiny on purpose: the scanner is itself under test below.
 */
function scanSource(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Violation[] = [];

  const visit = (node: ts.Node): void => {
    const token: { kind: 'identifier' | 'literal'; text: string } | undefined =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
        ? { kind: 'identifier', text: node.text }
        : ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
          ? { kind: 'literal', text: node.text }
          : undefined;

    if (token !== undefined) {
      for (const rule of RULES) {
        if (!matchRule(rule, token.kind, token.text)) continue;
        const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
        found.push({ file, line: line + 1, token: token.text, rule });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** One readable line per violation — this is what a failing diff shows. */
const format = (v: Violation): string =>
  `${v.file}:${v.line} uses "${v.token}" — ${v.rule.feature}`;

function report(violations: readonly Violation[]): string {
  return [
    'Deprecated MCP surface reintroduced in src/:',
    ...violations.map((v) => `  ${format(v)}\n      instead: ${v.rule.migration}`),
    '',
    `Deprecated registry: ${REGISTRY}`,
    'Rule and rationale: CONTRIBUTING.md → "Deprecated MCP surfaces".',
    'If a deliberate exception is ever needed, change the rule here in the same PR and say why.',
  ].join('\n');
}

const root = resolve(import.meta.dirname, '..');
const srcRoot = resolve(root, 'src');
const sources = collectSources(srcRoot, root);

describe('deprecated MCP surfaces (2026-07-28 registry)', () => {
  it('scans the whole of src/', () => {
    // A guard that silently scans nothing is worse than no guard.
    expect(sources.length).toBeGreaterThan(30);
    expect(sources).toContain('src/server.ts');
    expect(sources).toContain('src/http/mcp-http.ts');
    expect(sources).toContain('src/build-server.ts');
  });

  it('does not reference Roots, Sampling, deprecated includeContext values, HTTP+SSE or the v1 SDK', () => {
    const violations = sources.flatMap((file) =>
      scanSource(file, readFileSync(resolve(root, file), 'utf8')),
    );
    expect(violations.map(format), report(violations)).toEqual([]);
  });

  describe('the scanner itself', () => {
    it('flags each forbidden surface in code', () => {
      const cases: readonly [string, string][] = [
        ['sampling', 'const r = await server.server.createMessage({ messages: [] });'],
        ['sampling wire name', 'server.setRequestHandler("sampling/createMessage", handler);'],
        ['roots', 'const r = await server.server.listRoots();'],
        ['roots wire name', 'client.request({ method: "roots/list" });'],
        ['includeContext field', 'const p = { includeContext: "none" };'],
        ['includeContext value', 'const p = { fld: "thisServer" };'],
        ['includeContext value', 'const p = { fld: "allServers" };'],
        ['SSE transport', 'const t = new SSEServerTransport("/messages", res);'],
        ['SSE module', 'import { X } from "@modelcontextprotocol/sdk/server/sse.js";'],
        ['v1 SDK package', 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";'],
        ['v1 SDK dynamic import', 'const m = await import("@modelcontextprotocol/sdk/types.js");'],
        ['template literal', 'const m = `sampling/createMessage`;'],
      ];
      for (const [label, code] of cases) {
        expect(scanSource('src/synthetic.ts', code), label).not.toEqual([]);
      }
    });

    it('ignores mentions in comments, so the ban stays documentable', () => {
      const commented = [
        '// Never add sampling/createMessage or roots/list here.',
        '/* listRoots and SSEServerTransport are deprecated; see the registry. */',
        '/** includeContext: "thisServer" / "allServers" are deprecated values. */',
        'export const ok = 1;',
      ].join('\n');
      expect(scanSource('src/synthetic.ts', commented)).toEqual([]);
    });

    it('does not fire on the filesystem-root vocabulary already used in src/', () => {
      // upload-guard.ts talks about roots of the allowed upload directories.
      const code = 'const expectedRootStat = await stat(allowedRoot); const roots = [allowedRoot];';
      expect(scanSource('src/synthetic.ts', code)).toEqual([]);
    });
  });
});
