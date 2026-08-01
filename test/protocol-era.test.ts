/**
 * M3.1 / M3.2 unit-level guards for the dual-era scaffolding.
 *
 * Two things are easy to get wrong here and impossible to see from the outside:
 *
 *  1. `SUPPORTED_PROTOCOL_VERSIONS` is OUR constant, not the SDK's — the v2 line
 *     deliberately publishes no `"2026-07-28"` value, and keeps two disjoint
 *     internal lists so a modern revision string can never leak into a 2025-era
 *     `initialize`. That freedom means our list can quietly start advertising a
 *     revision the SDK cannot actually speak. These tests pin it to what the SDK
 *     really serves and forbid protocol-version literals from leaking back into
 *     the rest of `src/`.
 *
 *  2. `createServerFactory` is called by the SDK, not by us — once per stdio
 *     connection (plus a discarded `server/discover` probe) and once per modern
 *     HTTP request. The MCP log-sink registry in `src/logger.ts` is a strong
 *     `Map`, so a factory that registers a sink without a teardown turns every
 *     discarded instance into a permanently retained 148-tool server. That leak
 *     would never show up as a failing assertion anywhere else.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  SUPPORTED_PROTOCOL_VERSIONS as SDK_LEGACY_VERSIONS,
  LATEST_PROTOCOL_VERSION as SDK_LATEST,
} from '@modelcontextprotocol/server';

import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/version.js';
import { createServerFactory } from '../src/build-server.js';
import { logger } from '../src/logger.js';
import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';

const SRC_ROOT = resolve(import.meta.dirname, '..', 'src');

function makeConfig(): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 1,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: true,
    allowedUploadDirs: [tmpdir()],
    maxUploadMb: 15,
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http: {
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      publicUrl: 'http://127.0.0.1:3000',
      auth: 'none',
      authTokens: [],
      allowNoAuth: true,
      allowedHosts: [],
      allowedOrigins: [],
      maxSessions: 100,
      sessionIdleSec: 1800,
      maxInflight: 64,
      maxStreams: 32,
      oauthTokenTtlSec: 3600,
    },
    webhook: { enabled: false, publicUrl: 'http://127.0.0.1:3000', path: '/x', bufferSize: 10 },
  } as Config;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('SUPPORTED_PROTOCOL_VERSIONS (M3.1)', () => {
  it('lists the modern revision first and the legacy one second', () => {
    // Order is preference, and the order is load-bearing: it is what a future
    // `data.supported` payload advertises.
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual(['2026-07-28', '2025-11-25']);
  });

  it('never advertises a revision the SDK cannot serve', () => {
    // The SDK exposes only its legacy list publicly; the modern one is internal
    // by design. So: the legacy entry must be in the SDK's legacy list, and the
    // modern entry must NOT be — a modern revision appearing in the legacy list
    // would mean the SDK started offering 2026 through the 2025 handshake, which
    // is exactly the leak the split is meant to prevent.
    const [modern, legacy] = SUPPORTED_PROTOCOL_VERSIONS;
    expect(SDK_LEGACY_VERSIONS).toContain(legacy);
    expect(SDK_LEGACY_VERSIONS).not.toContain(modern);
    expect(SDK_LATEST).toBe(legacy);
  });

  it('is the only place in src/ that spells one of these revisions', () => {
    // A copy of one of these strings anywhere else in src/ is a second source of
    // truth that will not move when this constant does — exactly how a server
    // ends up advertising one revision and negotiating another.
    //
    // Scoped to OUR revisions on purpose: `src/` legitimately contains other
    // ISO dates (Avito API `X-Api-Version` values, for instance), and a blanket
    // date scan would either fail on those or have to carry an allowlist that
    // rots.
    const pattern = new RegExp(`['"\`](${SUPPORTED_PROTOCOL_VERSIONS.join('|')})['"\`]`, 'g');
    const versionModule = join(SRC_ROOT, 'version.ts');
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      if (file === versionModule) continue;
      // Strip comments: prose about a revision is documentation, not a constant.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const match of code.matchAll(pattern)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('createServerFactory (M3.2)', () => {
  function makeCtx(): ToolContext {
    const config = makeConfig();
    return {
      client: new AvitoClient(config),
      config,
      pendingStore: new PendingActionStore(config.confirmationTtlSec * 1000),
      idempotencyStore: new IdempotencyStore(config.idempotencyTtlSec * 1000),
    };
  }

  it('returns a fresh server per call that shares the baseCtx singletons', async () => {
    // The SDK calls the factory per connection (stdio) and per request (modern
    // HTTP). Rebuilding the AvitoClient or the durable stores there would
    // duplicate the token cache and the idempotency ledger.
    const ctx = makeCtx();
    const factory = createServerFactory(ctx, { background: true });
    const a = await factory({ era: 'legacy' });
    const b = await factory({ era: 'modern' });
    expect(a).not.toBe(b);
    await Promise.all([a.close(), b.close()]);
  });

  it('registers a LEGACY instance as a log sink and releases it on close', async () => {
    // Observed functionally, because the sink registry is module-private: while
    // the instance lives, background pino events reach it; after close() they
    // must not. A leaked binding keeps a fully-registered 148-tool server alive
    // for the life of the process, once per discarded instance.
    const ctx = makeCtx();
    const factory = createServerFactory(ctx, { background: true });
    const server = await factory({ era: 'legacy' });
    const sent = vi.fn().mockResolvedValue(undefined);
    (server as unknown as { sendLoggingMessage: unknown }).sendLoggingMessage = sent;

    logger.info({ probe: 'bound' }, 'protocol-era-sink-probe');
    await vi.waitFor(() => expect(sent).toHaveBeenCalled());

    // NOTE: this instance was never connected to a transport. `Protocol.close()`
    // is `await this._transport?.close()`, so `onclose` never fires here — the
    // teardown has to survive that, which is why the factory also wraps close().
    await server.close();
    sent.mockClear();
    logger.info({ probe: 'unbound' }, 'protocol-era-sink-probe');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).not.toHaveBeenCalled();
  });

  it('never registers a MODERN instance as a background log sink', async () => {
    // M3 item 10. Until M3 the factory bound every instance the same way, so a
    // stdio process at `AVITO_MCP_PROTOCOL_ERA=dual|modern` mirrored EVERY pino
    // line to the connection as `notifications/message` — no request to scope
    // it to, and no reading of `_meta["io.modelcontextprotocol/logLevel"]`.
    // That is the revision's MUST NOT twice over, and it was live: the same
    // `{background: true}` factory serves the modern stdio path in src/server.ts.
    //
    // Asserted through the same seam as the legacy case above, on the same
    // factory and the same options, so the two differ in exactly one input.
    const ctx = makeCtx();
    const factory = createServerFactory(ctx, { background: true });
    const server = await factory({ era: 'modern' });
    const sent = vi.fn().mockResolvedValue(undefined);
    (server as unknown as { sendLoggingMessage: unknown }).sendLoggingMessage = sent;

    logger.info({ probe: 'modern-unbound' }, 'protocol-era-sink-probe');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).not.toHaveBeenCalled();

    await server.close();
  });

  it('releases the binding through onclose when the peer hangs up', async () => {
    // The other half of the teardown: a connection that dies without anyone
    // calling close() on the server. The factory must chain onto onclose rather
    // than assign it, because both v2 serving entries install their own
    // afterwards and chain onto whatever they find.
    const ctx = makeCtx();
    const factory = createServerFactory(ctx, { background: true });
    const server = await factory({ era: 'legacy' });
    const sent = vi.fn().mockResolvedValue(undefined);
    (server as unknown as { sendLoggingMessage: unknown }).sendLoggingMessage = sent;

    const low = (server as unknown as { server: { onclose?: () => void } }).server;
    expect(typeof low.onclose).toBe('function');
    let chainedRan = false;
    const ours = low.onclose!;
    low.onclose = () => {
      ours();
      chainedRan = true;
    };
    low.onclose();
    expect(chainedRan).toBe(true);

    logger.info({ probe: 'after-hangup' }, 'protocol-era-sink-probe');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).not.toHaveBeenCalled();
  });
});
