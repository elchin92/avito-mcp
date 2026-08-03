/**
 * M4.3 — cursor pagination for the four list operations, on the 2026-07-28 wire.
 *
 * ── What the revision asks for ──────────────────────────────────────────────
 *
 * Pagination is defined for exactly four operations — `resources/list`,
 * `resources/templates/list`, `prompts/list` and `tools/list` — and the
 * server-directed rules are short:
 *
 *   > The **cursor** is an opaque string token, representing a position in the
 *   > result set.
 *   > **Page size** is determined by the server, and clients **MUST NOT** assume
 *   > a fixed page size.
 *   > Invalid cursors **SHOULD** result in an error with code -32602 (Invalid
 *   > params).
 *   > — https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination
 *
 * and one that comes from the caching page rather than the pagination one:
 *
 *   > Servers **MUST** apply the same `cacheScope` to all response pages for a
 *   > given list request. … Servers **MAY** return different `ttlMs` values on
 *   > different pages.
 *   > — .../server/utilities/caching, "Interaction with Pagination"
 *
 * Before this module the server did neither half: `nextCursor` was never
 * emitted, and a `cursor` nobody minted was silently ignored — which is the
 * worst of the three possible answers, because a client walking pages against
 * it loops forever on page one or, having asked for page two, is handed page
 * one and told nothing.
 *
 * ── Why it is worth doing at all ────────────────────────────────────────────
 *
 * This server registers ~148 tools, and a single `tools/list` answer is
 * ≈225 KB / ≈56k tokens. That is not a theoretical cost: it is already the
 * reason sub-agents pointed at this server run out of context before they have
 * done anything. Pagination is the one change in this migration with a direct
 * user-visible win.
 *
 * ── ERA. Modern only, and that is not a shortcut ────────────────────────────
 *
 * Revision 2025-11-25 defines pagination in the same terms, so a 2025 client
 * would be within its rights to receive pages. It is still not enabled there,
 * for one reason that outranks conformance: 1.3.3 did not paginate, §1.2.B of
 * the plan makes byte-identity with the 1.3.3 wire the contract for the legacy
 * era, and `test/legacy-wire-regression.test.ts` compares against a capture of
 * a real 1.3.3 process. A legacy client that today receives 148 tools in one
 * answer and never sends a cursor would, the moment this were installed on that
 * era, silently receive ~30 — and 118 tools would vanish from an agent that has
 * no idea it was supposed to ask again. "The revision permits it" is not a
 * reason to move a wire that a contract freezes; the era flag exists exactly so
 * that the new behaviour arrives with the new revision and not before it.
 *
 * The same reasoning covers the invalid-cursor refusal: 2025-11-25 also says
 * SHOULD there, and 1.3.3 also ignored it, so on the legacy era a stray
 * `cursor` keeps being ignored.
 *
 * ── The cursor ─────────────────────────────────────────────────────────────
 *
 * `base64url(JSON.stringify({ v, m, o, f }))`, and it is opaque to the client
 * in the only sense that matters: nothing about its structure is promised, and
 * every field is re-checked on the way back in.
 *
 *   • `v` — format version. A cursor minted by another version is invalid.
 *   • `m` — the method that minted it. A `tools/list` cursor replayed against
 *     `prompts/list` is invalid; without this the two would share an offset
 *     space and a cross-method replay would silently return the wrong page.
 *   • `o` — the offset the next page starts at. Checked against the page
 *     boundaries this request computes, not merely against the list length: an
 *     offset that is not a boundary this server would ever mint is invalid,
 *     which keeps the page partition the same no matter which cursor a client
 *     replays.
 *   • `f` — a fingerprint of the ordered, serialized list. This is what makes a
 *     cursor SELF-CONTAINED without any server-side state: there are no
 *     sessions on this revision, and every modern request builds a fresh server
 *     instance, so the only way to know that a cursor still describes the list
 *     it was minted against is to carry a digest of that list. If the primitive
 *     set changes under a walk — a restart with a different safety policy — the
 *     stale cursor is refused with `-32602` rather than being answered with a
 *     page from a different list. That is exactly the case the client-side
 *     guidance is written for: "If a cursor becomes invalid … the client
 *     SHOULD discard all cached pages and re-fetch from the beginning."
 *
 * No signing key. A forged cursor buys nothing — the whole address space it can
 * reach is "an offset into a list the caller may already read in full" — and a
 * key would have to be stable across processes and restarts, which is a durable
 * secret introduced for no gain.
 *
 * ── The empty-string cursor, which is a client rule and not a server one ────
 *
 * The specification's remark that "an empty string is a valid cursor and thus
 * MUST NOT be treated as the end of results" sits inside the bullet headed
 * "Clients MUST treat cursors as opaque tokens". It tells a CLIENT not to infer
 * end-of-list from a cursor's contents; the end of the list is the ABSENCE of
 * `nextCursor`, which is how this module signals it and what
 * `test/pagination.test.ts` walks. This server never mints an empty cursor, so
 * an incoming `""` is a cursor it did not issue, and it is refused like any
 * other — refusing to give `""` a meaning of its own IS the opacity rule
 * applied from the server side. Inventing a second cursor vocabulary
 * ("`""` means start over") would be the server reading cursor contents, which
 * is the habit the passage exists to discourage.
 *
 * ── Page size is a byte budget, not a count ────────────────────────────────
 *
 * The point of the exercise is to bound how much context one answer costs, and
 * tool descriptors in this catalogue differ by more than an order of magnitude
 * (`meta_health` is a few hundred bytes; `delivery_create_parcel` carries a
 * 241-subschema body). A fixed count would therefore bound nothing: 30 small
 * tools and 30 large ones are not the same answer. So a page takes items while
 * they fit in {@link LIST_PAGE_BYTES}, and always takes at least one — a single
 * item larger than the whole budget is served alone rather than making the list
 * unwalkable.
 *
 * The partition is a pure function of (the serialized items, the budget), so it
 * is identical on every request and every page boundary is reproducible — which
 * is what lets the cursor carry a bare offset and lets the walk be deterministic
 * across pages.
 *
 * ── `cacheScope` ───────────────────────────────────────────────────────────
 *
 * Nothing here touches it, and that is the design. The hint is configured per
 * OPERATION in `MODERN_CACHE_HINTS` (`src/build-server.ts`) and attached by the
 * SDK before this wrapper sees the result, so every page of one list request
 * carries the same `cacheScope` by construction rather than by a rule someone
 * has to remember. The attachment rides a symbol-keyed property, which the
 * spread below preserves. `test/caching-hints.test.ts` walks the pages and
 * asserts it anyway — the MUST is worth a test that would notice if a future
 * change started deciding the scope per page.
 */
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer, ProtocolEra } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';

