/**
 * M4.3 acceptance: cursor pagination for the four list operations.
 *
 * WHAT IS BEING PROVED, and why each half needs its own assertion:
 *
 *   • The MODERN era pages. A walk terminates by the ABSENCE of `nextCursor`,
 *     the pages concatenate back to exactly the unpaginated list in exactly the
 *     unpaginated order, and one page costs materially less than the ≈225 KB
 *     answer it replaces — with the budget written as a number, because a
 *     "smaller than before" assertion that recomputes "before" from the branch
 *     asserts nothing.
 *   • A cursor this server did not mint is `-32602`, including the cases that
 *     look benign: the empty string, a cursor minted for another method, and a
 *     cursor minted against a different primitive set. Silently ignoring one of
 *     these is what the code did before, and it is the failure that cannot be
 *     seen from a client — it looks exactly like a short list.
 *   • The LEGACY era does NOT page and does NOT refuse a cursor. That is the
 *     contract of §1.2.B, not an oversight, and it needs a test precisely
 *     because it is the kind of thing a later "let's make it consistent" commit
 *     would helpfully break.
 *
 * Everything here drives the real HTTP listener through `test/support/modern-rig.ts`
 * rather than an SDK client, for the reason that file's header gives: an SDK
 * client aggregates pages for you, which would erase the entire subject.
 * `test/conformance/sdk-client.test.ts` covers the other direction — a real
 * client walking a real paginated server — and both are worth having.
 *
 * Source: `docs/mcp-2026-07-28/server-overview.md` (N6.2), `concepts.md` (60),
 * `docs/mcp-2026-07-28/schema-1.md` (`{ "code": -32602, "message": "Invalid cursor" }`).
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  LIST_PAGE_BYTES,
  PAGINATED_LIST_METHODS,
} from '../src/core/pagination.js';
import {
  closeRigs,
  errorOf,
  initializeMessage,
  legacyPost,
  modernPost,
  resultOf,
  startRig,
  type Rig,
} from './support/modern-rig.js';

afterEach(async () => {
  await closeRigs();
});

/** Every page of one list request, in order, with the raw results kept. */
async function walk(
  rig: Rig,
  method: string,
): Promise<{ pages: Array<Record<string, unknown>>; items: unknown[] }> {
  const itemsKey = PAGINATED_LIST_METHODS[method]!;
  const pages: Array<Record<string, unknown>> = [];
  const items: unknown[] = [];
  let cursor: string | undefined;
  do {
    const answer = await modernPost(rig, method, cursor === undefined ? {} : { cursor });
    expect(answer.status, `${method} page ${pages.length + 1}`).toBe(200);
    const result = resultOf(answer);
    expect(result, `${method} page ${pages.length + 1}`).toBeDefined();
    pages.push(result!);
    items.push(...(result![itemsKey] as unknown[]));
    cursor = result!.nextCursor as string | undefined;
    // A server that mints the cursor it was just given would loop here for
    // ever; the bound turns that into a failure instead of a hung suite.
    expect(pages.length, `${method} produced more pages than the list can have`).toBeLessThan(64);
  } while (cursor !== undefined);
  return { pages, items };
}

