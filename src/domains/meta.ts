/**
 * Meta tools — not part of swagger; they provide observability and safety for the MCP server itself.
 *
 * v0.6.x: rate-limits + confirmation flow.
 * v0.7.0: added health / auth_status / capabilities with a strict outputSchema —
 *         universal diagnostic tools useful to any MCP client.
 *
 * Confirmation tools are registered only when AVITO_MCP_CONFIRMATION_MODE != 'off'.
 * All meta_* tools run in the local environment, without calling the Avito API (except auth_status,
 * which optionally attempts a ping via a client_credentials refresh).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { logger } from '../logger.js';
import { hasConfiguredCredentials } from '../core/credentials.js';
import { evaluatePolicy, requiresConfirmation } from '../core/policy.js';
import type { DomainRegister } from '../core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

/**
 * Constant-time secret comparison. Equal-length buffers required by Node's
 * timingSafeEqual; length mismatch short-circuits to false without leaking length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function confirmationPrincipal(extra: {
  authInfo?: { clientId?: string };
  sessionId?: string;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}): string {
  if (extra.authInfo?.clientId) return `oauth:${extra.authInfo.clientId}`;
  const raw = extra.requestInfo?.headers?.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (bearer) {
    return `bearer:${createHash('sha256').update(bearer).digest('base64url')}`;
  }
  return `session:${extra.sessionId ?? 'local-stdio'}`;
}

export const register: DomainRegister = (server, ctx) => {
  // ───────────────── meta_get_rate_limits ─────────────────

  const rlDecision = evaluatePolicy('meta_get_rate_limits', 'read', ctx.config);
  if (!rlDecision.allowed) {
    logger.info(
      { tool: 'meta_get_rate_limits', risk: 'read', reason: rlDecision.reason },
      'tool hidden by policy',
    );
  } else {
    server.registerTool(
      'meta_get_rate_limits',
      {
        title: 'Rate-limit status',
        description:
          'Returns the most recently observed X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset values, ' +
          'grouped by logical API domain (core, messenger, items, etc.). ' +
          'Useful for diagnosing "why am I being throttled" — Avito enforces a per-minute limit.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const snaps = ctx.client.rateLimiter.getStatus();
        if (snaps.length === 0) {
          return {
            content: [{ type: 'text', text: 'No data: no requests to Avito have been made yet.' }],
            structuredContent: { snapshots: [], count: 0 },
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(snaps, null, 2) }],
          structuredContent: { snapshots: snaps, count: snaps.length },
        };
      },
    );
  }

  // ───────────────── v0.7.0: meta_health ─────────────────

  const healthDecision = evaluatePolicy('meta_health', 'read', ctx.config);
  if (healthDecision.allowed) {
    server.registerTool(
      'meta_health',
      {
        title: 'Health: overall server status',
        description:
          'Universal health-check: package version, active capabilities, rate-limit ' +
          'status, idempotency ledger size, pending actions count, dryRun default. ' +
          'Does not call the Avito API. Safe to call as often as you like.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        outputSchema: {
          ok: z.boolean(),
          name: z.string(),
          version: z.string(),
          uptimeSec: z.number(),
          capabilities: z.object({
            tools: z.boolean(),
            resources: z.boolean(),
            prompts: z.boolean(),
            logging: z.boolean(),
          }),
          safety: z.object({
            mode: z.string(),
            confirmationMode: z.string(),
            hardConfirmation: z.boolean(),
            dryRunDefault: z.boolean(),
            exposeAuthTools: z.boolean(),
          }),
          counters: z.object({
            pendingActions: z.number().int(),
            idempotencyEntries: z.number().int(),
            rateLimitSnapshots: z.number().int(),
          }),
          timestamp: z.string(),
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const payload = {
          ok: true,
          name: PACKAGE_NAME,
          version: VERSION,
          uptimeSec: Math.round(process.uptime()),
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            logging: true,
          },
          safety: {
            mode: ctx.config.mode,
            confirmationMode: ctx.config.confirmationMode,
            hardConfirmation: !!ctx.config.confirmationSecret,
            dryRunDefault: ctx.config.dryRunDefault,
            exposeAuthTools: ctx.config.exposeAuthTools,
          },
          counters: {
            pendingActions: ctx.pendingStore.size(),
            idempotencyEntries: ctx.idempotencyStore?.size() ?? 0,
            rateLimitSnapshots: ctx.client.rateLimiter.getStatus().length,
          },
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  } else {
    logger.info(
      { tool: 'meta_health', risk: 'read', reason: healthDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── v0.7.0: meta_auth_status ─────────────────

  const authStatusDecision = evaluatePolicy('meta_auth_status', 'read', ctx.config);
  if (authStatusDecision.allowed) {
    server.registerTool(
      'meta_auth_status',
      {
        title: 'Auth: OAuth token status (no secrets)',
        description:
          'Reports only token METADATA: present/absent, expiresInSec, last refresh ' +
          'error. The token itself is NEVER returned — for that use the auth_* tools under ' +
          'AVITO_MCP_EXPOSE_AUTH_TOOLS=1 (hidden by default). By default it does not force a refresh — ' +
          'if probe=true, it will attempt getToken() (which may trigger a refresh).',
        inputSchema: {
          probe: z
            .boolean()
            .optional()
            .describe(
              'If true, attempt getToken(), which may trigger a refresh when the token has expired. Default false.',
            ),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        outputSchema: {
          configured: z.boolean(),
          tokenPresent: z.boolean(),
          expiresInSec: z.number().int().nullable(),
          probeOk: z.boolean().nullable(),
          lastError: z.string().nullable(),
          tokenFile: z.string(),
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (args): Promise<CallToolResult> => {
        const configured = hasConfiguredCredentials(ctx.config);
        let probeOk: boolean | null = null;
        let lastError: string | null = null;
        if (args.probe === true && configured) {
          try {
            await ctx.client.tokenStore.getToken();
            probeOk = true;
          } catch (err) {
            probeOk = false;
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        // Account-bound metadata only. Legacy or foreign-account records are
        // treated as absent, and the token/path never leave the process.
        const metadata = await ctx.client.tokenStore.getMetadata();
        const expiresInSec =
          metadata.expiresAt === undefined
            ? null
            : Math.max(0, Math.floor((metadata.expiresAt - Date.now()) / 1000));
        const payload = {
          configured,
          tokenPresent: metadata.present,
          expiresInSec,
          probeOk,
          lastError,
          tokenFile: '[redacted]',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  } else {
    logger.info(
      { tool: 'meta_auth_status', risk: 'read', reason: authStatusDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── v0.7.0: meta_capabilities ─────────────────

  const capDecision = evaluatePolicy('meta_capabilities', 'read', ctx.config);
  if (capDecision.allowed) {
    server.registerTool(
      'meta_capabilities',
      {
        title: 'Capabilities: what is enabled in this run',
        description:
          'Returns a machine-readable description of the current configuration: mode, allow/deny lists, ' +
          'confirmation, dry-run, idempotency, local file access. Useful for an agent to ' +
          'understand which operations are fundamentally available before attempting to call tools.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        outputSchema: {
          name: z.string(),
          version: z.string(),
          mode: z.string(),
          allowToolsCount: z.number().int(),
          denyToolsCount: z.number().int(),
          features: z.object({
            dryRun: z.boolean(),
            idempotency: z.boolean(),
            confirmation: z.boolean(),
            hardConfirmation: z.boolean(),
            fileUploads: z.boolean(),
            sensitiveAuthTools: z.boolean(),
          }),
          confirmationMode: z.string(),
          dryRunDefault: z.boolean(),
          idempotencyTtlSec: z.number().int(),
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const payload = {
          name: PACKAGE_NAME,
          version: VERSION,
          mode: ctx.config.mode,
          allowToolsCount: ctx.config.allowTools.length,
          denyToolsCount: ctx.config.denyTools.length,
          features: {
            dryRun: true,
            idempotency: !!ctx.idempotencyStore,
            confirmation: ctx.config.confirmationMode !== 'off',
            hardConfirmation: !!ctx.config.confirmationSecret,
            fileUploads: ctx.config.allowedUploadDirs.length > 0,
            sensitiveAuthTools: ctx.config.exposeAuthTools,
          },
          confirmationMode: ctx.config.confirmationMode,
          dryRunDefault: ctx.config.dryRunDefault,
          idempotencyTtlSec: ctx.config.idempotencyTtlSec,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  } else {
    logger.info(
      { tool: 'meta_capabilities', risk: 'read', reason: capDecision.reason },
      'tool hidden by policy',
    );
  }

  // Confirmation tools are registered only when the confirmation flow is enabled.
  // This is both simpler for the agent (no extraneous tools when they are meaningless)
  // and reduces surface area when confirmation is deliberately turned off.
  if (ctx.config.confirmationMode === 'off') {
    logger.info(
      { confirmationMode: 'off' },
      'confirmation tools hidden because AVITO_MCP_CONFIRMATION_MODE=off',
    );
    return;
  }

  // v0.5.1: each confirmation tool passes through evaluatePolicy SEPARATELY.
  // Before v0.5.0 they slipped past allow/deny — this violated the contract.
  // Now the allowlist/denylist fully covers the registry.
  const confirmDecision = evaluatePolicy('meta_confirm_action', 'write', ctx.config);
  const cancelDecision = evaluatePolicy('meta_cancel_action', 'write', ctx.config);
  const listDecision = evaluatePolicy('meta_list_pending_actions', 'read', ctx.config);

  // DX warning: if confirmation is enabled, money/public tools will return pending,
  // but if meta_confirm_action is blocked, there is no one to confirm the pending action.
  if (!confirmDecision.allowed) {
    logger.warn(
      { reason: confirmDecision.reason, confirmationMode: ctx.config.confirmationMode },
      'AVITO_MCP_CONFIRMATION_MODE is enabled but meta_confirm_action is hidden by policy — ' +
        'pending actions will be unconfirmable. Either add meta_confirm_action to your allowlist ' +
        'or set AVITO_MCP_CONFIRMATION_MODE=off.',
    );
  }

  // ───────────────── meta_confirm_action ─────────────────

  const requireSecret = !!ctx.config.confirmationSecret;
  const maxFailedConfirmationAttempts = 5;
  if (confirmDecision.allowed)
    server.registerTool(
      'meta_confirm_action',
      {
        title: '✓ Confirm a pending action',
        description:
          '⚠️ Executes a previously deferred action by its confirmation_id. ' +
          'Use ONLY after explicit human confirmation — the flow is designed as a server-side ' +
          'two-step guard against accidental one-shot execution, not as cryptographic protection ' +
          'against an autonomous agent. Confirmation is single-use: the id is deleted after a successful call. ' +
          (requireSecret
            ? 'AVITO_MCP_CONFIRMATION_SECRET is set: a confirmation_secret parameter is additionally required ' +
              '(compared constant-time). Without it the confirmation is rejected. This is hard-confirmation ' +
              '— the secret is generated and kept by a human, and the agent cannot obtain it.'
            : 'AVITO_MCP_CONFIRMATION_SECRET is not set — soft-confirmation is in effect. ' +
              'Set the env variable to switch to hard-confirmation.'),
        inputSchema: {
          confirmation_id: z
            .string()
            .min(16)
            .describe(
              'ID of the pending action (returned in the confirmation_id field on the first tool call).',
            ),
          confirmation_secret: z
            .string()
            .optional()
            .describe(
              requireSecret
                ? 'The required AVITO_MCP_CONFIRMATION_SECRET value (entered by a human).'
                : 'Not used when AVITO_MCP_CONFIRMATION_SECRET is not set.',
            ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        _meta: { risk: 'write', environment: 'local' },
      },
      async (args, extra): Promise<CallToolResult> => {
        const id = String(args.confirmation_id ?? '');

        if (requireSecret) {
          const rate = ctx.pendingStore.checkConfirmationRateLimit(confirmationPrincipal(extra));
          if (!rate.allowed) {
            logger.warn(
              { retryAfterMs: rate.retryAfterMs },
              'confirmation rejected: principal rate limit reached',
            );
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'Confirmation temporarily rate-limited after too many attempts. Retry later.',
                },
              ],
              structuredContent: {
                error: { kind: 'RATE_LIMITED', retry_after_ms: rate.retryAfterMs },
              },
            };
          }
        }

        const pending = ctx.pendingStore.get(id);
        if (!pending) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Confirmation '${id}' not found. Possible causes: invalid id, expired TTL (${ctx.config.confirmationTtlSec}s), or already confirmed or cancelled.`,
              },
            ],
          };
        }

        // Hard-confirmation: only check the reusable secret after a valid pending id
        // exists. This avoids turning arbitrary/nonexistent confirmation_id values
        // into an oracle for testing global secret guesses.
        if (requireSecret) {
          const provided =
            typeof args.confirmation_secret === 'string' ? args.confirmation_secret : '';
          if (!provided || !secretsMatch(provided, ctx.config.confirmationSecret!)) {
            const attempt = ctx.pendingStore.recordFailedConfirmation(
              id,
              maxFailedConfirmationAttempts,
            );
            if (!attempt.found) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `Confirmation '${id}' is no longer available.`,
                  },
                ],
              };
            }
            logger.warn(
              {
                confirmation_id: id,
                hasSecret: !!provided,
                failedAttempts: attempt.failedAttempts,
                locked: attempt.locked,
              },
              'confirmation rejected: bad or missing confirmation_secret',
            );
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: attempt.locked
                    ? 'Confirmation rejected. Too many bad or missing confirmation_secret attempts; pending action deleted.'
                    : 'Confirmation rejected. Bad or missing confirmation_secret. Pending action is NOT deleted by this rejection; retry with the correct secret before the TTL expires, or call meta_cancel_action to discard it.',
                },
              ],
            };
          }
          ctx.pendingStore.resetConfirmationFailures(id);
        }
        // Re-evaluate policy — the user may have changed the config between create and confirm.
        const decision = evaluatePolicy(pending.toolName, pending.risk, ctx.config);
        if (!decision.allowed) {
          ctx.pendingStore.delete(id);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Tool '${pending.toolName}' is no longer allowed by policy: ${decision.reason}. Pending action deleted.`,
              },
            ],
          };
        }
        // Atomically claim before execution. A concurrent session that passed
        // the checks above must not execute the same pending mutation twice.
        const claimed = ctx.pendingStore.take(id);
        if (!claimed) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Confirmation '${id}' was already confirmed, cancelled, or expired.`,
              },
            ],
          };
        }
        logger.info(
          {
            tool: claimed.toolName,
            risk: claimed.risk,
            confirmation_id: id,
            hardConfirmation: requireSecret,
          },
          'pending action confirmed and executing',
        );
        try {
          // claimed.execute() records the final idempotency result before it
          // resolves. Keep the claim active until then so the original tool call
          // cannot treat its confirmation id as stale and create a second action.
          return await claimed.execute();
        } finally {
          ctx.pendingStore.complete(id);
        }
      },
    );

  if (!confirmDecision.allowed) {
    logger.info(
      { tool: 'meta_confirm_action', risk: 'write', reason: confirmDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── meta_cancel_action ─────────────────

  if (cancelDecision.allowed)
    server.registerTool(
      'meta_cancel_action',
      {
        title: '✗ Cancel a pending action',
        description:
          'Cancels a previously deferred action. After cancellation the confirmation_id is no longer valid.',
        inputSchema: {
          confirmation_id: z.string().min(16).describe('ID of the pending action to cancel.'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { risk: 'write', environment: 'local' },
      },
      async (args): Promise<CallToolResult> => {
        const id = String(args.confirmation_id ?? '');
        const existed = ctx.pendingStore.delete(id);
        return {
          content: [
            {
              type: 'text',
              text: existed
                ? `Pending action '${id}' cancelled.`
                : `Pending action '${id}' not found (it may have already expired, been confirmed, or been cancelled).`,
            },
          ],
          structuredContent: { confirmation_id: id, cancelled: existed },
        };
      },
    );

  if (!cancelDecision.allowed) {
    logger.info(
      { tool: 'meta_cancel_action', risk: 'write', reason: cancelDecision.reason },
      'tool hidden by policy',
    );
  }

  // ───────────────── meta_list_pending_actions ─────────────────

  if (listDecision.allowed)
    server.registerTool(
      'meta_list_pending_actions',
      {
        title: 'Pending actions: list',
        description:
          'Lists the current pending actions awaiting confirmation. Args are not shown — ' +
          'only tool name, risk, a brief summary, and the creation and expiration times. ' +
          'Use it to diagnose "what did I just ask to confirm".',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (): Promise<CallToolResult> => {
        const items = ctx.pendingStore.list();
        if (items.length === 0) {
          return {
            content: [{ type: 'text', text: 'No pending actions.' }],
            structuredContent: {
              pending: [],
              count: 0,
              confirmation_mode: ctx.config.confirmationMode,
            },
          };
        }
        const view = items.map((a) => ({
          id: a.id,
          tool: a.toolName,
          risk: a.risk,
          summary: a.summary,
          created_at: new Date(a.createdAt).toISOString(),
          expires_at: new Date(a.expiresAt).toISOString(),
          // Not: args, because they may contain item_id, message_id, prices, etc. in an undesirable amount
          // Not: execute, because it is a closure
        }));
        const requiresHint =
          `\n\nConfirmation mode = ${ctx.config.confirmationMode}. ` +
          `Require confirmation in this mode: ` +
          (requiresConfirmation('money', ctx.config) ? 'money ' : '') +
          (requiresConfirmation('public', ctx.config) ? 'public ' : '') +
          (requiresConfirmation('write', ctx.config) ? 'write ' : '');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(view, null, 2) + requiresHint,
            },
          ],
          structuredContent: {
            pending: view,
            count: view.length,
            confirmation_mode: ctx.config.confirmationMode,
          },
        };
      },
    );
  if (!listDecision.allowed) {
    logger.info(
      { tool: 'meta_list_pending_actions', risk: 'read', reason: listDecision.reason },
      'tool hidden by policy',
    );
  }
};
