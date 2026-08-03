import type {
  McpServer,
  CallToolResult,
  ProtocolEra,
  ToolAnnotations,
  ServerContext,
} from '@modelcontextprotocol/server';
import { z, type ZodRawShape } from 'zod';

import type { Config } from '../config.js';
import { logger, type RequestLogSink } from '../logger.js';
import type {
  AvitoClient,
  BodyContentType,
  HttpMethod,
  RequestResponse,
  SafeStaticHeaders,
} from './client.js';
import { AvitoApiError, errorToMcpContent } from './errors.js';
import {
  hashArgs,
  fingerprintIdempotencyKey,
  type IdempotencyStore,
  IdempotencyConflictError,
  IdempotencyLimitError,
  IdempotencyReconcileRequiredError,
  UpstreamOutcomeUnknownError,
} from './idempotency.js';
import { callerPrincipal, type CallerExtra, type PendingActionStore } from './pending-actions.js';
import { evaluatePolicy, requiresConfirmation } from './policy.js';
import type { Primitive, QueryValue } from './url.js';
import type { WebhookStore } from './webhook-store.js';

type Assert<T extends true> = T;
type ServerContextHttp = NonNullable<ServerContext['http']>;

/**
 * Compile-time contract between the SDK's handler context and {@link CallerExtra},
 * the subset `callerPrincipal()` reads to decide WHO is calling.
 *
 * This exists because the v1→v2 move of `authInfo`/`requestInfo` from the top of
 * the context down into `ctx.http` is otherwise invisible: `CallerExtra` is a weak
 * type (every field optional), so the old v1 shape stayed assignable to the new
 * context and every principal silently degraded to `session:<id>` — no compiler
 * error, no test failure. These assertions fail the build if either side moves
 * again; `test/oauth-bearer-http.test.ts` covers the runtime half over a live
 * HTTP transport with a real OAuth token.
 */
export type CallerIdentityContract = [
  // The verified token still hangs off ctx.http.authInfo, not the v1 top-level ctx.authInfo.
  Assert<NonNullable<ServerContextHttp['authInfo']>['clientId'] extends string ? true : false>,
  // The raw request still hangs off ctx.http.req, with web-standard Headers access.
  Assert<
    NonNullable<ServerContextHttp['req']>['headers'] extends { get(name: string): string | null }
      ? true
      : false
  >,
  // What callerPrincipal() reads is exactly what the SDK hands the handler.
  Assert<ServerContextHttp extends NonNullable<CallerExtra['http']> ? true : false>,
  Assert<ServerContext extends CallerExtra ? true : false>,
];

/** Names of internal fields automatically added to destructive tools. */
const META_PARAMS = ['dryRun', 'idempotencyKey'] as const;

function isDestructive(risk: ToolRisk): boolean {
  return risk === 'write' || risk === 'money' || risk === 'public';
}

