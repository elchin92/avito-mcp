/**
 * The legacy-wire regression bench: one sequence of HTTP/JSON-RPC exchanges,
 * runnable against ANY avito-mcp process, plus the normalisation that makes two
 * such runs comparable.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Every other 2025-era assertion in this repository compares the branch with
 * ITSELF: `test/http-dual-era.test.ts` runs `era=dual` against `era=legacy`,
 * `test/protocol-era.test.ts` runs the era matrix, and `test/wire-conformance.ts`
 * pins `schema_hash` — which covers tool INPUT SCHEMAS and nothing else. A
 * change that moves the same way on both sides of a self-comparison is
 * invisible to all of them, and `schema_hash` says nothing at all about the
 * shape of an error. That blind spot is exactly where the divergences found in
 * this stage were living: error text, error `data`, and — for an unknown tool —
 * whether the answer is a `result` with `isError: true` or a JSON-RPC `error`.
 *
 * So the reference here is not the branch. It is the REAL published 1.3.3
 * build: `node dist/server.js` out of a 1.3.3 checkout, booted as its own
 * process on its own port, driven over real HTTP.
 *
 * ── How the reference survives CI ───────────────────────────────────────────
 * CI has no 1.3.3 checkout, so the bench cannot boot the reference there. The
 * reference answers are therefore CAPTURED once, by
 * `scripts/capture-legacy-baseline.ts`, into
 * `test/baselines/legacy-1.3.3-wire.json`, and committed. The capture records
 * where it came from (`$provenance`), and the suite refuses a baseline whose
 * provenance does not say 1.3.3 — a snapshot regenerated against the branch
 * itself would make the bench self-referential again, which is the precise
 * failure this file was written to end.
 *
 * WEAK SPOT, STATED PLAINLY: a committed snapshot is only as honest as the last
 * person who regenerated it. Nothing in CI can tell "the baseline was refreshed
 * because 1.3.3 was re-measured" from "the baseline was refreshed until the
 * suite went green". The mitigations are procedural, not mechanical: the
 * capture script only ever talks to a foreign entrypoint (it will not point at
 * `src/`), the snapshot carries the reference's `/healthz` version, and a
 * regeneration is a reviewable diff in its own file. Treat a commit that
 * touches `test/baselines/` as a wire-compatibility decision, not a test fix.
 *
 * ── What "the same" means here ──────────────────────────────────────────────
 * Structural, not byte-for-byte: keys are sorted before comparison, so the
 * known M2 artefact (`"$schema"` moving from index 0 to index 1 inside every
 * `inputSchema`) is deliberately NOT flagged — it is a JSON key-order change
 * with no semantic content. Everything else about an answer is compared: HTTP
 * status, response content-type family, presence of the session header, and the
 * full JSON-RPC frame — including which of `result` / `error` it carries, the
 * numeric code, the message string, and the presence and content of `data`.
 *
 * THREE kinds of difference are allowed, and all are declared in the plan
 * itself rather than waved through:
 *
 *   • {@link KnownAddition} — three new keys on `avito://state/config`, a
 *     diagnostic mirror of the process's own settings. Declared per FIELD, with
 *     the value each must hold, so nothing else in that answer may move.
 *   • {@link DeclaredDivergence} — one call (`27-tools-call-no-arguments`) that
 *     1.3.3 REFUSED and this branch accepts, because 1.3.3 was refusing a
 *     well-formed request. Declared with both sides' values at every checked
 *     path, so the declaration fails the day it stops being true.
 *   • {@link RebasedValue} — the digest of `avito://docs/safety`, which is a
 *     property of `docs/safety.md` and not of the wire. Recomputed from the
 *     live file, which makes the assertion stricter than the frozen one: the
 *     branch must serve that file byte for byte.
 *
 * Nothing else in this file may differ.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** The revision the legacy leg speaks. Fixed: this bench is about 1.3.3. */
export const BENCH_PROTOCOL_VERSION = '2025-11-25';

/** Where the captured reference answers live, relative to the repository root. */
export const BASELINE_RELATIVE_PATH = join('test', 'baselines', 'legacy-1.3.3-wire.json');

/** The repository root of THIS checkout (test/support/ → ../..). */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

export const BASELINE_PATH = join(REPO_ROOT, BASELINE_RELATIVE_PATH);

/** The version the reference build must report on `/healthz`. */
export const REFERENCE_VERSION = '1.3.3';

// ───────────────────────────── canonicalisation ─────────────────────────────

/**
 * Recursively sorts object keys so two structurally equal values serialise
 * identically. Array order is preserved — order is meaning in `tools/list` and
 * in `content` arrays.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The value at `path`, or `undefined` if any step of it is missing. */
export function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * A deep copy of `value` with every declared addition inserted.
 *
 * Copies rather than mutates: the baseline is parsed once for the whole file,
 * and a step that edited it in place would leak into every step after it.
 * Throws when the parent of a path does not exist — a mis-typed path must be a
 * loud failure, not a silently skipped assertion.
 */