import { requestHandlerMap, rewrap, type StoredHandler } from './handler-seam.js';

/** How this module names itself when the seam fails. */
const SUBSYSTEM = 'pagination';

/**
 * The four paginated operations of revision 2026-07-28, each with the result
 * field that holds its items.
 *
 * All four, not just `tools/list`: only `tools/list` is large enough today for
 * paging to bite, but the invalid-cursor refusal is owed by every one of them,
 * and a list that is one page today is one commit away from not being.
 */
export const PAGINATED_LIST_METHODS: Readonly<Record<string, string>> = Object.freeze({
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
});

/**
 * The byte budget for one page of a list result, counting only the items.
 *
 * 48 KiB is ~4.7× smaller than the ≈225 KB `tools/list` answer this replaces,
 * which puts a page at roughly 12k tokens instead of 56k — under the budget a
 * sub-agent can spend on a tool catalogue and still have room to work. It is
 * chosen to be comfortably above the largest single tool descriptor in the
 * catalogue, so the "one oversized item alone on a page" branch stays a
 * safety net rather than the common case.
 *
 * A wire constant, not configuration: page size is the server's to decide
 * ("Page size is determined by the server, and clients MUST NOT assume a fixed
 * page size"), and an operator knob here would be a way to reintroduce the
 * 225 KB answer by accident.
 */
export const LIST_PAGE_BYTES = 48 * 1024;

/** The cursor format this build mints and accepts. Bump on any shape change. */
const CURSOR_VERSION = 1;

/** What a cursor carries. See the module header for why each field is there. */
interface CursorPayload {
  v: number;
  m: string;
  o: number;
  f: string;
}

/** The refusal the revision prescribes for a cursor this server did not mint. */
function invalidCursor(method: string): ProtocolError {
  // The caller's cursor is deliberately NOT echoed. It is attacker-chosen text
  // that would land in client logs and UIs, and it tells the client nothing it
  // does not already have; `reason` is what a client can branch on.
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor', {
    reason: 'invalid_cursor',
    method,
  });
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** A cursor's payload, or `undefined` for anything this build did not mint. */
function decodeCursor(raw: string): CursorPayload | undefined {
  // A bound before any work: a caller-supplied string is unbounded, and there
  // is no legitimate cursor anywhere near this size.
  if (raw.length === 0 || raw.length > 512) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { v, m, o, f } = parsed as Record<string, unknown>;
  if (v !== CURSOR_VERSION) return undefined;
  if (typeof m !== 'string' || typeof f !== 'string') return undefined;
  if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) return undefined;
  return { v, m, o, f };
}