/** Clean args for a tool — without the internal meta-parameters. */
function stripMeta(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!(META_PARAMS as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Context passed to the domain register functions.
 * Bundles everything a tool handler needs: the HTTP client, the config, and the
 * pending-store for the confirmation flow. Since v0.6.0 the McpServer is also
 * forwarded — it is required by resources/prompts/sendLoggingMessage registered in
 * src/resources.ts and src/prompts.ts.
 * The `server` field is optional so existing tests don't have to be updated.
 */
export interface ToolContext {
  client: AvitoClient;
  config: Config;
  pendingStore: PendingActionStore;
  server?: McpServer;
  /**
   * v0.7.0: opt-in idempotency ledger. If not provided, the idempotencyKey
   * parameter is still allowed in the schema (the agent may pass it), but no
   * deduplication is performed. This simplifies migration: existing tests can
   * omit idempotencyStore.
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * v0.9.0: optional ring buffer of received Avito webhook events. Present only
   * when the webhook receiver is enabled. The webhook domain tools and the
   * avito://webhook/events resource read from it; undefined → those tools report
   * the receiver as disabled rather than failing.
   */
  webhookStore?: WebhookStore;
  /**
   * M3 — the protocol era the owning server instance serves. Absent means
   * `legacy`: every context built before M3, and every test fixture, is a 2025
   * context, and defaulting the other way would move their behaviour.
   *
   * Read it through {@link toolContextEra}. It changes two things and only two:
   * which subscription surface `registerResources` installs, and where the MCP
   * log mirror delivers (connection-level vs request-scoped).
   */
  era?: ProtocolEra;
}

/** The era of a {@link ToolContext}, with the "not stated means legacy" default applied. */
export function toolContextEra(ctx: Pick<ToolContext, 'era'>): ProtocolEra {
  return ctx.era ?? 'legacy';
}

/**
 * The slice of the SDK's per-request context this module uses beyond
 * {@link CallerExtra}.
 *
 * Declared as an intersection with everything optional rather than by importing
 * `ServerContext` wholesale, for the same reason `CallerExtra` exists: the 148
 * handlers are also driven directly by tests with hand-built contexts, and a
 * required `mcpReq` would force every one of them to fabricate a full SDK
 * context. `CallerIdentityContract` is what keeps the shape honest against the
 * SDK — `ServerContext extends CallerExtra` is asserted at compile time there,
 * and `ServerContext['mcpReq']` really does carry both members below.
 */
export type ToolCallExtra = CallerExtra & {
  mcpReq?: {
    /** Aborted when the peer closes this request's response stream (item 11). */
    signal?: AbortSignal;
    /** Request-scoped `notifications/message` (item 10). */
    log?: RequestLogSink['log'];
  };
};

export type ProfileIdKey = 'user_id' | 'userId';

/**
 * Semantics of a tool's impact on the live account. Used for:
 *   - AVITO_MCP_MODE — blocks categories at registration time
 *   - AVITO_MCP_CONFIRMATION_MODE — requires confirmation at runtime
 *   - MCP ToolAnnotations (readOnlyHint / destructiveHint / idempotentHint)
 *
 * Categories:
 *   - `sensitive` — returns credentials / tokens / secrets. Hidden by default
 *                   even in full_access. Enabled via AVITO_MCP_EXPOSE_AUTH_TOOLS=1.
 *                   Examples: auth_get_access_token, auth_refresh_*.
 *   - `read`      — read-only, no side effects and no secrets in the response.
 *                   GET and POST-as-query (analytics, balance, info, list).
 *   - `write`     — modifies user data, with no monetary cost and not visible to clients.
 *                   Drafts, settings, internal stock, marking as read.
 *   - `money`     — spends money from the balance (VAS, promotion, CPA bids).
 *   - `public`    — visible to clients or third parties (messages, review replies,
 *                   price/status/tracking changes).
 *
 * Default if omitted: `write` (fail-closed for safe-mode).
 */
export type ToolRisk = 'sensitive' | 'read' | 'write' | 'money' | 'public';

/**
 * Declarative description of a single MCP tool wrapping an Avito API HTTP call.
 *
 * @template I — zod-shape of the input parameters (an object `{ key: z.ZodType }`)
 */
export interface ToolSpec<I extends ZodRawShape = ZodRawShape> {
  /** Full tool name (with the domain prefix). Must be snake_case. */
  name: string;
  /**
   * Optional human-readable name (MCP 2025-11-25 — the `title` field on Tool).
   * Display priority on the client: title → annotations.title → name. If not set,
   * the client shows name (snake_case). For Russian-speaking users this greatly
   * improves the UX in Inspector / Claude Desktop.
   */
  title?: string;
  /** Description for the LLM. Written in Russian, concise and explicit (like a swagger summary). */
  description: string;
  method: HttpMethod;
  /** Path template with {placeholders}, for example "/core/v1/accounts/{user_id}/balance/". */
  path: string;
  /** Zod-shape of the input parameters. {} if there are no parameters. */
  input?: I;
  /** Names of keys from `input` that go into the path. The rest go into query or body. */
  pathParams?: readonly string[];
  /** Names of keys from `input` that go into the query. */
  queryParams?: readonly string[];
  /**
   * Description of the request body.
   *   - `contentType` — determines the serialization.
   *   - `fields` — if specified, only these keys from input are included in the body.
   *     If not specified, all input keys except path/query.
   *   - `defaults` — constant fields always added to the body (can be overridden via input).
   *     May be an object or a function of the context (for credentials from .env).
   *   - `transform` — final transformation of the body before serialization. Applied
   *     AFTER merging defaults+input. Used for nested bodies (for example `{message:{text}}`
   *     from a flat `{text}`).
   *   - If `body` is not set, no body is sent.
   */
  body?: {
    contentType: BodyContentType;
    fields?: readonly string[];
    defaults?: Record<string, unknown> | ((ctx: ToolContext) => Record<string, unknown>);
    /**
     * Final transformation. May return an object (serialized as a JSON object by default)
     * or an array — for endpoints where Avito expects a top-level JSON array as the body.
     */
    transform?: (body: Record<string, unknown>) => Record<string, unknown> | unknown[];
  };
  /** false → request without Authorization (for /token and autoload-public). Default: true. */
  auth?: boolean;
  /**
   * If set, a missing path parameter with this name is filled from config.profileId.
   * Covers both {user_id} and {userId} forms. Sharply reduces agent hallucinations.
   */
  injectProfileId?: ProfileIdKey;
  /** Name for grouping in the rate-limiter (defaults to the first path segment). */
  domain?: string;
  /**
   * Impact semantics. See {@link ToolRisk}. Default is `'write'` (fail-closed for safe-mode).
   * All GET tools and POST-as-query (analytics, statistics) must be explicitly `'read'`.
   */
  risk?: ToolRisk;
  /**
   * Explicit override of the `destructiveHint` MCP annotation. By default destructiveHint
   * is derived from risk (money/public → true, otherwise → false). But risk describes
   * the security policy, while destructiveHint describes the irreversibility semantics for the client.
   * They diverge for cancellations/deletions (cancel/delete/remove/prohibit/blacklist):
   * these are `write` by policy (no money spent, not public) but irreversible in nature.
   * For such tools set `destructiveHint: true` so the annotation is honest.
   */
  destructiveHint?: boolean;
  /**
   * v0.5.0: additional safety dimensions, orthogonal to risk.
   * Surfaced in `_meta` and in `dist/manifest.json` for the client UI and for auditing.
   * Do not affect policy/confirmation decisions — this is analytics, not enforcement.
   */
  accessesLocalFiles?: boolean;
  environment?: 'prod' | 'sandbox' | 'local';
  /** Code-owned, runtime-allowlisted headers. They are never sourced from tool args. */
  staticHeaders?: SafeStaticHeaders;
  /** Code-owned opt-in for documented Swagger GET operations with a JSON body. */
  allowGetBody?: boolean;
  /** Code-owned opt-in for status-code retries on a non-GET operation. */
  retry?: boolean;
  /** Execute a non-standard operation while retaining the common safety pipeline. */
  customExecute?: (
    cleanArgs: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<RequestResponse>;
  /** Build a dry-run preview for a custom executor without performing side effects. */
  buildDryRunPreview?: (cleanArgs: Record<string, unknown>, ctx: ToolContext) => unknown;
  /** Last-mile secret redaction for generated previews. */
  redactDryRunPreview?: (preview: unknown, ctx: ToolContext) => unknown;
}

/** MCP ToolAnnotations are derived deterministically from ToolRisk. */
function riskToAnnotations(risk: ToolRisk): ToolAnnotations {
  switch (risk) {
    case 'sensitive':
      // Read-only on the Avito side, but it returns secrets — that is also an
      // important signal for the client. The secrets protection itself lives in policy.ts (hidden by default).
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case 'read':
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case 'write':
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case 'money':
    case 'public':
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
  }
}

/**
 * Registers a single tool in the McpServer. Turns a declarative ToolSpec into a working
 * server.registerTool(name, config, handler).
 *
 * Handler:
 *   1. Splits args into pathParams / queryParams / body fields
 *   2. If needed, fills config.profileId into a missing path parameter
 *   3. Calls client.request(...)
 *   4. Serializes data into text content (the agent parses the JSON itself)
 *   5. Avito API errors → isError content (the agent sees the error code and text and can react)
 */
export function defineTool<I extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<I>,
): void {
  const inputSchema = spec.input ?? ({} as I);
  const risk: ToolRisk = spec.risk ?? 'write';
  const annotations = riskToAnnotations(risk);
  // Honest destructiveHint override: cancellations/deletions are policy-`write`
  // but irreversible, so the derived hint (false) would understate them. See ToolSpec.
  if (spec.destructiveHint !== undefined) {
    annotations.destructiveHint = spec.destructiveHint;
  }

  // Policy gate: hide tools that violate mode / allowlist / denylist BEFORE registration.
  // Hiding (rather than blocking at call time) means the agent never sees the tool in
  // tools/list — removes the temptation entirely.
  const decision = evaluatePolicy(spec.name, risk, ctx.config);
  if (!decision.allowed) {
    logger.info({ tool: spec.name, risk, reason: decision.reason }, 'tool hidden by policy');
    return;
  }

  // The real executor — separated from the wrapper so it can be reused
  // on confirmation via meta_confirm_action.
  // IMPORTANT: it takes clean args (without dryRun/idempotencyKey) — the meta-parameters
  // are handled in the handler above.
  const execute = async (
    cleanArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    // Latched by the client at the instant the request is handed to the network.
    // NOT "we are about to call": the gap between those two contains the
    // rate-limiter queue and the token refresh, and a call cancelled in that gap
    // changed nothing upstream.
    let dispatched = false;
    try {
      const response = spec.customExecute
        ? await spec.customExecute(cleanArgs, ctx)
        : await executeHttpRequest(cleanArgs, spec, ctx, signal, () => {
            dispatched = true;
          });
      const result: CallToolResult = {
        content: [
          {
            type: 'text',
            text: formatResponse(response.status, response.data),
          },
        ],
      };
      // v0.6.0: structuredContent — the MCP 2025-11-25 field for clients that can parse JSON.
      // Duplicates text but without requiring regex/parse on the agent side. We don't set
      // outputSchema → the client validates loosely, so we can safely return any shape.
      const structured = toStructuredContent(response.status, response.data);
      if (structured !== undefined) result.structuredContent = structured;
      return result;
    } catch (err) {
      // A cancelled call does not become an ordinary result (M3 item 11).
      //
      // Every other failure is deliberately turned into an `isError` payload so
      // the agent can read and react to it — but that same conversion, applied
      // to a cancellation, would memoise "the client hung up" under the caller's
      // idempotency key and wedge every retry that reuses it for the whole TTL.
      // Nobody is left to read the payload anyway: the stream it would travel on
      // is the one that just closed. So this branch decides what the LEDGER is
      // told, and the three answers below are not interchangeable.
      if (signal?.aborted === true) {
        // …but WHAT the cancellation means for the caller's idempotency key is
        // decided by `dispatched`, never by `aborted` alone.

        // Nothing left this process — the call was still queueing for a
        // rate-limiter slot or a token. Releasing the key is correct and
        // required: refusing it here would strand every cancelled agent.
        if (!dispatched) throw err;

        // The upstream answered THIS request with a status. The outcome is known
        // despite the cancellation, so it is remembered like any other failure
        // and a retry with the same key replays it instead of re-running it.
        if (err instanceof AvitoApiError) return errorToMcpContent(err);

        // The request was on the wire and never produced an answer we can read.
        // The mutation may have applied. The key is held rather than freed —
        // freeing it is what turns one cancelled money call into two charges.
        throw new UpstreamOutcomeUnknownError(err);
      }
      return errorToMcpContent(err);
    }
  };

  // Deliberately signal-FREE. This closure is handed to the pending store and
  // replayed later by `meta_confirm_action`, which is a different JSON-RPC
  // request with a different lifetime; binding it to the signal of the request
  // that merely CREATED the pending action would cancel a human-approved money
  // operation the moment the requesting client disconnected.
  const executePending = async (
    pendingArgs: Record<string, unknown>,
    pendingIdempotencyKey?: string,
    pendingArgsHash?: string,
  ): Promise<CallToolResult> => {
    const result = await execute(pendingArgs);
    if (pendingIdempotencyKey && pendingArgsHash && ctx.idempotencyStore) {
      await ctx.idempotencyStore.rememberPersistent(
        pendingIdempotencyKey,
        spec.name,
        pendingArgsHash,
        result,
      );
    }
    return result;
  };
  if (isDestructive(risk)) ctx.pendingStore.registerExecutor(spec.name, executePending);

  const destructive = isDestructive(risk);

  const handler = async (
    rawArgs: Record<string, unknown>,
    extra: ToolCallExtra,
  ): Promise<CallToolResult> => {
    const signal = extra?.mcpReq?.signal;
    const args = rawArgs ?? {};
    const cleanArgs = destructive ? stripMeta(args) : args;

    // v0.7.0: dry-run on destructive tools. If args.dryRun === true OR
    // the config enables dryRunDefault, we return a request preview without an HTTP call.
    // dry-run bypasses confirmation and idempotency — the preview is safe and has no
    // effect, so neither confirm nor dedup is needed.
    const dryRunRequested = args.dryRun === true;
    const effectiveDryRun =
      destructive &&
      (typeof args.dryRun === 'boolean' ? args.dryRun : ctx.config.dryRunDefault === true);
    if (effectiveDryRun) {
      return dryRunPreview(spec, cleanArgs, ctx, dryRunRequested);
    }

    // v0.7.0: idempotency. If the agent passed idempotencyKey AND the server has a store,
    // we check (toolName, key, hash(args)).
    //   - hit + matching args → return the cache marked idempotent_replay=true
    //   - hit + different args → return a structured error (conflict)
    //   - miss → reserve atomically before executing/creating a pending action
    const idempotencyKey =
      destructive && typeof args.idempotencyKey === 'string' && args.idempotencyKey.length > 0
        ? args.idempotencyKey
        : undefined;
    const argsHash = idempotencyKey ? hashArgs(cleanArgs) : undefined;

    if (idempotencyKey && ctx.idempotencyStore && argsHash) {
      try {
        const cached = ctx.idempotencyStore.lookup(idempotencyKey, spec.name, argsHash);
        if (cached) {
          // A remembered "requires_confirmation" payload goes STALE once its pending
          // action is cancelled or expires (the pending TTL is shorter than the
          // idempotency TTL). Replaying a dead confirmation_id would wedge the key —
          // meta_confirm_action returns "not found" and the action could never run.
          // Detect that, evict the stale entry, and fall through to create a fresh pending.
          const sc = cached.result.structuredContent as Record<string, unknown> | undefined;
          const stalePendingId =
            sc?.requires_confirmation === true && typeof sc.confirmation_id === 'string'
              ? (sc.confirmation_id as string)
              : undefined;
          if (
            stalePendingId !== undefined &&
            !(await ctx.pendingStore.isActivePersistent(stalePendingId))
          ) {
            ctx.idempotencyStore.delete(idempotencyKey, spec.name);
          } else {
            logger.info(
              {
                tool: spec.name,
                idempotencyKeyHash: fingerprintIdempotencyKey(idempotencyKey),
                ageMs: Date.now() - cached.createdAt,
              },
              'idempotent replay served from ledger',
            );
            return annotateReplay(cached.result);
          }
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          return errorToMcpContent(err);
        }
        throw err;
      }
    }

    if (requiresConfirmation(risk, ctx.config)) {
      const createPending = async (): Promise<CallToolResult> => {
        const pending = await ctx.pendingStore.createPersistent({
          toolName: spec.name,
          risk,
          summary: summarisePending(spec, cleanArgs),
          args: cleanArgs,
          initiator: callerPrincipal(extra),
          idempotencyKey,
          argsHash,
          execute: () => executePending(cleanArgs, idempotencyKey, argsHash),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  requires_confirmation: true,
                  confirmation_id: pending.id,
                  tool: spec.name,
                  risk,
                  summary: pending.summary,
                  expires_at: new Date(pending.expiresAt).toISOString(),
                  next_step:
                    'Call meta_confirm_action with this confirmation_id ONLY after explicit human approval. ' +
                    'Confirmation flow is a server-side two-step safety guard against accidental one-shot execution; ' +
                    'it is not a cryptographic human-approval mechanism by itself.',
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            requires_confirmation: true,
            confirmation_id: pending.id,
            tool: spec.name,
            risk,
            expires_at: new Date(pending.expiresAt).toISOString(),
          },
        };
      };

      try {
        if (idempotencyKey && ctx.idempotencyStore && argsHash) {
          const { entry, replay } = await ctx.idempotencyStore.runExclusive(
            idempotencyKey,
            spec.name,
            argsHash,
            createPending,
            {
              retainExpired: (candidate) => {
                const structured = candidate.result.structuredContent as
                  Record<string, unknown> | undefined;
                const confirmationId =
                  structured?.requires_confirmation === true &&
                  typeof structured.confirmation_id === 'string'
                    ? structured.confirmation_id
                    : undefined;
                return confirmationId !== undefined && ctx.pendingStore.isActive(confirmationId);
              },
              retainExpiredPersistent: async (candidate) => {
                const structured = candidate.result.structuredContent as
                  Record<string, unknown> | undefined;
                const confirmationId =
                  structured?.requires_confirmation === true &&
                  typeof structured.confirmation_id === 'string'
                    ? structured.confirmation_id
                    : undefined;
                if (confirmationId !== undefined) {
                  return ctx.pendingStore.isActivePersistent(confirmationId);
                }
                return ctx.pendingStore.hasClaimedPersistent(spec.name, idempotencyKey, argsHash);
              },
              replayAllowed: async (candidate) => {
                const structured = candidate.result.structuredContent as
                  Record<string, unknown> | undefined;
                const confirmationId =
                  structured?.requires_confirmation === true &&
                  typeof structured.confirmation_id === 'string'
                    ? structured.confirmation_id
                    : undefined;
                return (
                  confirmationId === undefined ||
                  (await ctx.pendingStore.isActivePersistent(confirmationId))
                );
              },
            },
          );
          return replay ? annotateReplay(entry.result) : entry.result;
        }
        return await createPending();
      } catch (err) {
        return errorToMcpContent(err);
      }
    }

    if (idempotencyKey && ctx.idempotencyStore && argsHash) {
      try {
        const { entry, replay } = await ctx.idempotencyStore.runExclusive(
          idempotencyKey,
          spec.name,
          argsHash,
          () => execute(cleanArgs, signal),
        );
        return replay ? annotateReplay(entry.result) : entry.result;
      } catch (err) {
        if (
          err instanceof IdempotencyConflictError ||
          err instanceof IdempotencyLimitError ||
          // Covers both reconcile-first refusals: the crash-recovery one and the
          // hold left by a cancellation that raced a dispatched request.
          err instanceof IdempotencyReconcileRequiredError
        ) {
          return errorToMcpContent(err);
        }
        throw err;
      }
    }
    return execute(cleanArgs, signal);
  };

  // The SDK types the callback via an internal BaseToolCallback with its own inferred CallToolResult,
  // incompatible with the public CallToolResult type. We only touch the signature — runtime is OK.
  // Build _meta with optional extra safety dimensions. Default environment='prod'
  // unless overridden (delivery sandbox tools, meta_*).
  const metaRecord: Record<string, unknown> = {
    risk,
    environment: spec.environment ?? 'prod',
  };
  if (spec.accessesLocalFiles) metaRecord.accessesLocalFiles = true;

  // v0.7.0: destructive tools get optional dryRun + idempotencyKey
  // in inputSchema. Read/sensitive ones don't (these parameters are meaningless for them).
  const finalInputSchema: ZodRawShape = destructive
    ? {
        ...(inputSchema as ZodRawShape),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'v0.7.0: if true — returns a preview of the HTTP request without calling the Avito API. ' +
              'Safe for inspecting exactly what would be done. Default: the value of ' +
              'AVITO_MCP_DRY_RUN_DEFAULT (usually false).',
          ),
        idempotencyKey: z
          .string()
          .min(8)
          .optional()
          .describe(
            'v0.7.0: optional key for duplicate protection. A repeat call with the same key ' +
              'within AVITO_MCP_IDEMPOTENCY_TTL_SEC returns the cached result. ' +
              'The same key with different args returns a conflict error. Keys are stored as bounded SHA-256 fingerprints.',
          ),
      }
    : inputSchema;

  if (destructive) {
    metaRecord.supportsDryRun = true;
    metaRecord.supportsIdempotency = true;
  }

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      // SDK v2 takes a Standard Schema object, not a raw ZodRawShape; v1 wrapped
      // the shape internally, so the emitted JSON Schema is unchanged.
      inputSchema: z.object(finalInputSchema),
      annotations,
      _meta: metaRecord,
    },
    handler,
  );
}