export function applyKnownAdditions(
  value: unknown,
  additions: readonly KnownAddition[] = [],
): unknown {
  const out = structuredClone(value);
  for (const addition of additions) {
    const parentPath = addition.path.slice(0, -1);
    const leaf = addition.path[addition.path.length - 1]!;
    const parent = readPath(out, parentPath);
    if (parent === null || typeof parent !== 'object') {
      throw new Error(
        `known addition ${addition.path.join('.')} has no parent in the reference answer`,
      );
    }
    (parent as Record<string, unknown>)[leaf] = addition.value;
  }
  return out;
}

/**
 * A value in the captured 1.3.3 answer that is a function of a REPOSITORY FILE
 * rather than of the protocol.
 *
 * `avito://docs/safety` serves `docs/safety.md` verbatim, so its digest moves
 * whenever the documentation is edited — and documentation is edited by commits
 * that touch no protocol code at all. Comparing it against a value frozen at
 * 1.3.3 turns every such commit into "the legacy wire moved", which is the one
 * verdict this bench must never produce by accident; the pressure to silence
 * that would land on the bench rather than on the code.
 *
 * A rebase says: this path's reference value is recomputed from the live file
 * before comparison. What it leaves standing is STRONGER than the frozen value,
 * not weaker — the branch must serve that file byte for byte — while everything
 * else in the answer (uri, mimeType, the first line, the envelope, the shape)
 * is still compared against 1.3.3 as captured.
 *
 * A rebase whose path does not already exist in the capture is a typo, and the
 * test says so rather than quietly asserting nothing.
 */
export interface RebasedValue {
  readonly path: readonly string[];
  /** Recomputed at comparison time from whatever the answer is derived from. */
  readonly value: () => unknown;
  readonly why: string;
}

/** A deep copy of `value` with every rebased path recomputed from live sources. */
export function applyRebases(value: unknown, rebases: readonly RebasedValue[] = []): unknown {
  const out = structuredClone(value);
  for (const rebase of rebases) {
    const parentPath = rebase.path.slice(0, -1);
    const leaf = rebase.path[rebase.path.length - 1]!;
    const parent = readPath(out, parentPath);
    if (parent === null || typeof parent !== 'object') {
      throw new Error(`rebase ${rebase.path.join('.')} has no parent in the reference answer`);
    }
    (parent as Record<string, unknown>)[leaf] = rebase.value();
  }
  return out;
}

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
    .slice(0, 32);
}

// ───────────────────────────────── the plan ─────────────────────────────────

/**
 * A field this branch adds to an answer that 1.3.3 did not have, DECLARED.
 *
 * The bench's verdict is "the legacy wire moved", so an exception to it has to
 * be narrower than "this step is allowed to differ". A `KnownAddition` names one
 * path, one value and one reason; the comparison then inserts it into the
 * REFERENCE and demands equality on everything else. That keeps every property
 * of the assertion except the single reviewed key:
 *
 *   • drop the field  ⇒ red (the reference now has it and the branch does not);
 *   • change its value ⇒ red (the declared value is the one that must appear);
 *   • add a SECOND field ⇒ red (nothing declared it);
 *   • and the step also fails if the reference turns out to have the key after
 *     all, so an allowance cannot outlive the reason for it.
 *
 * Use only where the difference is a decision someone made, not an accident.
 */
export interface KnownAddition {
  /** Path into the recorded answer; array elements are addressed by index. */
  readonly path: readonly string[];
  /** The value the branch must produce there. */
  readonly value: unknown;
  /** Why this is a decision rather than a regression. */
  readonly why: string;
}

/**
 * A place where this branch DELIBERATELY does not reproduce 1.3.3.
 *
 * Distinct from {@link KnownAddition}, which is a field that grew on an answer
 * that is otherwise identical. A divergence is a different ANSWER, and it is
 * only ever the right call when reproducing 1.3.3 would mean re-introducing a
 * defect: the compatibility contract exists to stop clients breaking, and a
 * request that 1.3.3 REFUSED and this branch accepts breaks nobody.
 *
 * Declaring one costs more than allowing one, on purpose. Each `facts` entry
 * names a path and BOTH values — what 1.3.3 answers there and what this branch
 * answers — so the step fails if either side moves, and fails if the two ever
 * stop differing (a stale declaration is as bad as an undetected regression).
 * The rest of the answer is not compared, which is why a divergence has to be
 * argued in `why` rather than merely noted.
 */
export interface DeclaredDivergence {
  /** The argument for not reproducing 1.3.3 here. Read in review; keep it complete. */
  readonly why: string;
  readonly facts: readonly {
    readonly path: readonly string[];
    /** What the captured 1.3.3 answer holds at `path`. */
    readonly reference: unknown;
    /** What this branch must hold at `path`. Must not equal `reference`. */
    readonly branch: unknown;
  }[];
}