describe('M4.3 — tools/list is paginated on the modern era', () => {
  it('answers a first page with a nextCursor, and ends by omitting it', async () => {
    const rig = await startRig('dual');
    const { pages } = await walk(rig, 'tools/list');

    // The catalogue is ~148 tools at ≈225 KB, so a 48 KiB budget must produce
    // several pages. If this ever drops to one, either the budget or the
    // catalogue moved by an order of magnitude and the rest of this file is
    // proving nothing.
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages.slice(0, -1)) {
      expect(typeof page.nextCursor).toBe('string');
      expect(page.nextCursor).not.toBe('');
    }
    // End of list is the ABSENCE of the field — never an empty cursor, which
    // the revision warns clients not to read as the end.
    expect('nextCursor' in pages[pages.length - 1]!).toBe(false);
  }, 30_000);

  it('keeps one page well under the payload the unpaginated answer cost', async () => {
    const rig = await startRig('dual');
    const { pages, items } = await walk(rig, 'tools/list');

    // The budget applies to the ITEMS, which is what the constant bounds; the
    // whole-result number is asserted separately and generously, because the
    // envelope (`resultType`, cache hints, `_meta`, the cursor) is a fixed cost
    // that has nothing to do with how many tools a page holds.
    for (const [index, page] of pages.entries()) {
      const itemBytes = Buffer.byteLength(JSON.stringify(page.tools), 'utf8');
      expect(itemBytes, `page ${index + 1} items`).toBeLessThanOrEqual(LIST_PAGE_BYTES);
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8'), `page ${index + 1}`).toBeLessThan(
        64 * 1024,
      );
    }

    // And the thing the exercise is actually for: the full catalogue is much
    // bigger than one page. Written as a ratio against the measured whole so
    // it keeps meaning something as the catalogue grows.
    const whole = Buffer.byteLength(JSON.stringify(items), 'utf8');
    expect(whole).toBeGreaterThan(3 * LIST_PAGE_BYTES);
  }, 30_000);

  it('concatenates back to the same tools, in the same order, on every walk', async () => {
    const rig = await startRig('dual');
    const first = await walk(rig, 'tools/list');
    const second = await walk(rig, 'tools/list');

    const names = (items: unknown[]): string[] => items.map((t) => (t as { name: string }).name);
    expect(names(second.items)).toEqual(names(first.items));
    expect(new Set(names(first.items)).size).toBe(first.items.length);

    // The page BOUNDARIES are stable too, not just the concatenation: a
    // partition that drifted between requests would make a cursor from one
    // walk describe a different position in the next.
    expect(second.pages.map((page) => (page.tools as unknown[]).length)).toEqual(
      first.pages.map((page) => (page.tools as unknown[]).length),
    );

    // Every page of one request carries the same cacheScope (MUST), and every
    // ttlMs is a non-negative integer (the field MAY differ per page).
    for (const page of first.pages) {
      expect(page.cacheScope).toBe('private');
      expect(Number.isSafeInteger(page.ttlMs) && (page.ttlMs as number) >= 0).toBe(true);
      expect(page.resultType).toBe('complete');
    }
  }, 30_000);

  it('serves the same catalogue paged as the legacy leg serves whole', async () => {
    const rig = await startRig('dual');
    const { items } = await walk(rig, 'tools/list');

    const init = await legacyPost(rig, initializeMessage());
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
    const legacy = resultOf(
      await legacyPost(rig, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId),
    )!;

    expect(items.map((t) => (t as { name: string }).name)).toEqual(
      (legacy.tools as Array<{ name: string }>).map((t) => t.name),
    );
    expect(items.length).toBeGreaterThan(100);
  }, 30_000);
});

describe('M4.3 — the other three list operations page by the same rules', () => {
  it('walks every list operation to exhaustion and loses nothing', async () => {
    const rig = await startRig('dual');
    for (const [method, itemsKey] of Object.entries(PAGINATED_LIST_METHODS)) {
      if (method === 'tools/list') continue;
      const { pages, items } = await walk(rig, method);
      // These three fit in one page today. The assertion is not "one page" —
      // that would break the day a domain adds resources — but that the walk
      // terminated correctly and returned everything the unpaginated shape
      // would have.
      expect(items.length, method).toBeGreaterThan(0);
      expect('nextCursor' in pages[pages.length - 1]!, method).toBe(false);
      const single = resultOf(await modernPost(rig, method))!;
      expect((single[itemsKey] as unknown[]).length, method).toBe(
        (pages[0]![itemsKey] as unknown[]).length,
      );
    }
  }, 30_000);
});