/**
 * Returns a preview of the HTTP request without actually calling the Avito API.
 * v0.7.0: used when dryRun=true or AVITO_MCP_DRY_RUN_DEFAULT=true.
 *
 * Contains pathParams, query, body and the resulting method+path — the agent can verify
 * that the parameters were assembled correctly before the live call.
 */
function dryRunPreview(
  spec: ToolSpec,
  cleanArgs: Record<string, unknown>,
  ctx: ToolContext,
  explicit: boolean,
): CallToolResult {
  let preview: unknown;
  try {
    preview = spec.buildDryRunPreview
      ? spec.buildDryRunPreview(cleanArgs, ctx)
      : splitArgs(cleanArgs, spec, ctx);
    if (spec.redactDryRunPreview) {
      preview = spec.redactDryRunPreview(preview, ctx);
    }
  } catch (err) {
    return errorToMcpContent(err);
  }
  const payload = {
    dryRun: true,
    explicit_request: explicit,
    operation: {
      tool: spec.name,
      method: spec.method,
      path: spec.path,
      domain: spec.domain ?? null,
    },
    request_preview: preview,
    notice:
      'No HTTP request was made. To execute for real, call again with dryRun: false ' +
      '(or unset AVITO_MCP_DRY_RUN_DEFAULT).',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Adds a marker to a cached idempotency result indicating that it is a replay.
 * This way the agent sees "this is not a fresh result, I already executed this key".
 */
function annotateReplay(result: CallToolResult): CallToolResult {
  const cloned: CallToolResult = {
    ...result,
    structuredContent: {
      ...(result.structuredContent ?? {}),
      idempotent_replay: true,
    },
  };
  return cloned;
}

/**
 * Turns an Avito HTTP response into structuredContent for a CallToolResult.
 *
 * MCP-2025-11-25 requires structuredContent to be a (top-level) JSON object.
 * - object → as is
 * - array  → {items: array, count, status} (wrapper object)
 * - binary → {mimeType, sizeBytes, base64, status} (without the __binary flag)
 * - null / string → undefined (only text-content makes sense)
 */
function toStructuredContent(status: number, data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data === 'string') return undefined;
  if (typeof data === 'object' && (data as { __binary?: unknown }).__binary === true) {
    const b = data as { mimeType: string; sizeBytes: number; base64: string };
    return {
      status,
      http_status: status,
      mimeType: b.mimeType,
      sizeBytes: b.sizeBytes,
      base64: b.base64,
    };
  }
  if (Array.isArray(data)) {
    return { status, http_status: status, items: data, count: data.length };
  }
  if (typeof data === 'object') {
    // Keep the legacy `status` behavior for compatibility: an API-owned status
    // field still wins. `http_status` is always authoritative and collision-free.
    return { status, ...(data as Record<string, unknown>), http_status: status };
  }
  return undefined;
}

function splitArgs(
  args: Record<string, unknown>,
  spec: ToolSpec,
  ctx: ToolContext,
): {
  pathParams: Record<string, Primitive>;
  query: Record<string, QueryValue>;
  body: Record<string, unknown> | unknown[] | undefined;
} {
  const pathSet = new Set(spec.pathParams ?? []);
  const querySet = new Set(spec.queryParams ?? []);
  const explicitBodyFields = spec.body?.fields ? new Set(spec.body.fields) : undefined;

  const pathParams: Record<string, Primitive> = {};
  const query: Record<string, QueryValue> = {};
  const body: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (pathSet.has(key)) {
      pathParams[key] = value as Primitive;
    } else if (querySet.has(key)) {
      query[key] = value as QueryValue;
    } else if (spec.body) {
      if (!explicitBodyFields || explicitBodyFields.has(key)) {
        body[key] = value;
      }
    }
  }

  // Auto-inject Profile_id for a missing path parameter.
  // v0.7.4: profileId is optional — we inject only if it is set. If it is not and the tool
  // requires a path parameter, the request goes out with an unfilled {user_id} and Avito returns
  // a clear error; until then tools/list works without credentials.
  if (
    spec.injectProfileId &&
    pathParams[spec.injectProfileId] === undefined &&
    ctx.config.profileId !== undefined
  ) {
    pathParams[spec.injectProfileId] = ctx.config.profileId;
  }

  // Mix in body.defaults (constant fields, credentials from .env, etc.) BEFORE user-args,
  // so that user input takes priority. Then — the optional transform.
  let finalBody: Record<string, unknown> | unknown[] | undefined;
  if (spec.body) {
    const defaults =
      typeof spec.body.defaults === 'function'
        ? spec.body.defaults(ctx)
        : (spec.body.defaults ?? {});
    finalBody = { ...defaults, ...body };
    if (spec.body.transform) {
      finalBody = spec.body.transform(finalBody as Record<string, unknown>);
    }
  }

  return {
    pathParams,
    query,
    body: finalBody,
  };
}