export interface WireStep {
  /** Stable identifier; it is the key in the baseline and the test name. */
  id: string;
  /** Why the step is in the plan — printed with the assertion. */
  note: string;
  /** Reviewed, per-field differences from 1.3.3. See {@link KnownAddition}. */
  knownAdditions?: readonly KnownAddition[];
  /** A reviewed, argued refusal to reproduce 1.3.3. See {@link DeclaredDivergence}. */
  divergence?: DeclaredDivergence;
  /** Reference values recomputed from live repository files. See {@link RebasedValue}. */
  rebase?: readonly RebasedValue[];
  /** JSON-RPC method, or `null` for the raw-HTTP probes below. */
  method: string | null;
  params?: Record<string, unknown>;
  /**
   * The whole JSON-RPC frame, replacing `method`/`params`/`id`.
   *
   * Two classes of step need this and cannot be expressed any other way. A
   * MALFORMED frame — `params` absent, `name` of the wrong type — cannot be
   * built from a `Record<string, unknown>` typed `params`, and `id` has to stay
   * under the step's control so a rejection can be matched to it. And an
   * UNREADABLE body is by definition not a frame at all: the bytes are the test.
   *
   * A step that sets this must still say what it is doing in `method`, which
   * becomes documentation rather than an instruction — `captureWire` sends these
   * bytes verbatim.
   */
  rawBody?: string;
  /** Overrides the request content type. Only useful with {@link rawBody}. */
  contentType?: string;
  /** A notification carries no `id` and expects no JSON-RPC answer. */
  notification?: boolean;
  /** Sent before the session exists / with a deliberately wrong session id. */
  session?: 'none' | 'bogus';
  /** Raw HTTP override for the non-POST probes. */
  http?: { method: 'GET' | 'DELETE' };
  /**
   * Shrinks a bulky positive payload before it is stored and compared. Only
   * used where the full body is hundreds of kilobytes AND is already pinned
   * elsewhere (`schema_hash`, `test/manifest-snapshot.test.ts`); the reducer
   * still fails on any content change, and names the element that moved.
   */
  condense?: (body: unknown) => unknown;
}

type Frame = { result?: unknown; error?: unknown } & Record<string, unknown>;

function resultOf(body: unknown): Record<string, unknown> | undefined {
  return (body as { result?: Record<string, unknown> } | null)?.result;
}

/** `tools/list` → the ordered name list plus a per-tool digest. */
function condenseToolList(body: unknown): unknown {
  const tools = resultOf(body)?.tools;
  if (!Array.isArray(tools)) return { unexpected: body };
  return {
    envelope: { ...(body as Frame), result: { toolCount: tools.length } },
    names: tools.map((tool) => (tool as { name?: string }).name ?? '<unnamed>'),
    perTool: Object.fromEntries(
      tools.map((tool) => [(tool as { name?: string }).name ?? '<unnamed>', digest(tool)]),
    ),
  };
}

/** The exact bytes `avito://docs/safety` is supposed to be serving right now. */
function safetyDocument(): string {
  return readFileSync(join(REPO_ROOT, 'docs', 'safety.md'), 'utf8');
}

/** A `resources/read` whose text is a large document: digest plus a shape probe. */
function condenseDocument(body: unknown): unknown {
  const contents = resultOf(body)?.contents;
  if (!Array.isArray(contents)) return { unexpected: body };
  return {
    envelope: { ...(body as Frame), result: { contentCount: contents.length } },
    contents: contents.map((entry) => {
      const item = entry as Record<string, unknown>;
      const text = typeof item.text === 'string' ? item.text : null;
      return {
        ...item,
        text:
          text === null
            ? null
            : { length: text.length, firstLine: text.split('\n', 1)[0], sha256: digest(text) },
      };
    }),
  };
}

/**
 * `avito://state/config` renders the effective configuration as JSON INSIDE a
 * string, so the one genuinely run-dependent value left in it — the ephemeral
 * port — is a number the generic normaliser cannot see. Masking it here, by
 * path, is deliberate: the alternative (rewriting every occurrence of the
 * port's digits anywhere in any string) would eventually rewrite a five-digit
 * number that legitimately occurs in a swagger or a manifest, and would do it
 * on only one side of the comparison. That is a flaky "the wire changed", which
 * is the one verdict this bench must never produce by accident.
 */
function condenseConfigSnapshot(body: unknown): unknown {
  const contents = resultOf(body)?.contents;
  if (!Array.isArray(contents) || contents.length !== 1) return { unexpected: body };
  const item = contents[0] as Record<string, unknown>;
  if (typeof item.text !== 'string') return { unexpected: body };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(item.text) as Record<string, unknown>;
  } catch {
    return { unparseable: item.text };
  }
  const config = parsed.config as Record<string, unknown> | undefined;
  const http = config?.http as Record<string, unknown> | undefined;
  if (http && 'port' in http) http.port = '<port>';
  const envelope: Record<string, unknown> = { ...(body as Frame) };
  delete envelope.result;
  return { envelope, contents: [{ ...item, text: parsed }] };
}

/** `meta_capabilities` answers with the whole tool registry inside its text. */
function condenseCapabilities(body: unknown): unknown {
  const content = resultOf(body)?.content;
  if (!Array.isArray(content) || content.length !== 1) return { unexpected: body };
  const text = (content[0] as { text?: string }).text;
  if (typeof text !== 'string') return { unexpected: body };
  // The envelope is kept on EVERY branch, including the failure ones: a step
  // that condenses a big positive answer may also be used where the answer is a
  // small tool error, and losing `isError` there would hide the one bit that
  // says which of the two happened.
  const envelope = { ...(body as Frame), result: { isError: resultOf(body)?.isError ?? false } };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { envelope, unparseable: text };
  }
  const { tools, ...rest } = parsed;
  return {
    envelope,
    payload: rest,
    toolCount: Array.isArray(tools) ? tools.length : null,
    toolsSha256: digest(tools),
  };
}

