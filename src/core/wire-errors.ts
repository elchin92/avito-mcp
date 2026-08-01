/**
 * The SHAPE of an error answer, per era.
 *
 * ── What this module is for ─────────────────────────────────────────────────
 *
 * `src/core/wire-compat.ts` pins what a tool DESCRIPTOR looks like. This module
 * pins what a FAILURE looks like — which of `result` / `error` carries it, the
 * text, and whether a `data` object rides along. The M2 SDK swap moved all four
 * without moving a single schema, so `schema_hash` and every self-comparing
 * era test stayed green while a 2025 client's experience of the same server
 * changed. `test/legacy-wire-regression.test.ts` is what caught it, by diffing
 * against a real 1.3.3 process rather than against this branch.
 *
 * ── The three v1→v2 changes restored here, with the SDK code that caused each ─
 *
 * 1. `tools/call` on an unknown tool. v1 raised the lookup failure INSIDE the
 *    handler's try, so its own catch turned it into a tool result:
 *
 *        try {
 *            const tool = this._registeredTools[request.params.name];
 *            if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ... not found`);
 *            ...
 *        } catch (error) { return this.createToolError(...) }   // v1 mcp.js
 *
 *    v2 moved both lookup throws ABOVE the try, so they escape as a JSON-RPC
 *    error instead:
 *
 *        const tool = this._registeredTools[request.params.name];
 *        if (!tool) throw new ProtocolError(..., `Tool ... not found`);
 *        if (!tool.enabled) throw new ProtocolError(..., `Tool ... disabled`);
 *        try { ... } catch (error) { return this.createToolError(...) }
 *
 *    This is the most consequential of the three: an SDK client turns a
 *    JSON-RPC error into a THROWN `McpError`, so an agent that used to read
 *    "that tool does not exist" as tool output now takes an exception —
 *    typically abandoning the turn instead of picking another tool.
 *
 * 2. Every `McpError` message on the wire lost its prefix. v1's constructor was
 *    `super(\`MCP error ${code}: ${message}\`)`, and the protocol serialises
 *    `message: error.message`, so the prefix was part of the wire string. v2's
 *    `ProtocolError` is `super(message)`. Nothing else changed: same code, same
 *    condition, same `data`.
 *
 * 3. `resources/read` on an unregistered URI. v1 threw
 *    `McpError(InvalidParams, \`Resource ${uri} not found\`)` where `uri` is the
 *    PARSED `URL`; v2 throws `new ResourceNotFoundError(request.params.uri)`,
 *    which rewords the message AND attaches `data: { uri }` AND echoes the
 *    caller's RAW string.
 *
 * ── The one thing here that is not a restoration ────────────────────────────
 *
 * The raw echo in (3) is fixed on BOTH eras, because it is not a compatibility
 * question. `avito://swaggers/../../etc/passwd` came back to the caller
 * verbatim, traversal segments and all; 1.3.3 answered with the NORMALISED
 * `avito://swaggers/etc/passwd` because it interpolated the parsed `URL`. What
 * a server reflects into an error is attacker-chosen text that lands in client
 * logs and UIs, so the normalised form — plus a length bound and a control
 * character sweep for the branch where the URI does not parse at all — is what
 * goes out on both wires. See {@link displayableResourceUri}.
 *
 * ── Why the seam is the stored handler map ──────────────────────────────────
 *
 * All three conditions are raised INSIDE the SDK's own request handlers, which
 * `McpServer` installs itself — there is no call site of ours to change and no
 * option to pass. The reachable seam is the handler the protocol will dispatch
 * to, so this module re-wraps exactly that, once, after registration is
 * complete.
 *
 * It reads `Protocol._requestHandlers` to do it. That is a private field, so
 * {@link requestHandlerMap} fails LOUDLY at construction if a future SDK
 * renames or reshapes it — a silent no-op here would mean the legacy wire moves
 * again with every suite still green, which is the exact failure this module
 * was written to end. Re-registering through the public `setRequestHandler`
 * instead was considered and rejected: it re-runs the codec's request
 * validation for every wrapped method on every call, i.e. it pays a hot-path
 * cost on `tools/call` for a repair that only matters on the error path.
 */
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { McpServer, ProtocolEra } from '@modelcontextprotocol/server';

/** The minimum of a JSON-RPC request this module needs to look at. */
interface WireRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** A handler as the protocol stores it: already codec- and role-wrapped. */
type StoredHandler = (request: WireRequest, ctx: unknown) => Promise<unknown>;

/**
 * The registry the protocol dispatches from.
 *
 * Guarded rather than trusted: an SDK upgrade that renames the field would
 * otherwise turn every wrapper below into a no-op, and the only symptom would
 * be a wire that quietly regressed. Failing here fails server construction, and
 * server construction is covered by every suite in the repository.
 */