async function executeHttpRequest(
  cleanArgs: Record<string, unknown>,
  spec: ToolSpec,
  ctx: ToolContext,
  signal?: AbortSignal,
  onDispatch?: () => void,
): Promise<RequestResponse> {
  const { pathParams, query, body } = splitArgs(cleanArgs, spec, ctx);
  return ctx.client.request({
    ...(signal !== undefined ? { signal } : {}),
    ...(onDispatch !== undefined ? { onDispatch } : {}),
    method: spec.method,
    path: spec.path,
    pathParams,
    query,
    body,
    bodyContentType: spec.body?.contentType,
    auth: spec.auth ?? true,
    domain: spec.domain,
    staticHeaders: spec.staticHeaders,
    allowGetBody: spec.allowGetBody,
    retry: spec.retry,
  });
}

function formatResponse(status: number, data: unknown): string {
  if (data === null || data === undefined) {
    return `status=${status}\n(empty response body)`;
  }
  if (typeof data === 'string') {
    return `status=${status}\n${data}`;
  }
  // Binary responses come from client.ts as { __binary: true, mimeType, sizeBytes, base64 }.
  // We pre-format them so the LLM sees a clean structured payload and isn't surprised by a
  // multi-MB base64 string buried inside a regular JSON-stringify.
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { __binary?: unknown }).__binary === true
  ) {
    const b = data as { mimeType: string; sizeBytes: number; base64: string };
    return (
      `status=${status}\n` +
      `Binary response:\n` +
      `  mimeType:  ${b.mimeType}\n` +
      `  sizeBytes: ${b.sizeBytes}\n` +
      `  base64:    ${b.base64}\n`
    );
  }
  return `status=${status}\n${JSON.stringify(data, null, 2)}`;
}

/**
 * Short (~100-200 chars) description of a pending action for UI/log/list_pending.
 * Does not dump the full args — excerpts the most typical identifiers.
 */
function summarisePending(spec: ToolSpec, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['item_id', 'itemId', 'order_id', 'chat_id', 'message_id', 'vas_id', 'price']) {
    const v = args[key];
    if (v !== undefined) parts.push(`${key}=${String(v)}`);
  }
  const tail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${spec.method} ${spec.path}${tail}`;
}

/** Domain register function. Each file in src/domains/ exports one. */
export type DomainRegister = (server: McpServer, ctx: ToolContext) => void;