/**
 * The sequence, in execution order. Divergence hunting drove the selection: the
 * five error scenarios named in the acceptance criteria are here, each next to
 * the positive answer for the same method, so a red step always has a green
 * neighbour proving the transport itself is fine.
 */
export const LEGACY_WIRE_STEPS: readonly WireStep[] = [
  {
    id: '01-initialize',
    note: 'the handshake: revision, capabilities, serverInfo and instructions',
    method: 'initialize',
    params: {
      protocolVersion: BENCH_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'legacy-wire-bench', version: '1.0.0' },
    },
  },
  {
    id: '02-notifications-initialized',
    note: 'the notification that opens the session — 202 and an empty body',
    method: 'notifications/initialized',
    notification: true,
  },
  { id: '03-ping', note: 'the empty-result baseline', method: 'ping' },
  {
    id: '04-tools-list',
    note: 'the full tool surface (names, order and per-tool digest)',
    method: 'tools/list',
    condense: condenseToolList,
  },
  { id: '05-prompts-list', note: 'the prompt surface', method: 'prompts/list' },
  { id: '06-resources-list', note: 'the static resource surface', method: 'resources/list' },
  {
    id: '07-resources-templates-list',
    note: 'the templated resource surface',
    method: 'resources/templates/list',
  },
  {
    id: '08-resources-read-existing',
    note: 'a registered resource answers with its contents',
    method: 'resources/read',
    params: { uri: 'avito://docs/safety' },
    condense: condenseDocument,
    // This resource is `docs/safety.md`, verbatim. Its digest is a property of
    // the documentation, not of the wire, and the documentation is edited by
    // commits that touch no protocol code — M5.8 recorded the x-mcp-header
    // decision there, for one. Everything else about the answer still has to
    // match 1.3.3 exactly; these two paths are recomputed from the file so the
    // assertion becomes "the branch serves the current file byte for byte".
    rebase: [
      {
        path: ['body', 'contents', '0', 'text', 'length'],
        value: () => safetyDocument().length,
        why: 'docs/safety.md is documentation; its length moves with every edit to it and with nothing else.',
      },
      {
        path: ['body', 'contents', '0', 'text', 'sha256'],
        value: () => digest(safetyDocument()),
        why: 'Same file. Pinning the branch to the live digest still proves the resource returns that file unmodified.',
      },
    ],
  },
  {
    id: '09-resources-read-manifest',
    note: 'the manifest resource — the published tool registry',
    method: 'resources/read',
    params: { uri: 'avito://manifest' },
    condense: condenseDocument,
  },
  {
    id: '10-resources-read-config',
    note: 'the sanitised config snapshot a legacy client can read',
    method: 'resources/read',
    params: { uri: 'avito://state/config' },
    condense: condenseConfigSnapshot,
    // The ONE declared difference in this bench. `avito://state/config` is a
    // diagnostic mirror of the process's own configuration, not a protocol
    // surface: its keys are whatever this deployment is configured with, and
    // they already differ between any two deployments. M3 gave the process
    // three new settings, so three new keys appear here.
    //
    // Filtering them back out was the alternative and it is the worse answer:
    // on a `dual` deployment the modern leg IS bounded by maxInflight/
    // maxStreams, and an operator debugging a `503` would be reading a snapshot
    // that hid the limit that produced it. A diagnostic resource that lies
    // about live configuration is a worse defect than a JSON object growing a
    // key that no 1.3.x client reads by position.
    knownAdditions: [
      {
        path: ['body', 'contents', '0', 'text', 'config', 'protocolEra'],
        value: 'legacy',
        why: 'AVITO_MCP_PROTOCOL_ERA, new in M3. Reporting which wire this process serves is the single most useful line in a diagnostic snapshot of a dual-era build.',
      },
      {
        path: ['body', 'contents', '0', 'text', 'config', 'http', 'maxInflight'],
        value: 64,
        why: 'AVITO_MCP_HTTP_MAX_INFLIGHT, new in M3.8: the modern leg has no sessions to cap, so concurrency is bounded here instead. Hiding it would hide the cause of a 503.',
      },
      {
        path: ['body', 'contents', '0', 'text', 'config', 'http', 'maxStreams'],
        value: 32,
        why: 'AVITO_MCP_HTTP_MAX_STREAMS, new in M3.8: the bound on open subscriptions/listen streams, for the same reason.',
      },
    ],
  },
  {
    id: '11-resources-read-unregistered',
    note: 'SCENARIO 2 — resources/read on an unregistered URI (avito://nope)',
    method: 'resources/read',
    params: { uri: 'avito://nope' },
  },
  {
    id: '12-resources-read-traversal',
    note: 'SCENARIO 3 — resources/read with a path-traversal attempt (../../)',
    method: 'resources/read',
    params: { uri: 'avito://swaggers/../../etc/passwd' },
  },
  {
    id: '13-resources-subscribe',
    note: 'subscribe to the subscribable state resource',
    method: 'resources/subscribe',
    params: { uri: 'avito://state/pending-actions' },
  },
  {
    id: '14-resources-unsubscribe',
    note: 'and release it again',
    method: 'resources/unsubscribe',
    params: { uri: 'avito://state/pending-actions' },
  },
  {
    id: '15-tools-call-ok',
    note: 'a tool call that succeeds without touching the network',
    method: 'tools/call',
    params: { name: 'meta_capabilities', arguments: {} },
    condense: condenseCapabilities,
  },
  {
    id: '16-tools-call-unknown',
    note: 'SCENARIO 1 — tools/call naming a tool that does not exist',
    method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  },
  {
    id: '17-tools-call-invalid-arguments',
    note: 'SCENARIO 4 — tools/call whose arguments fail input validation',
    method: 'tools/call',
    params: { name: 'meta_confirm_action', arguments: {} },
  },
  {
    id: '18-prompts-get-existing',
    note: 'a registered prompt renders',
    method: 'prompts/get',
    params: { name: 'avito_daily_overview', arguments: {} },
  },
  {
    id: '19-prompts-get-unknown',
    note: 'SCENARIO 5 — prompts/get naming a prompt that does not exist',
    method: 'prompts/get',
    params: { name: 'no_such_prompt', arguments: {} },
  },
  {
    id: '20-logging-set-level',
    note: 'logging/setLevel is accepted and answers with an empty result',
    method: 'logging/setLevel',
    params: { level: 'debug' },
  },
  {
    id: '21-unknown-method',
    note: 'an unknown JSON-RPC method',
    method: 'no_such/method',
  },
  {
    id: '22-http-session-missing',
    note: 'a POST with no Mcp-Session-Id at all',
    method: 'tools/list',
    session: 'none',
  },
  {
    id: '23-http-session-unknown',
    note: 'a POST quoting a session id the server never issued',
    method: 'tools/list',
    session: 'bogus',
  },
  {
    id: '24-http-get',
    note: 'GET /mcp without a session',
    method: null,
    session: 'none',
    http: { method: 'GET' },
  },
  {
    id: '25-http-delete',
    note: 'DELETE /mcp without a session',
    method: null,
    session: 'none',
    http: { method: 'DELETE' },
  },
  // ── the neighbours of the five reported scenarios ─────────────────────────
  //
  // Added after the five were fixed, precisely because a fix aimed at one cell
  // of a table is the classic way to leave the cell next to it broken. Each of
  // these reaches the SAME SDK code path as a step above, one branch over:
  // the other side of the tool-lookup test, the other error the `resources/read`
  // dispatcher can raise, the template callback rather than the dispatcher, the
  // argument validator of a different primitive, and the arguments-absent form
  // of a call the plan already makes with `arguments: {}`.
  {
    id: '26-tools-call-hidden-tool',
    note: 'tools/call on a tool this deployment’s policy hides (the other half of scenario 1)',
    method: 'tools/call',
    params: { name: 'auth_get_access_token', arguments: {} },
  },
  {
    id: '27-tools-call-no-arguments',
    note: 'tools/call with the `arguments` member absent rather than empty',
    method: 'tools/call',
    params: { name: 'meta_capabilities' },
    condense: condenseCapabilities,
    divergence: {
      why:
        '1.3.3 REFUSES this call. SDK v1 validated `request.params.arguments` as it ' +
        'arrived, so an absent member reached `z.object({})` as `undefined` and failed ' +
        'with "expected object, received undefined" — for every tool, including the ones ' +
        'that take no arguments at all. But `arguments` is OPTIONAL in CallToolRequest on ' +
        'revision 2025-11-25, so 1.3.3 was rejecting a well-formed request; SDK v2 ' +
        'normalises it (`validateToolInput(tool, args ?? {})`) and the call succeeds. ' +
        'Reproducing 1.3.3 here would mean deliberately re-introducing that refusal. The ' +
        'compatibility contract is there so that clients which WORKED keep working, and ' +
        'no client can depend on a rejection: accepting more than 1.3.3 accepted cannot ' +
        'break one. So this stays fixed, and the difference is declared rather than hidden.',
      facts: [
        // Same path, both sides: 1.3.3 answers a tool error whose text is not
        // JSON at all, this branch answers the capabilities payload.
        { path: ['body', 'envelope', 'result', 'isError'], reference: true, branch: false },
        { path: ['body', 'toolCount'], reference: undefined, branch: 148 },
      ],
    },
  },
  {
    id: '28-resources-read-invalid-uri',
    note: 'resources/read whose uri does not parse as a URI at all',
    method: 'resources/read',
    params: { uri: 'not a uri' },
  },
  {
    id: '29-resources-read-missing-swagger',
    note: 'resources/read reaching the swagger TEMPLATE callback, not the dispatcher',
    method: 'resources/read',
    params: { uri: 'avito://swaggers/no_such_swagger' },
  },
  {
    id: '30-prompts-get-bad-arguments',
    note: 'prompts/get on a real prompt with its required argument missing',
    method: 'prompts/get',
    params: { name: 'avito_explain_tool', arguments: {} },
  },
  // ── a MALFORMED tools/call FRAME ──────────────────────────────────────────
  //
  // Steps 15–17 and 26–27 all send a WELL-FORMED `tools/call`: a `params`
  // object with a `name` string in it. Every one of them therefore reaches the
  // SDK's tool dispatch, which is the code `src/core/wire-errors.ts` reshapes.
  // Nothing in the plan sent a frame that fails BEFORE dispatch — where v2 added
  // a codec validation step (`Server._wrapHandler`, `tools/call` only) that v1
  // did not have. So the whole class was invisible: v1 let a `ZodError` escape
  // the handler and answered `-32603` with the pretty-printed ISSUE ARRAY as the
  // message; v2 catches the same failure first and answers `-32602 Invalid
  // tools/call request: <the same array>`. Both the code and the wording moved,
  // on the single most-called method in the protocol.
  //
  // Four inputs, chosen to cover the distinct shapes the codec can refuse: a
  // required member absent, the whole `params` object absent, a required member
  // of the wrong type, and an OPTIONAL member of the wrong type. The fourth is
  // the one that proves the class is about validation and not about `name`
  // specifically — `arguments` is optional (step 27 omits it and succeeds), so
  // the only way to fail on it is to send it wrong.
  {
    id: '31-tools-call-name-absent',
    note: 'REGRESSION 1a — a tools/call frame whose params carry no `name`',
    method: 'tools/call',
    rawBody: JSON.stringify({
      jsonrpc: '2.0',
      id: '31-tools-call-name-absent',
      method: 'tools/call',
      params: { arguments: {} },
    }),
  },
  {
    id: '32-tools-call-params-absent',
    note: 'REGRESSION 1b — a tools/call frame with no `params` member at all',
    method: 'tools/call',
    rawBody: JSON.stringify({
      jsonrpc: '2.0',
      id: '32-tools-call-params-absent',
      method: 'tools/call',
    }),
  },
  {
    id: '33-tools-call-name-wrong-type',
    note: 'REGRESSION 1c — tools/call whose `name` is a number',
    method: 'tools/call',
    rawBody: JSON.stringify({
      jsonrpc: '2.0',
      id: '33-tools-call-name-wrong-type',
      method: 'tools/call',
      params: { name: 42, arguments: {} },
    }),
  },
  {
    id: '34-tools-call-arguments-wrong-type',
    note: 'REGRESSION 1d — tools/call whose optional `arguments` is a string',
    method: 'tools/call',
    rawBody: JSON.stringify({
      jsonrpc: '2.0',
      id: '34-tools-call-arguments-wrong-type',
      method: 'tools/call',
      params: { name: 'meta_capabilities', arguments: 'not an object' },
    }),
  },
  // The neighbours of the class, both directions.
  //
  // v2's pre-dispatch codec validation is installed for `tools/call` AND FOR
  // NOTHING ELSE, so the same malformation on another primitive still takes v1's
  // route. Pinning two of them here is what stops a fix aimed at `tools/call`
  // from being written as a blanket rule that drags these with it — the failure
  // mode of every repair in `src/core/wire-errors.ts` so far.
  {
    id: '35-resources-read-uri-absent',
    note: 'the same malformation on resources/read, which v2 does NOT pre-validate',
    method: 'resources/read',
    params: {},
  },
  {
    id: '36-prompts-get-name-absent',
    note: 'the same malformation on prompts/get, for the same reason',
    method: 'prompts/get',
    params: {},
  },
  {
    id: '37-tools-call-params-null',
    note: 'tools/call with `params: null` — refused by the TRANSPORT, above any era',
    method: 'tools/call',
    rawBody: JSON.stringify({
      jsonrpc: '2.0',
      id: '37-tools-call-params-null',
      method: 'tools/call',
      params: null,
    }),
  },
  // ── an UNREADABLE request body ────────────────────────────────────────────
  //
  // Every step above carries a body that at least PARSES as JSON, so the plan
  // never exercised the layer below the protocol. 1.3.3 let `express.json()`
  // throw and answered its app-wide `400 {"error":"bad_request"}` — not a
  // JSON-RPC frame at all. This branch answers `-32700` there, which is the
  // right answer on revision 2026-07-28 (`ParseError`, `PARSE_ERROR = -32700`;
  // `docs/mcp-2026-07-28/schema-2.md`) and the wrong one for a 2025 client that
  // was shipped the other. Three bodies, because `express.json()` refuses for
  // three different reasons and only one of them is "not JSON".
  {
    id: '38-body-truncated-json',
    note: 'REGRESSION 2a — a body that stops mid-frame',
    method: null,
    rawBody: '{"jsonrpc":"2.0","id":"38-body-truncated-json",',
  },
  {
    id: '39-body-not-json',
    note: 'REGRESSION 2b — a body that is not JSON at all',
    method: null,
    rawBody: 'this is not json',
  },
  {
    id: '40-body-json-but-not-an-object',
    note: 'REGRESSION 2c — valid JSON that express.json() refuses in strict mode',
    method: null,
    rawBody: '"hello"',
  },
  // The neighbours of THAT class: the two body failures 1.3.3 already answered
  // as JSON-RPC, and which therefore must not move when the three above are
  // split by era. An empty body is not a parse failure — `express.json()` hands
  // the MCP layer `{}` and the SDK refuses the envelope — and a wrong media type
  // is refused before any parsing is attempted at all.
  {
    id: '41-body-empty',
    note: 'an empty body: refused by the SDK envelope check, not by express.json()',
    method: null,
    rawBody: '',
  },
  {
    id: '42-body-wrong-content-type',
    note: 'a body under the wrong media type: refused before parsing, with 415',
    method: null,
    rawBody: 'jsonrpc=2.0',
    contentType: 'text/plain',
  },
];

