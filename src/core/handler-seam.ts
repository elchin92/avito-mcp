/**
 * The one seam through which this codebase re-shapes an SDK request handler.
 *
 * `McpServer` installs the handlers for `tools/*`, `prompts/*` and
 * `resources/*` ITSELF, in its own constructor and in `registerTool()` /
 * `registerPrompt()` / `registerResource()`. There is no call site of ours to
 * change and no option to pass, so any behaviour we need to add to one of those
 * methods — the era-specific error shapes in `src/core/wire-errors.ts`, the
 * list pagination in `src/core/pagination.ts` — has to wrap the handler the
 * protocol will dispatch to.
 *
 * That handler lives in `Protocol._requestHandlers`, which is private. Reading
 * a private field is a liability whichever way it is done; what this module
 * adds is that the liability FAILS LOUDLY. If a future SDK renames or reshapes
 * the registry, {@link requestHandlerMap} throws at server construction — and
 * server construction is exercised by every suite in the repository. The
 * alternative (an optional chain that quietly yields `undefined`) would turn
 * every wrapper in the codebase into a no-op with the whole suite still green,
 * which is precisely the failure mode both callers exist to prevent.
 *
 * Extracted here rather than duplicated per caller: two copies of a
 * private-field probe are two things to remember to re-point, and the second
 * copy is the one that gets forgotten.
 */
import type { McpServer } from '@modelcontextprotocol/server';

/** The minimum of a JSON-RPC request a wrapper needs to look at. */
export interface WireRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** A handler as the protocol stores it: already codec- and role-wrapped. */
export type StoredHandler = (request: WireRequest, ctx: unknown) => Promise<unknown>;

/**
 * The registry the protocol dispatches from.
 *
 * `subsystem` names the caller in the failure text, so a red build says which
 * layer lost its seam rather than just that one did.
 */
export function requestHandlerMap(server: McpServer, subsystem: string): Map<string, StoredHandler> {
  const candidate = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(candidate instanceof Map)) {
    throw new Error(
      `${subsystem}: Protocol._requestHandlers is not a Map any more. The handler seam in ` +
        'src/core/handler-seam.ts has been lost — every layer built on it would silently ' +
        'become a no-op. Re-point it at the SDK’s new handler registry.',
    );
  }
  return candidate as Map<string, StoredHandler>;
}

/** Replaces one stored handler with `wrap(previous)`. Absent method ⇒ loud failure. */
export function rewrap(
  handlers: Map<string, StoredHandler>,
  method: string,
  subsystem: string,
  wrap: (stored: StoredHandler) => StoredHandler,
): void {
  const stored = handlers.get(method);
  if (stored === undefined) {
    throw new Error(
      `${subsystem}: no request handler registered for ${method}; this layer must be ` +
        'installed after the server has registered its primitives.',
    );
  }
  handlers.set(method, wrap(stored));
}