describe('M4.3 — a cursor this server did not mint is -32602', () => {
  /** Every way a client can hand back something that is not a live cursor. */
  const rejected: Array<{ label: string; cursor: unknown }> = [
    { label: 'the empty string', cursor: '' },
    { label: 'arbitrary text', cursor: 'page-2' },
    { label: 'base64 of a plausible payload we never minted', cursor: 'eyJwYWdlIjogMn0=' },
    { label: 'a wrong-typed cursor', cursor: 42 },
    { label: 'an enormous cursor', cursor: 'A'.repeat(4096) },
  ];

  it('refuses every cursor it did not mint, the empty string included', async () => {
    // One title over a table rather than a generated title per case: the
    // conformance table cites test titles verbatim (see
    // `test/conformance/conformance-doc.test.ts`), and a title built from a
    // template literal cannot be cited at all. Each case still names itself in
    // the assertion message, so a failure says which one.
    const rig = await startRig('dual');
    for (const { label, cursor } of rejected) {
      const answer = await modernPost(rig, 'tools/list', { cursor });
      const error = errorOf(answer);
      expect(error, label).toBeDefined();
      expect(error!.code, label).toBe(-32602);
      expect(error!.message, label).toBe('Invalid cursor');
      // The refusal names the condition without echoing the caller's text back
      // into the client's logs. (The empty string is excluded from the echo
      // check for the obvious reason: every string contains it.)
      const echoed = String(cursor).slice(0, 16);
      if (echoed !== '') {
        expect(JSON.stringify(error), label).not.toContain(echoed);
      }
    }
  }, 30_000);

  it('refuses a cursor minted for a different list operation', async () => {
    const rig = await startRig('dual');
    const cursor = resultOf(await modernPost(rig, 'tools/list'))!.nextCursor as string;
    expect(typeof cursor).toBe('string');

    // Valid on the method that minted it…
    expect(resultOf(await modernPost(rig, 'tools/list', { cursor }))).toBeDefined();
    // …and not on any other. Without the method in the payload these would
    // share an offset space and a replay would quietly answer the wrong page.
    for (const method of ['prompts/list', 'resources/list', 'resources/templates/list']) {
      expect(errorOf(await modernPost(rig, method, { cursor }))?.code, method).toBe(-32602);
    }
  }, 30_000);

  it('refuses a cursor minted against a different primitive set', async () => {
    // The staleness case, and the reason the cursor carries a fingerprint at
    // all: this revision has no sessions, so a cursor outlives the server
    // instance that minted it by design. A restart under a policy that hides
    // tools must not answer an old cursor with a page of a list that no longer
    // exists — it must say so, so the client re-fetches from the beginning.
    const wide = await startRig('dual');
    const cursor = resultOf(await modernPost(wide, 'tools/list'))!.nextCursor as string;
    expect(typeof cursor).toBe('string');

    const narrowed = await startRig('dual', (config) => {
      config.mode = 'read_only';
    });
    expect(errorOf(await modernPost(narrowed, 'tools/list', { cursor }))?.code).toBe(-32602);
    // …while the same server still walks its own list happily.
    const { items } = await walk(narrowed, 'tools/list');
    expect(items.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('M4.3 — the legacy era is deliberately left alone', () => {
  /**
   * §1.2.B freezes the 2025 wire to what 1.3.3 answered, and 1.3.3 answered
   * `tools/list` in one piece and ignored a `cursor` it was handed. Paging the
   * legacy leg would silently drop ~118 tools from every existing client, since
   * a client that never expected a `nextCursor` will never ask for page two.
   */
  async function legacySession(rig: Rig): Promise<string> {
    const init = await legacyPost(rig, initializeMessage());
    await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
    return init.sessionId!;
  }

  it('answers the whole catalogue in one result, with no nextCursor', async () => {
    const rig = await startRig('dual');
    const sessionId = await legacySession(rig);
    const result = resultOf(
      await legacyPost(rig, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId),
    )!;
    expect((result.tools as unknown[]).length).toBeGreaterThan(100);
    expect('nextCursor' in result).toBe(false);
  }, 30_000);

  it('ignores a cursor rather than refusing it, exactly as 1.3.3 did', async () => {
    const rig = await startRig('dual');
    const sessionId = await legacySession(rig);
    for (const cursor of ['', 'page-2']) {
      const answer = await legacyPost(
        rig,
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor } },
        sessionId,
      );
      expect(errorOf(answer), JSON.stringify(cursor)).toBeUndefined();
      expect((resultOf(answer)!.tools as unknown[]).length).toBeGreaterThan(100);
    }
  }, 30_000);
});