/**
 * The page partition of a serialized list: the index each page starts at.
 *
 * Always begins with `0`, so `boundaries.length` is the page count and
 * `boundaries.slice(1)` is exactly the set of offsets this server will ever
 * mint a cursor for.
 */
function pageBoundaries(sizes: readonly number[]): number[] {
  const starts: number[] = [0];
  let used = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index]!;
    if (index > starts[starts.length - 1]! && used + size > LIST_PAGE_BYTES) {
      starts.push(index);
      used = size;
      continue;
    }
    used += size;
  }
  return starts;
}

/** A digest of the ordered, serialized list — the cursor's staleness check. */
function fingerprintOf(serialized: readonly string[]): string {
  const hash = createHash('sha256');
  for (const item of serialized) {
    hash.update(item);
    hash.update(' ');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Wraps one list handler so that it answers a page, mints the cursor for the
 * next one, and refuses a cursor it did not mint.
 *
 * The upstream handler is always called in full — the cost of building the list
 * is the registry walk, not the paging — and only the items array is replaced.
 * The result is SPREAD rather than mutated so the SDK's symbol-keyed cache-hint
 * carrier survives onto the page (see the module header) and so a handler that
 * returns a frozen object still works.
 */
function paginate(stored: StoredHandler, method: string, itemsKey: string): StoredHandler {
  return async (request, ctx) => {
    const requested = request.params?.cursor;
    // Present but not a string is a malformed parameter, not a stale one; the
    // revision answers both with -32602, and the 2025-era `CursorSchema` typed
    // it as a string too, so there is no era in which this is a valid frame.
    if (requested !== undefined && typeof requested !== 'string') throw invalidCursor(method);

    const result = (await stored(request, ctx)) as Record<string, unknown>;
    const items = result[itemsKey];
    if (!Array.isArray(items)) {
      // The SDK's own handler always returns the array; if it stops, paging it
      // would silently serve an empty list forever. Fail where it happened.
      throw new Error(
        `${SUBSYSTEM}: ${method} returned no \`${itemsKey}\` array to paginate — the SDK's ` +
          'list result shape has changed and this layer must be re-pointed at it.',
      );
    }

    const serialized = items.map((item) => JSON.stringify(item) ?? 'null');
    const sizes = serialized.map((text) => Buffer.byteLength(text, 'utf8'));
    const starts = pageBoundaries(sizes);
    const fingerprint = fingerprintOf(serialized);

    let pageIndex = 0;
    if (requested !== undefined) {
      const payload = decodeCursor(requested);
      if (payload === undefined) throw invalidCursor(method);
      if (payload.m !== method || payload.f !== fingerprint) throw invalidCursor(method);
      // Only a boundary this request would itself mint is acceptable: `o` is
      // checked against the partition, never used as a bare `slice()` index.
      pageIndex = starts.indexOf(payload.o);
      if (pageIndex < 1) throw invalidCursor(method);
    }

    const from = starts[pageIndex]!;
    const nextStart = starts[pageIndex + 1];
    const page = nextStart === undefined ? items.slice(from) : items.slice(from, nextStart);

    return {
      ...result,
      [itemsKey]: page,
      ...(nextStart === undefined
        ? {}
        : { nextCursor: encodeCursor({ v: CURSOR_VERSION, m: method, o: nextStart, f: fingerprint }) }),
    };
  };
}

/**
 * Installs cursor pagination on the four list operations. Call ONCE, after
 * every primitive has been registered — it replaces handlers that are already
 * in place.
 *
 * A no-op on any era but `modern`; see the module header for why that is a
 * contract and not an omission.
 */
export function applyListPagination(server: McpServer, era: ProtocolEra): void {
  if (era !== 'modern') return;
  const handlers = requestHandlerMap(server, SUBSYSTEM);
  for (const [method, itemsKey] of Object.entries(PAGINATED_LIST_METHODS)) {
    rewrap(handlers, method, SUBSYSTEM, (stored) => paginate(stored, method, itemsKey));
  }
}