// ────────────────────────────── booting a server ─────────────────────────────

export interface BootOptions {
  /** Argv for the process, e.g. `['node', '/srv/avito_mcp/dist/server.js']`. */
  command: string;
  args: string[];
  /** Working directory — the checkout the entrypoint belongs to. */
  cwd: string;
  /** Scratch directory for the token file and the runtime state. */
  sandbox: string;
  /** Extra environment on top of the fixed bench environment. */
  env?: Record<string, string>;
}

export interface BootedServer {
  base: string;
  host: string;
  port: number;
  sandbox: string;
  /** What `/healthz` reported — the provenance check for a captured baseline. */
  health: { ok?: boolean; name?: string; version?: string };
  stop(): Promise<void>;
  /**
   * Everything the child wrote to stdout AND stderr. Both, because the server
   * logs through pino to stdout: a startup failure (a taken port, a rejected
   * config) would otherwise be invisible in the message this bench prints.
   */
  output(): string;
}

/**
 * The bench binds BELOW the ephemeral range on purpose.
 *
 * Every other rig here takes its port from `listen(0)`, which hands out from
 * `net.ipv4.ip_local_port_range` (32768–60999 by default) — and every one of
 * them has the same unavoidable gap between "probe closed the socket" and "the
 * server bound it". A bench that also drew from that range would occasionally
 * win that race against a sibling suite and make ITS `listen()` fail with
 * EADDRINUSE, i.e. turn a healthy suite red from a neighbouring file. Drawing
 * from 21000–21999 means nothing the kernel auto-assigns can ever land on the
 * bench's port, so the only contender is another bench run — which the probe
 * below sees, and `bootServer` retries past.
 */
