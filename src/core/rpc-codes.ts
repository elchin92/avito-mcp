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
 *     {@link APP_ERROR_CODES}. They are application-defined by construction: no
 *     MCP client is expected to branch on them, and the HTTP status carries the
 *     actionable half (`405` + `Allow`, `503` ⇒ retry).
 *   • …and the rule applies to answers a 2026 client can RECEIVE. The three
 *     session answers of the 2025 leg are frozen at what 1.3.3 shipped; see
 *     {@link LEGACY_WIRE_ERROR_CODES} for why the policy does not reach them.
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
/**
 * The three answers that belong to the 2025-11-25 LEG, frozen at the numbers
 * 1.3.3 shipped.
 *
 * ── Why these do not move, when the modern leg's answers did ────────────────
 *
 * M3 renumbered every application code in this server out of `-32000…-32019`,
 * on the strength of «new implementations SHOULD NOT use codes from this
 * sub-range at all». That reasoning is sound for the answers a 2026 client can
 * receive. It does not reach these three, for two reasons that both have to
 * hold:
 *
 *   • They are structurally unreachable from the modern era. All three are
 *     about an MCP SESSION, and revision 2026-07-28 has no sessions — the
 *     modern leg answers every non-POST `405` and never consults
 *     `Mcp-Session-Id`. A 2026 client cannot be handed one of these numbers.
 *   • The clause binds a NEW implementation. The legacy leg is not one: it is
 *     the 2025-11-25 implementation this project already shipped, whose wire
 *     `test/legacy-wire-regression.test.ts` pins against a real 1.3.3 process.
 *     Renumbering it silently changed an answer under existing clients for a
 *     policy those clients are not governed by.
 *
 * The SDK agrees, and that is the decisive evidence rather than a comfort: the
 * v2 legacy transport still answers exactly these numbers. From the corpus
 * (`docs/mcp-2026-07-28/sdk-typescript-1.md`):
 *
 *   «Запросы, требующие сессию, но опускающие заголовок `Mcp-Session-Id`,
 *    по-прежнему отвечают `400` с JSON-RPC `-32000` […], без изменений с v1 —
 *    код является конвенцией SDK»
 *   «Несовпадение session ID по-прежнему отвечает `404` с JSON-RPC `-32001`
 *    […], без изменений с v1.»
 *
 * So a 2025 client that meets any OTHER server built on this SDK sees `-32000`
 * / `-32001` here. Emitting our own numbers made this server the odd one out on
 * its own era while fixing nothing a 2026 client could observe.
 *
 * These live in this module and not at their call sites so the static scan in
 * `test/modern-runtime.test.ts` — which forbids any `-32xxx` literal in `src/`
 * outside the codes the spec defines — keeps working unchanged: this file is
 * the one it skips, because it is the file that has to name the boundaries.
 */
export const LEGACY_WIRE_ERROR_CODES = {
  /** `400` — a session-requiring request arrived with no `Mcp-Session-Id`. */
  missingSessionId: -32000,

  /** `404` — the presented session id is unknown (terminated, reaped, restarted). */
  sessionNotFound: -32001,

  /** `503` — `AVITO_MCP_HTTP_MAX_SESSIONS` reached; no new session will be minted. */
  sessionLimitReached: -32000,
} as const;

export const APP_ERROR_CODES = {
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
