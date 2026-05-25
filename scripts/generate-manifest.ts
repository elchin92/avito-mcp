/**
 * Build `dist/manifest.json` — a structured catalogue of every MCP tool the
 * server exposes, with risk classification and grouping. Used by:
 *   - Documentation that needs an up-to-date tool count / list (CI can grep this)
 *   - Programmatic consumers (an MCP-aware agent runtime can read the manifest
 *     before connecting to decide which tools to expose to its model)
 *   - Tests that assert invariants on the registry as a whole
 *
 * Run: `npm run generate:manifest`
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { AvitoClient } from '../src/core/client.js';
import { domains } from '../src/meta/domain-registry.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';
import { PACKAGE_NAME, VERSION } from '../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(here, '..', 'dist', 'manifest.json');

const KNOWN_DOMAIN_PREFIXES = [
  'auth',
  'autoload',
  'calltracking',
  'cpa_auction',
  'cpa_target',
  'cpa',
  'delivery',
  'hierarchy',
  'items',
  'meta',
  'messenger',
  'msg_discounts',
  'orders',
  'promotion',
  'reviews',
  'stock',
  'tariffs',
  'trxpromo',
  'user',
];

function domainOf(name: string): string {
  for (const d of KNOWN_DOMAIN_PREFIXES) {
    if (name === d || name.startsWith(`${d}_`)) return d;
  }
  return 'unknown';
}

function makeFakeConfig(): Config {
  return {
    clientId: 'manifest-only',
    clientSecret: 'manifest-only',
    profileId: 1,
    baseUrl: 'https://api.avito.ru',
    tokenFile: pathJoin(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    // Full surface: show every tool that could ever be exposed.
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: true,
    allowedUploadDirs: [tmpdir()],
    maxUploadMb: 15,
    // Turn on confirmation so meta_confirm_action / meta_cancel_action / meta_list_pending_actions
    // are included in the manifest — they exist only when confirmation is enabled.
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    confirmationSecret: undefined,
    maxBinaryMb: 20,
  };
}

async function main(): Promise<void> {
  const server = new McpServer({ name: PACKAGE_NAME, version: VERSION });
  const cfg = makeFakeConfig();
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const ctx: ToolContext = { client: new AvitoClient(cfg), config: cfg, pendingStore };
  for (const register of domains) register(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'manifest-builder', version: VERSION }, { capabilities: {} });
  await client.connect(b);

  const { tools } = await client.listTools();
  await client.close();
  await server.close();

  type Risk = 'sensitive' | 'read' | 'write' | 'money' | 'public' | 'unknown';
  const byRisk: Record<Risk, string[]> = {
    sensitive: [],
    read: [],
    write: [],
    money: [],
    public: [],
    unknown: [],
  };
  const byDomain: Record<string, string[]> = {};
  const flat: Array<{
    name: string;
    title?: string;
    domain: string;
    risk: Risk;
    environment: string;
    accessesLocalFiles?: boolean;
    description: string;
    annotations: unknown;
  }> = [];

  for (const t of tools) {
    const meta = (t._meta ?? {}) as {
      risk?: string;
      environment?: string;
      accessesLocalFiles?: boolean;
    };
    const risk = (meta.risk ?? 'unknown') as Risk;
    const environment = meta.environment ?? 'prod';
    const dom = domainOf(t.name);
    byRisk[risk].push(t.name);
    byDomain[dom] = byDomain[dom] ?? [];
    byDomain[dom].push(t.name);
    const entry: (typeof flat)[number] = {
      name: t.name,
      domain: dom,
      risk,
      environment,
      description: t.description ?? '',
      annotations: t.annotations ?? null,
    };
    // v0.6.0: title — необязательное человекочитаемое имя.
    if (typeof t.title === 'string' && t.title.length > 0) entry.title = t.title;
    if (meta.accessesLocalFiles) entry.accessesLocalFiles = true;
    flat.push(entry);
  }
  for (const arr of Object.values(byRisk)) arr.sort();
  for (const arr of Object.values(byDomain)) arr.sort();
  flat.sort((a, b) => (a.name < b.name ? -1 : 1));

  const manifest = {
    $schema: 'https://json.schemastore.org/package',
    name: PACKAGE_NAME,
    version: VERSION,
    generated_at: new Date().toISOString(),
    tool_count: tools.length,
    counts_by_risk: {
      sensitive: byRisk.sensitive.length,
      read: byRisk.read.length,
      write: byRisk.write.length,
      money: byRisk.money.length,
      public: byRisk.public.length,
      unknown: byRisk.unknown.length,
    },
    counts_by_domain: Object.fromEntries(
      Object.entries(byDomain).map(([k, v]) => [k, v.length]),
    ),
    by_risk: byRisk,
    by_domain: byDomain,
    tools: flat,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const unknownCount = byRisk.unknown.length;
  process.stdout.write(
    `Wrote ${OUT_PATH}\n` +
      `  tools:     ${tools.length}\n` +
      `  sensitive: ${byRisk.sensitive.length}\n` +
      `  read:      ${byRisk.read.length}\n` +
      `  write:     ${byRisk.write.length}\n` +
      `  money:     ${byRisk.money.length}\n` +
      `  public:    ${byRisk.public.length}\n` +
      `  unknown:   ${unknownCount}\n`,
  );
  if (unknownCount > 0) {
    process.stderr.write(
      `WARNING: ${unknownCount} tool(s) without a risk classification — these will default to 'write' but should be tagged explicitly:\n` +
        byRisk.unknown.map((n) => `  - ${n}`).join('\n') +
        '\n',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`generate-manifest failed: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