function requestHandlerMap(server: McpServer): Map<string, StoredHandler> {
  const candidate = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(candidate instanceof Map)) {
    throw new Error(
      'wire-errors: Protocol._requestHandlers is not a Map any more. The error-shape ' +
        'layer in src/core/wire-errors.ts has lost its seam — the legacy wire would ' +
        'silently regress. Re-point it at the SDK’s new handler registry.',
    );
  }
  return candidate as Map<string, StoredHandler>;
}

/** Replaces one stored handler with `wrap(previous)`. Absent method ⇒ loud failure. */
function rewrap(
  handlers: Map<string, StoredHandler>,
  method: string,
  wrap: (stored: StoredHandler) => StoredHandler,
): void {
  const stored = handlers.get(method);
  if (stored === undefined) {
    throw new Error(
      `wire-errors: no request handler registered for ${method}; the error-shape layer ` +
        'must be installed after the server has registered its primitives.',
    );
  }
  handlers.set(method, wrap(stored));
}

// ─────────────────────────────── error helpers ───────────────────────────────

/** The message text SDK v1's `McpError` constructor produced for the wire. */
function messageAs133(code: number, message: string): string {
  return `MCP error ${code}: ${message}`;
}

/** A `ProtocolError` carrying v1's prefixed message, keeping code and data. */
function restampAs133(error: ProtocolError): ProtocolError {
  return new ProtocolError(error.code, messageAs133(error.code, error.message), error.data);
}

/** The tool-error result v1's `createToolError()` built. */
function toolErrorResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * How much reflected URI text may leave the process, and with what stripped.
 *
 * `new URL(...).toString()` already percent-encodes control characters, so the
 * sweep only bites on the branch where the URI did not parse at all — which is
 * precisely the branch where the string is least trustworthy. The cap is a
 * bound on log and UI damage from a deliberately enormous URI; it is far above
 * any URI this server actually serves.
 */
const MAX_ECHOED_URI_CHARS = 200;
// eslint-disable-next-line no-control-regex -- matching them is exactly the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The form of a caller-supplied resource URI that is safe to reflect.
 *
 * Normalised through `URL` — which is both what 1.3.3 echoed and what collapses
 * `../..` before it can be read as a path — then bounded and swept.
 */
export function displayableResourceUri(raw: string): string {
  let text = raw;
  try {
    text = new URL(raw).toString();
  } catch {
    // Not a URI at all: nothing to normalise, so only the sweep applies.
  }
  text = text.replace(CONTROL_CHARS, '');
  return text.length > MAX_ECHOED_URI_CHARS ? `${text.slice(0, MAX_ECHOED_URI_CHARS)}…` : text;
}

// ───────────────────────────────── resources ─────────────────────────────────

/**
 * Whatever `new URL(raw)` throws — the error 1.3.3 let escape its `resources/read`
 * handler, and therefore the `-32603 Invalid URL` a 2025 client already has.
 */
function urlParseFailure(raw: string): unknown {
  try {
    void new URL(raw);
  } catch (error) {
    return error;
  }
  /* c8 ignore next 2 -- only reachable if the SDK called a parseable URI invalid */
  return new Error('Invalid URL');
}

/** True for the SDK's "this URI does not parse" refusal, which also echoes raw. */
function isUnparseableUriError(error: unknown): error is ProtocolError {
  if (!ProtocolError.isInstance(error)) return false;
  const data = error.data as { reason?: unknown } | undefined;
  return data?.reason === 'invalid_uri';
}

/**
 * `resources/read`: 1.3.3's wording on the legacy era, and a reflected URI that
 * is normalised (not raw) on both.
 */
