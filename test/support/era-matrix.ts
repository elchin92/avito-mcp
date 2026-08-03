/**
 * M6.1 — the dual-era test matrix.
 *
 * WHY THIS EXISTS. Until this file, every integration suite in the repository
 * spoke exactly one era. The suites that predate the migration
 * (`confirmation`, `resources`, `tool-factory`, `structured-content`,
 * `prompts`, `meta-tools`) drive an `McpServer` over `InMemoryTransport`, which
 * only ever speaks 2025-11-25; the modern suites drive raw HTTP. That split has
 * one specific failure mode, and it is the one the migration plan calls the
 * main systemic risk: a change lands, the whole suite is green, and NOTHING in
 * it exercised the era we are migrating to. A tool that answers correctly on
 * the legacy leg and throws on the modern one would ship green.
 *
 * WHAT IT DOES ABOUT IT. It gives both eras ONE calling convention —
 * `session.call(method, params)` — so a scenario can be written once and run
 * twice under `describe.each(ERAS)`. The scenario body contains no `if (era ===
 * ...)` branching for the transport; only the genuinely era-DIFFERENT
 * expectations (cache hints, `resultType`, session ids) are looked up in a
 * table, and looking them up is itself an assertion that the difference is
 * intentional rather than accidental.
 *
 * WHY ONE PROCESS SERVES BOTH. `openEraSession` always starts the rig at
 * `era=dual`, and the legacy session performs the real 2025 handshake against
 * the same listener the modern session POSTs to. So the matrix proves something
 * a pair of single-era fixtures could not: the two legs coexist in one process
 * over one endpoint, which is exactly the deployment the plan targets
 * (§1.1, "A dual-era server MAY serve both eras concurrently on the same
 * endpoint or process").
 *
 * WHY NOT AN SDK `Client` FOR THE LEGACY LEG. Symmetry is the point. Driving
 * legacy through `Client` + `InMemoryTransport` and modern through `fetch`
 * would mean the two runs differ in transport, framing AND client library, so a
 * divergence between them could never be attributed. Both legs here are raw
 * JSON-RPC over the same real HTTP listener; the only difference is the
 * envelope the revision prescribes.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { vi } from 'vitest';

import {
  closeRigs,
  initializeMessage,
  legacyPost,
  modernListAll,
  modernPost,
  resultOf,
  errorOf,
  startRig,
  type Answer,
  type ModernPostOptions,
  type Rig,
} from './modern-rig.js';
import type { Config } from '../../src/config.js';
import type { ToolContext } from '../../src/core/tool-factory.js';

export const ERAS = ['legacy', 'modern'] as const;
export type EraName = (typeof ERAS)[number];

/**
 * The differences between the eras that a shared scenario is allowed to see.
 *
 * Kept as data rather than as `if` statements in the test bodies: a reader can
 * see the entire era delta of the matrix in one place, and adding a difference
 * means editing this table — which is a review-visible act — instead of
 * sprinkling a branch into one test.
 */
export const ERA_TRAITS: Record<
  EraName,
  {
    /** 2026-07-28 stamps `resultType` on every result; 2025-11-25 has no such field. */
    resultType: 'complete' | undefined;
    /** SEP-2549 cache hints ride on the six cacheable operations — modern only. */
    cacheHints: boolean;
    /** The revision removed protocol sessions, so only the legacy leg mints an id. */
    sessions: boolean;
    /**
     * M4.3: the modern leg answers a list request with a PAGE and a
     * `nextCursor`; the legacy leg answers it whole and mints no cursor, which
     * §1.2.B freezes because 1.3.3 did the same. See `src/core/pagination.ts`.
     */
    paginatesLists: boolean;
  }
> = {
  legacy: { resultType: undefined, cacheHints: false, sessions: true, paginatesLists: false },
  modern: { resultType: 'complete', cacheHints: true, sessions: false, paginatesLists: true },
};

export interface EraSession {
  era: EraName;
  /** The running server. Exposed so a scenario can mutate server-side state. */
  rig: Rig;
  /** The 2025 session id, or `null` on the modern leg (which has no sessions). */
  sessionId: string | null;
  /** One request, framed as this era prescribes. */
  call(
    method: string,
    params?: Record<string, unknown>,
    options?: ModernPostOptions,
  ): Promise<Answer>;
  /** `tools/call`, with the `Mcp-Name` header derived for the modern leg. */
  callTool(name: string, args?: Record<string, unknown>): Promise<Answer>;
  /**
   * Every item of a list, however this era delivers it.
   *
   * Since M4.3 the modern leg answers `tools/list` in PAGES and the legacy leg
   * still answers it whole. That is a genuine era difference and it belongs
   * behind the calling convention rather than in a test body: a scenario that
   * wants the catalogue wants the catalogue, and should not have to know which
   * leg it is on to get it. The difference itself is the subject of
   * `test/pagination.test.ts`, not of anything that calls this.
   */
  listAll(method: string, itemsKey: string): Promise<unknown[]>;
}

