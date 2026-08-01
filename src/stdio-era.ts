/**
 * M3.10 — the observation and validation seam for a dual/modern stdio
 * connection.
 *
 * ── Why a transport wrapper and not a patch to `serveStdio` ─────────────────
 *
 * `serveStdio` owns the era decision for a stdio connection, and its state
 * machine is deliberately one-shot:
 *
 *   const opening = classifyOpeningMessage(message);   // first classifiable frame
 *   …
 *   case "legacy": { … state = { phase: "pinned", era: "legacy", instance }; }
 *   …
 *   if (state.phase === "pinned") { state.instance.channel.deliver(message); return; }
 *
 * (`@modelcontextprotocol/server/dist/stdio.mjs`, `processMessage`.) Once
 * `phase === 'pinned'` every later frame is handed to the pinned instance with
 * NO classification argument, so nothing downstream re-derives the era or the
 * revision. Two consequences, both of which this module addresses and neither
 * of which can be fixed inside the SDK from here:
 *
 *  1. **The pin is permanent and silent.** A 2026 client whose first frame
 *     carries no `_meta` envelope classifies as `{kind:'legacy', reason:
 *     'no-claim'}` and is a 2025 connection for the rest of its life. That
 *     behaviour IS the SDK's — the entry exposes no hook, no option and no
 *     callback that could make it re-classify — so we do not pretend to change
 *     it. What we add is the DIAGNOSTIC the rollout needs: a stderr line naming
 *     the era, the method that pinned it, and the fact that it is permanent.
 *     The limitation itself is recorded in
 *     `docs/adr/0001-protocol-era-limitations.md` and in both READMEs.
 *
 *  2. **`protocolVersion` stops being checked.** On HTTP every request is
 *     classified, so `-32022` is produced per request. On a pinned stdio
 *     connection the only remaining envelope check is the 2026 codec's
 *     `checkInboundEnvelope`, which validates the envelope against
 *     `RequestMetaEnvelopeSchema` — and there `protocolVersion` is a bare
 *     `z.string()`. A frame claiming `2099-01-01` was therefore served
 *     normally. That one we CAN fix, because the fix is a check in front of the
 *     entry rather than a change to it.
 *
 * `serveStdio` accepts `options.transport` ("Bring your own transport … The
 * entry owns the transport: it starts it, receives every inbound message, and
 * closes it when the connection ends"), which is the supported seam for
 * exactly this. Everything below sits between the real `StdioServerTransport`
 * and the entry: it sees every inbound frame first and every outbound frame
 * last, and it can answer a frame itself by writing to the wire and not
 * forwarding.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It never re-implements the era decision. The classification comes from the
 * SDK's own exported `classifyInboundRequest` — the same function
 * `createMcpHandler` and `isLegacyRequest` use — driven with `httpMethod:
 * 'POST'` and no headers, which is precisely the body-primary shape the stdio
 * entry's private `classifyOpeningMessage` applies ("There is no header layer
 * on stdio, so the body is the only signal"). A hand-rolled predicate here
 * could disagree with the entry about what "legacy" means; this one cannot.
 */
import {
  PROTOCOL_VERSION_META_KEY,
  UnsupportedProtocolVersionError,
  classifyInboundRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
} from '@modelcontextprotocol/server';
import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { ProtocolEraMode } from './config.js';
import { narrowListenRequest } from './core/subscriptions.js';

/** The era this wrapper believes the connection has settled on. */
type PinState = 'opening' | 'legacy' | 'modern';

export interface StdioEraTransportOptions {
  /** The deployment posture (`dual` is the only one where a legacy pin is a surprise). */
  era: ProtocolEraMode;
  /** Modern revisions this process serves; the `data.supported` of our `-32022`. */
  supportedModernVersions: readonly string[];
  /** URIs `subscriptions/listen` may honour — everything else is dropped from the filter. */
  subscribableUris: readonly string[];
  /** Diagnostic sink. Defaults to stderr, which on stdio is the ONLY safe channel. */
  warn?: (line: string) => void;
  /** The real wire. Injectable so tests can drive it without a child process. */
  inner?: Transport;
}

function paramsOf(message: JSONRPCMessage): Record<string, unknown> | undefined {
  const params = (message as { params?: unknown }).params;
  return params !== null && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : undefined;
}