const BENCH_PORT_FLOOR = 21_000;
const BENCH_PORT_SPAN = 1_000;

/** True when a port can be bound right now on loopback. */
async function isBindable(port: number): Promise<boolean> {
  const probe = createServer();
  const ok = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (!ok) return false;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return true;
}

async function candidatePort(): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = BENCH_PORT_FLOOR + Math.floor(Math.random() * BENCH_PORT_SPAN);
    if (await isBindable(port)) return port;
  }
  throw new Error(
    `no free port in ${BENCH_PORT_FLOOR}–${BENCH_PORT_FLOOR + BENCH_PORT_SPAN - 1} for the wire bench`,
  );
}

/**
 * The environment both sides are booted with. Identical down to the last
 * variable, because anything that differs here shows up as a wire difference
 * later — `avito://state/config` reflects most of it verbatim.
 *
 * `AVITO_ENV_FILE` points into the sandbox at a file that does not exist, so a
 * developer's real `.env` (and the real Avito credentials in it) can never
 * reach either process.
 */
export function benchEnv(port: number, sandbox: string): Record<string, string> {
  return {
    AVITO_ENV_FILE: join(sandbox, 'absent.env'),
    Client_id: 'bench-client-id',
    Client_secret: 'bench-client-secret',
    Profile_id: '12345678',
    AVITO_BASE_URL: 'https://api.bench.invalid',
    LOG_LEVEL: 'fatal',
    AVITO_MCP_MODE: 'full_access',
    AVITO_MCP_TRANSPORT: 'http',
    AVITO_MCP_HTTP_HOST: '127.0.0.1',
    AVITO_MCP_HTTP_PORT: String(port),
    // Pinned so the ephemeral port cannot reach the wire through the derived
    // public URL (it surfaces in `avito://state/config`, twice).
    AVITO_MCP_HTTP_PUBLIC_URL: 'http://legacy-wire-bench.invalid',
    AVITO_MCP_HTTP_AUTH: 'none',
    AVITO_MCP_HTTP_ALLOW_NO_AUTH: '1',
    AVITO_TOKEN_FILE: join(sandbox, 'token.json'),
    AVITO_MCP_RUNTIME_STATE_DIR: join(sandbox, 'runtime'),
    AVITO_MCP_WEBHOOK_ENABLED: '0',
  };
}

