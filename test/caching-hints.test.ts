/**
 * M4.2 acceptance: point 3 of block A — `ttlMs` and `cacheScope` on the six
 * cacheable results of revision 2026-07-28 (SEP-2549 `CacheableResult`).
 *
 * The dangerous mistake this file exists to prevent is one field on one URI.
 * `cacheScope: "public"` authorises a SHARED cache to store a body and hand it
 * to a DIFFERENT caller. `avito://state/pending-actions` carries live
 * `confirmation_id` handles, and a `confirmation_id` is what authorises a money
 * or public operation on the production Avito account — of which there is
 * exactly one, with no sandbox behind it. So `public` there is not a caching
 * inefficiency, it is a credential leak into an intermediary.
 *
 * Division of labour, so nothing here re-implements the SDK:
 *   • the SDK fills the two fields at the 2026 encode seam and defaults them to
 *     `{ ttlMs: 0, cacheScope: 'private' }` when nobody says otherwise;
 *   • the VALUES are ours (`MODERN_CACHE_HINTS` in `src/build-server.ts` for the
 *     per-operation fallbacks, `RESOURCE_CACHE_DECISIONS` in `src/resources.ts`
 *     for `resources/read` per URI).
 *
 * The assertions therefore come in two layers: a static one over the decision
 * table (fast, exhaustive, and the one that fails at import time) and a wire one
 * that proves the table is actually what a 2026 client receives.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  META,
  MODERN_REVISION,
  closeRigs,
  errorOf,
  modernPost,
  resultOf,
  startRig,
  type Rig,
} from './support/modern-rig.js';
import { MODERN_CACHE_HINTS } from '../src/build-server.js';
import {
  PENDING_ACTIONS_URI,
  RESOURCE_CACHE_DECISIONS,
  WEBHOOK_EVENTS_URI,
  resourceCacheHint,
} from '../src/resources.js';

afterEach(closeRigs);

/** The closed list of cacheable operations on this revision. */
const CACHEABLE_METHODS = [
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
] as const;

describe('the decision table itself', () => {
  it('marks no account-scoped URI as public', () => {
    // The guard, stated where a reviewer reads it. `src/resources.ts` runs the
    // same check at module load and refuses to start the process, so this test
    // is the readable statement of an invariant that is already enforced.
    for (const decision of RESOURCE_CACHE_DECISIONS) {
      if (decision.accountScoped) {
        expect(decision.hint.cacheScope, `${decision.uri}: ${decision.why}`).toBe('private');
      }
    }
  });

  it('classifies as public only the two URIs that are files shipped in the package', () => {
    // Pinned by name rather than by count: the interesting failure is a NEW
    // resource being waved through as public, and a count assertion would let
    // that pass as long as something else moved the other way.
    const publicUris = RESOURCE_CACHE_DECISIONS.filter((d) => d.hint.cacheScope === 'public').map(
      (d) => d.uri,
    );
    expect(publicUris.sort()).toEqual(['avito://docs/safety', 'avito://swaggers/{slug}']);
  });

  it('keeps the two live-state URIs uncacheable', () => {
    // ttlMs 0 means "do not serve this from a cache at all". Both of these
    // change under the client's feet — one on every confirmation, the other on
    // every webhook delivery — and a stale answer is actively misleading.
    for (const uri of [PENDING_ACTIONS_URI, WEBHOOK_EVENTS_URI]) {
      expect(resourceCacheHint(uri)).toEqual({ ttlMs: 0, cacheScope: 'private' });
    }
  });

  it('uses non-negative safe integers for every ttlMs', () => {
    for (const decision of RESOURCE_CACHE_DECISIONS) {
      expect(Number.isSafeInteger(decision.hint.ttlMs), decision.uri).toBe(true);
      expect(decision.hint.ttlMs!, decision.uri).toBeGreaterThanOrEqual(0);
    }
    for (const method of CACHEABLE_METHODS) {
      const hint = MODERN_CACHE_HINTS[method];
      expect(hint, method).toBeDefined();
      expect(Number.isSafeInteger(hint!.ttlMs), method).toBe(true);
      expect(hint!.ttlMs!, method).toBeGreaterThanOrEqual(0);
      expect(['public', 'private'], method).toContain(hint!.cacheScope);
    }
  });

  it('fails closed for a resource added without a decision', () => {
    // Why the lookup throws instead of returning a default: a resource whose
    // hint was forgotten would otherwise inherit the per-operation fallback and
    // look fine — which is exactly how an account-scoped body ends up with
    // somebody else's TTL later on.
    expect(() => resourceCacheHint('avito://not/registered')).toThrow(/No resource cache decision/);
  });

  it('defaults resources/read to the conservative pair', () => {
    expect(MODERN_CACHE_HINTS['resources/read']).toEqual({ ttlMs: 0, cacheScope: 'private' });
  });

  it('gives server/discover a TTL on the order of an hour', () => {
    // M3.4: the discover payload is a process constant, so a zero TTL would make
    // every 2026 client re-fetch a static document on every connection.
    const hint = MODERN_CACHE_HINTS['server/discover']!;
    expect(hint.ttlMs!).toBeGreaterThanOrEqual(60 * 60_000);
  });
});