/** The `io.modelcontextprotocol/protocolVersion` a frame claims, if it claims one. */
function claimedProtocolVersion(message: JSONRPCMessage): string | undefined {
  const meta = paramsOf(message)?._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  const value = (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
  return typeof value === 'string' ? value : undefined;
}

function methodOf(message: JSONRPCMessage): string | undefined {
  const method = (message as { method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

/**
 * Wraps the stdio wire with the era diagnostic (M3.10), the per-message
 * protocol-version check the pinned connection otherwise loses, and the
 * `subscriptions/listen` filter narrowing.
 */
export function createStdioEraTransport(options: StdioEraTransportOptions): Transport {
  // Typed as the interface, not as the concrete class: `StdioServerTransport`
  // declares no `sessionId` / `setProtocolVersion` of its own (both are optional
  // on `Transport`), and the union of the two would erase them.
  const inner: Transport = options.inner ?? new StdioServerTransport();
  const warn = options.warn ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const supported = [...options.supportedModernVersions];
  const subscribable = new Set(options.subscribableUris);

  let pin: PinState = 'opening';
  let warned = false;

  const wrapper: Transport = {
    start: async () => {
      inner.onclose = () => wrapper.onclose?.();
      inner.onerror = (error) => wrapper.onerror?.(error);
      inner.onmessage = (message, extra) => {
        void handleInbound(message, extra);
      };
      await inner.start();
    },
    send: (message: JSONRPCMessage, sendOptions?: TransportSendOptions) =>
      inner.send(message, sendOptions),
    close: () => inner.close(),
    get sessionId(): string | undefined {
      return inner.sessionId;
    },
    setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version),
  };

  function refuseUnsupportedVersion(message: JSONRPCMessage, requested: string): void {
    const error = new UnsupportedProtocolVersionError({ supported, requested });
    const id = (message as { id?: string | number | null }).id ?? null;
    void inner
      .send({
        jsonrpc: '2.0',
        id,
        error: { code: error.code, message: error.message, data: error.data },
      } as JSONRPCMessage)
      .catch((err: unknown) => {
        wrapper.onerror?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  async function handleInbound(
    message: JSONRPCMessage,
    extra?: Parameters<NonNullable<Transport['onmessage']>>[1],
  ): Promise<void> {
    await Promise.resolve();
    const isRequest = isJSONRPCRequest(message);
    const isNotification = isJSONRPCNotification(message);
    if (!isRequest && !isNotification) {
      wrapper.onmessage?.(message, extra);
      return;
    }

    const route = classifyInboundRequest({ httpMethod: 'POST', body: message as unknown });
    const method = methodOf(message) ?? '(unknown)';

    // ── the per-message version check the pinned connection loses ────────────
    //
    // Evaluated against the pin as it stood BEFORE this message, and only when
    // that pin is `modern`. Both halves matter:
    //   • while the connection is still `opening`, `serveStdio`'s own
    //     `classifyOpeningMessage` already answers an unsupported revision with
    //     the identical `-32022`, and pre-empting it here would make our copy
    //     the one that has to stay in step with the entry;
    //   • on a legacy-pinned connection `_meta` carries no protocol version at
    //     all, so there is nothing to check and a stray key must not be read as
    //     an era claim.
    if (pin === 'modern') {
      const requested = claimedProtocolVersion(message);
      if (requested !== undefined && !supported.includes(requested)) {
        if (isRequest) {
          refuseUnsupportedVersion(message, requested);
        } else {
          wrapper.onerror?.(
            new Error(
              `Dropped a notification claiming unsupported protocol revision ${requested}`,
            ),
          );
        }
        return;
      }
    }

    // ── era pin bookkeeping ──────────────────────────────────────────────────
    //
    // Mirrors `serveStdio`'s own phases rather than guessing: a modern
    // `server/discover` opens the optimistic PROBE (which a later legacy frame
    // still discards, so it is not a pin), any other modern REQUEST pins
    // modern, and any legacy-classified frame pins legacy unless the connection
    // is already pinned modern.
    if (route.kind === 'modern' && isRequest && method !== 'server/discover') {
      pin = 'modern';
    } else if (route.kind === 'legacy' && pin !== 'modern') {
      if (pin !== 'legacy' && options.era === 'dual' && !warned) {
        warned = true;
        warn(
          `avito-mcp: protocol era pinned to legacy for this stdio connection ` +
            `(the first classifiable message was ${method}, reason=${route.reason}). ` +
            `AVITO_MCP_PROTOCOL_ERA=dual serves both eras, but a stdio connection's era ` +
            `is decided once, from its first classifiable message, and never revisited — ` +
            `every later message on THIS connection is served as revision 2025-11-25, ` +
            `even one carrying a 2026-07-28 envelope. A 2026 client must send its per-request ` +
            `_meta envelope (io.modelcontextprotocol/protocolVersion) on its FIRST message. ` +
            `See docs/adr/0001-protocol-era-limitations.md.`,
        );
      }
      pin = 'legacy';
    }

    // ── subscriptions/listen: honour only what we can actually publish ───────
    const forwarded =
      pin === 'modern' || route.kind === 'modern'
        ? (narrowListenRequest(message as unknown, subscribable) as JSONRPCMessage)
        : message;

    wrapper.onmessage?.(forwarded, extra);
  }

  return wrapper;
}