export interface EraSessionOptions {
  configure?: (config: Config) => void;
  decorate?: (ctx: ToolContext) => void;
}

/**
 * Opens a session on one era of a `dual` server. Close everything the matrix
 * started with `closeRigs()` (re-exported below) in `afterEach`.
 */
export async function openEraSession(
  era: EraName,
  options: EraSessionOptions = {},
): Promise<EraSession> {
  const rig = await startRig('dual', options.configure, options.decorate);
  return openEraSessionOn(rig, era);
}

/**
 * Opens a session on an ALREADY RUNNING dual server.
 *
 * This is what makes "one process, both eras" checkable: the confirmation
 * store, the idempotency ledger and the rate limiter are per-process
 * singletons, so a cross-leg assertion is only meaningful when both sessions
 * are talking to the same `startRig` instance.
 */
export async function openEraSessionOn(rig: Rig, era: EraName): Promise<EraSession> {
  let nextId = 100 + Math.floor(Math.random() * 10_000);

  if (era === 'modern') {
    return {
      era,
      rig,
      sessionId: null,
      call: (method, params = {}, postOptions = {}) =>
        modernPost(rig, method, params, { id: nextId++, ...postOptions }),
      callTool: (name, args = {}) =>
        modernPost(rig, 'tools/call', { name, arguments: args }, { id: nextId++ }),
      listAll: (method, itemsKey) => modernListAll(rig, method, itemsKey),
    };
  }

  const init = await legacyPost(rig, initializeMessage());
  const sessionId = init.sessionId;
  if (!sessionId) throw new Error('the legacy leg minted no session id');
  await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Answer> =>
    legacyPost(rig, { jsonrpc: '2.0', id: nextId++, method, params }, sessionId);

  return {
    era,
    rig,
    sessionId,
    call,
    callTool: (name, args = {}) => call('tools/call', { name, arguments: args }),
    // No walk on this leg, and the assertion is part of the point: the 2025
    // wire is frozen to what 1.3.3 answered, which is the whole list and no
    // `nextCursor`. If a `nextCursor` ever appears here, pagination has leaked
    // onto the legacy era and every existing client has quietly lost 118 tools.
    listAll: async (method, itemsKey) => {
      const result = resultOf(await call(method))!;
      if (result.nextCursor !== undefined) {
        throw new Error(`the legacy leg paginated ${method}, which §1.2.B forbids`);
      }
      return (result[itemsKey] ?? []) as unknown[];
    },
  };
}

/** The concatenated text of a `tools/call` / `resources/read` style result. */
export function textOf(answer: Answer): string {
  const result = resultOf(answer);
  const blocks = (result?.content ?? result?.contents ?? []) as Array<{ text?: string }>;
  return blocks.map((block) => block.text ?? '').join('\n');
}

/** The first JSON object embedded in a tool's text content, if it parses. */
export function jsonOf(answer: Answer): Record<string, unknown> | undefined {
  const result = resultOf(answer);
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  try {
    return JSON.parse(textOf(answer)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the global `fetch` for the duration of a test with one that:
 *   • passes loopback traffic straight through, so the rig can still talk to
 *     its own HTTP listener (a blanket stub would sever the test from the
 *     server under test);
 *   • answers the Avito token endpoint;
 *   • answers everything else from `respond`, defaulting to `{ ok: true }`.
 *
 * Callers must `vi.unstubAllGlobals()` (or let a global `afterEach` do it).
 */
export function stubAvitoFetch(
  respond?: (url: string, init?: RequestInit) => Response | undefined,
): ReturnType<typeof vi.fn> {
  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const mock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return realFetch(input as Parameters<typeof realFetch>[0], init);
    }
    if (url.includes('/token')) {
      return json({ access_token: 'tk', expires_in: 3600, token_type: 'bearer' });
    }
    return respond?.(url, init) ?? json({ ok: true });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export { closeRigs, errorOf, resultOf };
export type { Answer, Rig };