/**
 * Boots the process, waits for `/healthz`, and gives up only when the failure
 * is not a lost port race. `EADDRINUSE` is retried with a fresh port: the
 * bench's whole verdict is "the wire moved", and a verdict that strong must
 * never be produced by two processes wanting the same socket.
 */
export async function bootServer(options: BootOptions): Promise<BootedServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await bootOnce(options);
    } catch (err) {
      lastError = err;
      if (!String(err instanceof Error ? err.message : err).includes('EADDRINUSE')) throw err;
    }
  }
  throw lastError;
}

async function bootOnce(options: BootOptions): Promise<BootedServer> {
  const port = await candidatePort();
  let output = '';
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...benchEnv(port, options.sandbox),
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exited: { code: number | null; signal: string | null } | null = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let health: BootedServer['health'] | null = null;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `${options.command} ${options.args.join(' ')} exited before it listened ` +
          `(${JSON.stringify(exited)})\n${output}`,
      );
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        health = (await res.json()) as BootedServer['health'];
        break;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (health === null) {
    child.kill('SIGKILL');
    throw new Error(`${options.command} ${options.args.join(' ')} never became healthy\n${output}`);
  }

  return {
    base,
    host: `127.0.0.1:${port}`,
    port,
    sandbox: options.sandbox,
    health,
    output: () => output,
    stop: async (): Promise<void> => {
      if (exited !== null) return;
      const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await ended;
      clearTimeout(killer);
    },
  };
}

