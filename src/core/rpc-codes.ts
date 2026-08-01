/**
 * The JSON-RPC error codes this server allocates for itself.
 *
 * ── Why they live outside `-32768…-32000` ───────────────────────────────────
 *
 * Revision 2026-07-28 partitioned the implementation-defined server-error range
 * and closed the half this code used to draw from:
 *
 *   «`-32000` to `-32019` — legacy. Codes in this sub-range were allocated by
 *    implementations before this policy was introduced. New codes MUST NOT be
 *    allocated in this sub-range, and new implementations SHOULD NOT use codes
 *    from this sub-range at all. Apart from `-32002`, receivers MUST NOT assume
 *    any specific meaning for these codes.»
 *
 *   «`-32020` to `-32099` — reserved for the MCP specification. […]
 *    Implementations MUST NOT emit any code from this sub-range that is not
 *    defined by this specification.»
 *
 *   «New error codes for purposes not defined by this specification SHOULD be
 *    allocated outside the JSON-RPC reserved range (`-32768` to `-32000`).»
 *
 * (`docs/mcp-2026-07-28/basic.md`, quoting `specification/2026-07-28/basic`.)
 *
 * So the rule applied here is:
 *
 *   • A condition the base JSON-RPC vocabulary already names keeps its base
 *     code. "A required field is absent" is `-32602`; a body that is not JSON
 *     is `-32700`. The research corpus assigns our missing-session-id case to
 *     `-32602` by name (`basic.md`, "Убрать коды -32000 и -32001 из HTTP-слоя").
 *   • Everything else — conditions the protocol does not model at all, which is
 *     to say TRANSPORT-CAPACITY and TRANSPORT-SHAPE answers — gets a code from
 *     the block below. They are application-defined by construction: no MCP
 *     client is expected to branch on them, and the HTTP status carries the
 *     actionable half (`404` ⇒ re-initialize, `405` + `Allow`, `503` ⇒ retry).
 *
 * ── Why a block starting at -31000 ──────────────────────────────────────────
 *
 * `-31000` and up are strictly greater than `-32000`, so the whole block is
 * outside the reserved range with no arithmetic to get wrong, while staying
 * negative — which is what tooling that eyeballs a JSON-RPC error expects. The
 * values are a stable part of the public contract once shipped: they are
 * asserted in `test/modern-hardening.test.ts` and must not be renumbered
 * without a CHANGELOG entry.
 */
export const APP_ERROR_CODES = {
  /**
   * `404` — a session id was presented that this process does not know
   * (terminated, reaped, or lost to a restart). Legacy leg only: the modern era
   * has no sessions.
   *
   * Was `-32001`, which the revision additionally RENUMBERED into the spec's
   * own `HeaderMismatch` slot in an earlier draft — so the old value did not
   * merely come from a closed sub-range, it collided in meaning.
   */
  sessionNotFound: -31001,

  /**
   * `503` — the legacy leg refuses to mint another session because
   * `AVITO_MCP_HTTP_MAX_SESSIONS` is reached. Was `-32000`.
   */
  sessionLimitReached: -31002,

  /**
   * `405` — the modern era serves POST only (the revision removed the GET
   * stream and the DELETE teardown). Was `-32000`, copied from the SDK's own
   * `modernOnlyStrictRejection`, whose value is grandfathered SDK usage and not
   * something a new implementation may adopt.
   */
  methodNotAllowed: -31003,

  /**
   * `503` — `AVITO_MCP_HTTP_MAX_INFLIGHT` reached: too many modern exchanges are
   * being processed at once. New in M3.8; there was no code here before because
   * there was no limit.
   */
  inflightLimitReached: -31004,

  /**
   * `503` — `AVITO_MCP_HTTP_MAX_STREAMS` reached: too many long-lived
   * `subscriptions/listen` streams are open.
   */
  streamLimitReached: -31005,
} as const;

/** True for a code the 2026-07-28 allocation policy closed to new implementations. */
export function isLegacySubRangeCode(code: number): boolean {
  return code <= -32000 && code >= -32019;
}

/** The three codes revision 2026-07-28 defines in the sub-range it reserved. */
export const SPEC_RESERVED_CODES: readonly number[] = [-32020, -32021, -32022];