describe('the values that actually reach a 2026 client', () => {
  async function readHints(
    rig: Rig,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ ttlMs: unknown; cacheScope: unknown }> {
    const result = resultOf(await modernPost(rig, method, params));
    expect(result, method).toBeDefined();
    return { ttlMs: result!.ttlMs, cacheScope: result!.cacheScope };
  }

  it('carries an integer ttlMs and a cacheScope on every cacheable result', async () => {
    const rig = await startRig('dual');
    for (const method of CACHEABLE_METHODS) {
      const params = method === 'resources/read' ? { uri: 'avito://docs/safety' } : {};
      const hints = await readHints(rig, method, params);
      expect(Number.isSafeInteger(hints.ttlMs), method).toBe(true);
      expect(hints.ttlMs as number, method).toBeGreaterThanOrEqual(0);
      expect(['public', 'private'], method).toContain(hints.cacheScope);
      if (method !== 'resources/read') {
        // `resources/read` is the one operation whose values come from the
        // per-resource decision, which overrides the per-operation fallback
        // field by field — asserted URI by URI in the next test.
        expect(hints, method).toEqual({
          ttlMs: MODERN_CACHE_HINTS[method]!.ttlMs,
          cacheScope: MODERN_CACHE_HINTS[method]!.cacheScope,
        });
      }
    }
  });

  it('emits each resource read with its own decision, per URI', async () => {
    const rig = await startRig('dual');
    for (const decision of RESOURCE_CACHE_DECISIONS) {
      // The template is exercised through a concrete instance of itself.
      const uri = decision.uri.includes('{') ? 'avito://swaggers/items' : decision.uri;
      const hints = await readHints(rig, 'resources/read', { uri });
      expect(hints, uri).toEqual({
        ttlMs: decision.hint.ttlMs,
        cacheScope: decision.hint.cacheScope,
      });
    }
  });

  it('never hands an account-scoped body a public scope on the wire', async () => {
    // The static guard proves the table; this proves the wiring. A
    // `registerResource` call that simply forgot to pass its `cacheHint` would
    // satisfy the table and fail here, falling back to the per-operation
    // default — which is private, so the assertion that catches the omission is
    // the exact-match one above, and this is the blunt safety net for `public`.
    const rig = await startRig('dual');
    for (const decision of RESOURCE_CACHE_DECISIONS.filter((d) => d.accountScoped)) {
      const hints = await readHints(rig, 'resources/read', { uri: decision.uri });
      expect(hints.cacheScope, decision.uri).toBe('private');
    }
  });

  it('keeps cacheScope identical across every page of one list request', async () => {
    // Trivially true while each list fits in one page, and deliberately written
    // as a page walk anyway: `tools/list` pagination lands in M4.3, and this is
    // the assertion that has to still be here when it does. A per-page hint
    // would let a shared cache hold page 1 of a private listing.
    const rig = await startRig('dual');
    for (const method of [
      'tools/list',
      'prompts/list',
      'resources/list',
      'resources/templates/list',
    ]) {
      const scopes: unknown[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = resultOf(
          await modernPost(rig, method, cursor === undefined ? {} : { cursor }),
        );
        expect(result, method).toBeDefined();
        scopes.push(result!.cacheScope);
        cursor = result!.nextCursor as string | undefined;
        pages += 1;
        expect(pages, `${method} paged more than expected`).toBeLessThan(50);
      } while (cursor !== undefined);
      expect(new Set(scopes).size, method).toBe(1);
      expect(scopes[0], method).toBe(MODERN_CACHE_HINTS[method as 'tools/list']!.cacheScope);
    }
  });

  it('never emits cache fields on the 2025 wire', async () => {
    // The 2025 codec has no cache code path at all, and the configured hint
    // rides a symbol-keyed property JSON cannot serialize. Asserted rather than
    // trusted, because this is what makes the table safe to apply
    // unconditionally instead of gating it on the era flag.
    const rig = await startRig('dual');
    const init = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: rig.host,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
    });
    const sessionId = init.headers.get('mcp-session-id');
    await init.text();
    expect(sessionId).toBeTruthy();

    const read = await fetch(`${rig.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: rig.host,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'avito://docs/safety' },
      }),
    });
    const text = await read.text();
    expect(text).not.toContain('cacheScope');
    expect(text).not.toContain('ttlMs');
  });
});

describe('cacheScope is a caching hint, not an access-control decision', () => {
  it('still hides a policy-denied resource, whatever its hint says', async () => {
    // M4.2's separate requirement: access control is `evaluatePolicy` on every
    // build, and a cache scope neither grants nor withholds anything. A resource
    // the policy denies must not appear at all — its `private` hint is not what
    // is protecting it.
    const allowed = await startRig('dual');
    const denied = await startRig('dual', (config) => {
      config.denyTools = ['meta_list_pending_actions'];
    });

    const uris = async (rig: Rig): Promise<string[]> =>
      (
        (resultOf(await modernPost(rig, 'resources/list'))?.resources ?? []) as { uri: string }[]
      ).map((r) => r.uri);

    expect(await uris(allowed)).toContain(PENDING_ACTIONS_URI);
    expect(await uris(denied)).not.toContain(PENDING_ACTIONS_URI);

    // Reading it directly fails too — and fails as `-32602` in-band on HTTP
    // 200, which is what this revision prescribes for a resource miss
    // (the SDK never emits `-32002`). What matters is that no body comes back.
    const read = await modernPost(denied, 'resources/read', { uri: PENDING_ACTIONS_URI });
    expect(resultOf(read)).toBeUndefined();
    expect(errorOf(read)?.code).toBe(-32602);
  });

  it('applies the same decisions on both the dual and the modern-only endpoint', async () => {
    // The hints live on the server, not on the entry, so a modern-only
    // deployment must see exactly the same values as a dual one.
    const dual = await startRig('dual');
    const modernOnly = await startRig('modern');
    for (const rig of [dual, modernOnly]) {
      const result = resultOf(await modernPost(rig, 'server/discover'))!;
      expect(result.cacheScope).toBe(MODERN_CACHE_HINTS['server/discover']!.cacheScope);
      expect(result.ttlMs).toBe(MODERN_CACHE_HINTS['server/discover']!.ttlMs);
      expect((result._meta as Record<string, unknown>)[META.protocolVersion]).toBeUndefined();
      expect(result.supportedVersions).toContain(MODERN_REVISION);
    }
  });
});