function resourceReadShape(stored: StoredHandler, era: ProtocolEra): StoredHandler {
  return async (request, ctx) => {
    try {
      return await stored(request, ctx);
    } catch (error) {
      const requested = request.params?.uri;
      if (typeof requested !== 'string') throw error;

      if (ResourceNotFoundError.isInstance(error)) {
        const shown = displayableResourceUri(requested);
        // The legacy answer is v1's verbatim: its own wording, and no `data`.
        // The `MCP error -32602: ` prefix is added by the outer legacy wrapper,
        // so this branch states the condition once and only once.
        if (era !== 'modern') {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${shown} not found`);
        }
        // 2026-07-28 keeps `ResourceNotFoundError` — `-32602` plus a
        // machine-readable `data.uri`, which is the pair the revision assigns
        // to "resource not found" (it forbids the old `-32002`). Only the
        // echoed value changes.
        throw new ResourceNotFoundError(shown);
      }

      if (isUnparseableUriError(error)) {
        // 1.3.3 had no branch here at all: `new URL(request.params.uri)` threw,
        // the TypeError escaped the handler, and the protocol answered `-32603`
        // with the engine's own `Invalid URL` — which, usefully, echoes nothing
        // the caller sent. Re-thrown from a real parse attempt rather than
        // hard-coded, so the two stay identical if the engine ever rewords it.
        if (era !== 'modern') throw urlParseFailure(requested);
        // 2026: the SDK's `-32602` and its machine-readable reason, with the
        // echoed value swept — this is the branch where nothing normalised it.
        const shown = displayableResourceUri(requested);
        throw new ProtocolError(error.code, `Resource URI ${shown} is invalid`, {
          uri: shown,
          reason: 'invalid_uri',
        });
      }

      throw error;
    }
  };
}

// ───────────────────────────────── tools/call ────────────────────────────────

/**
 * The two lookup refusals v2 moved out of its own try/catch.
 *
 * Matched by their exact text — built from the name in THIS request — rather
 * than by "any ProtocolError from tools/call", because the handler this wrapper
 * sits outside of raises other `-32602`s that 1.3.3 never answered as tool
 * results (`Invalid tools/call request: …` and `Invalid tools/call result: …`,
 * from the codec validation `Server._wrapHandler` adds around every call).
 * Converting those too would invent a shape rather than restore one.
 */
function isRelocatedLookupRefusal(error: unknown, toolName: string): error is ProtocolError {
  if (!ProtocolError.isInstance(error)) return false;
  if (error.code !== ProtocolErrorCode.InvalidParams) return false;
  return error.message === `Tool ${toolName} not found` || error.message === `Tool ${toolName} disabled`;
}

/**
 * The messages the SDK's `tools/call` handler builds for a schema failure and
 * then swallows into a tool result, verbatim from `mcp` (`validateToolInput`,
 * `validateToolOutput`). In 1.3.3 these reached the client through
 * `McpError.message` and therefore carried the `MCP error -32602: ` prefix; in
 * v2 the same `ProtocolError` is stringified by `error.message`, which does
 * not.
 *
 * The rendering of the issues INSIDE the first message is restored elsewhere —
 * `pinSchemaValidationMessage` in `src/core/wire-compat.ts` — because it
 * happens before the SDK builds this string at all.
 */
function schemaFailurePrefixes(toolName: string): readonly string[] {
  return [
    `Input validation error: Invalid arguments for tool ${toolName}: `,
    `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`,
    `Output validation error: Invalid structured content for tool ${toolName}: `,
  ];
}

/** The text of a single-text-block tool error, or `undefined` for anything else. */
function soleErrorText(result: unknown): string | undefined {
  const candidate = result as
    | { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }
    | undefined;
  if (candidate?.isError !== true) return undefined;
  const content = candidate.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0];
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

/** `tools/call` answered the way 1.3.3 answered it. */
function legacyToolCallShape(stored: StoredHandler): StoredHandler {
  return async (request, ctx) => {
    const toolName = request.params?.name;
    if (typeof toolName !== 'string') return stored(request, ctx);

    let result: unknown;
    try {
      result = await stored(request, ctx);
    } catch (error) {
      if (!isRelocatedLookupRefusal(error, toolName)) throw error;
      return toolErrorResult(messageAs133(error.code, error.message));
    }

    const text = soleErrorText(result);
    if (text === undefined) return result;
    if (!schemaFailurePrefixes(toolName).some((prefix) => text.startsWith(prefix))) return result;
    return toolErrorResult(messageAs133(ProtocolErrorCode.InvalidParams, text));
  };
}

// ─────────────────────────────── the installer ───────────────────────────────

/** Adds v1's `MCP error <code>: ` prefix to any `ProtocolError` leaving a handler. */
function legacyErrorMessages(stored: StoredHandler): StoredHandler {
  return async (request, ctx) => {
    try {
      return await stored(request, ctx);
    } catch (error) {
      if (!ProtocolError.isInstance(error)) throw error;
      throw restampAs133(error);
    }
  };
}

/**
 * Installs this era's error shapes. Call ONCE, after every primitive has been
 * registered — the wrappers replace handlers that are already in place, so a
 * primitive registered afterwards would keep the SDK's shapes.
 *
 * Both construction sites must call it: `buildMcpServer()` in
 * `src/build-server.ts` and, for anything that ever grows an error path,
 * `scripts/generate-manifest.ts`. The manifest builder deliberately does not —
 * it drives `tools/list` on a throwaway in-memory pair and never reaches an
 * error answer — and `test/manifest-snapshot.test.ts` pins the output either
 * way.
 */
export function applyWireErrorShapes(server: McpServer, era: ProtocolEra): void {
  const handlers = requestHandlerMap(server);

  // Both eras: never reflect a caller's raw URI.
  rewrap(handlers, 'resources/read', (stored) => resourceReadShape(stored, era));

  if (era === 'modern') return;

  // Legacy only, innermost first: the lookup refusal must become a RESULT
  // before the message wrapper could turn it into a prefixed error.
  rewrap(handlers, 'tools/call', legacyToolCallShape);
  for (const method of [...handlers.keys()]) {
    rewrap(handlers, method, legacyErrorMessages);
  }
}