// ─────────────────────────────── driving the plan ────────────────────────────

export interface WireRecord {
  status: number;
  /** `json`, `sse`, `none`, or the raw header when it is something else. */
  contentType: string;
  /** Normalised: `<session-id>` when present, `null` when absent. */
  sessionHeader: string | null;
  /** `POST`, `GET`, `DELETE` — recorded so a step cannot silently change verb. */
  allow: string | null;
  body: unknown;
}

export type WireCapture = Record<string, WireRecord>;

/** A session id shaped like the real thing but never issued by the server. */
const BOGUS_SESSION_ID = '00000000-0000-4000-8000-000000000000';

function contentTypeFamily(raw: string | null, hasBody: boolean): string {
  if (!hasBody) return 'none';
  if (raw === null) return 'absent';
  if (raw.includes('text/event-stream')) return 'sse';
  if (raw.includes('application/json')) return 'json';
  return raw;
}

/**
 * Replaces the values that legitimately differ between two runs — the session
 * id the server minted, the ephemeral port, the scratch directory — with fixed
 * placeholders. Deliberately narrow: the port is replaced only where it appears
 * as a number equal to the port or inside a `host:port` string, so a five-digit
 * number that happens to occur in a document is never rewritten.
 */
function normalise(
  value: unknown,
  ctx: { sessionId: string | null; port: number; sandbox: string },
): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalise(entry, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalise(entry, ctx);
    }
    return out;
  }
  if (typeof value === 'number') return value === ctx.port ? '<port>' : value;
  if (typeof value === 'string') {
    let text = value;
    if (ctx.sessionId) text = text.split(ctx.sessionId).join('<session-id>');
    text = text.split(`:${ctx.port}`).join(':<port>');
    text = text.split(ctx.sandbox).join('<sandbox>');
    return text;
  }
  return value;
}

async function readBody(res: Response): Promise<{ body: unknown; hasBody: boolean }> {
  const text = await res.text();
  if (!text) return { body: null, hasBody: false };
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    return {
      body: frames.length === 1 ? JSON.parse(frames[0]!) : frames.map((f) => JSON.parse(f)),
      hasBody: true,
    };
  }
  try {
    return { body: JSON.parse(text), hasBody: true };
  } catch {
    return { body: { unparseable: text }, hasBody: true };
  }
}

/**
 * Runs the whole plan against one booted server and returns the normalised
 * answers. The only state carried between steps is the session id the
 * handshake produced — everything else is deliberately stateless so a step can
 * be read in isolation.
 */
export async function captureWire(server: BootedServer): Promise<WireCapture> {
  const out: WireCapture = {};
  let sessionId: string | null = null;

  for (const step of LEGACY_WIRE_STEPS) {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      host: server.host,
    };
    if (step.session === 'bogus') headers['mcp-session-id'] = BOGUS_SESSION_ID;
    else if (step.session !== 'none' && sessionId) headers['mcp-session-id'] = sessionId;

    let body: string | undefined;
    if (step.http === undefined) {
      headers['content-type'] = step.contentType ?? 'application/json';
      body =
        step.rawBody ??
        JSON.stringify({
          jsonrpc: '2.0',
          ...(step.notification ? {} : { id: step.id }),
          method: step.method,
          ...(step.params ? { params: step.params } : {}),
        });
    }

    const res = await fetch(`${server.base}/mcp`, {
      method: step.http?.method ?? 'POST',
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const issued = res.headers.get('mcp-session-id');
    if (step.id === '01-initialize') sessionId = issued;

    const read = await readBody(res);
    const ctx = { sessionId, port: server.port, sandbox: server.sandbox };
    const normalised = normalise(read.body, ctx);

    out[step.id] = {
      status: res.status,
      contentType: contentTypeFamily(res.headers.get('content-type'), read.hasBody),
      sessionHeader: issued === null ? null : issued === sessionId ? '<session-id>' : '<other>',
      allow: res.headers.get('allow'),
      body: canonical(step.condense ? step.condense(normalised) : normalised),
    };
  }
  return out;
}

// ────────────────────────────────── baseline ─────────────────────────────────

export interface BaselineProvenance {
  /** How to regenerate — printed in the failure message. */
  regenerateWith: string;
  capturedAt: string;
  capturedByNode: string;
  reference: {
    /** Absolute path of the entrypoint that answered. NOT this checkout. */
    entrypoint: string;
    /** What that process reported on `/healthz`. */
    health: { ok?: boolean; name?: string; version?: string };
    /** `git rev-parse HEAD` of the reference checkout, when it is a repository. */
    gitHead: string | null;
  };
  warning: string;
}

export interface Baseline {
  $provenance: BaselineProvenance;
  steps: WireCapture;
}

/** A stable, reviewable serialisation — the file is meant to be read in a diff. */
export function serialiseBaseline(baseline: Baseline): string {
  return `${JSON.stringify(canonical(baseline), null, 2)}\n`;
}

/** A throwaway session id, used by the capture script's sandbox naming. */
export function benchRunId(): string {
  return randomUUID().slice(0, 8);
}
