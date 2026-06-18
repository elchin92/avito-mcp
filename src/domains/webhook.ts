/**
 * `webhook` domain (v0.9.0) — the RECEIVER side of the Avito messenger webhook.
 *
 * These tools belong to the messenger surface (snake_case `messenger_*` names, so the
 * manifest maps them to the 'messenger' domain), but they live in their own file because
 * they read the in-process WebhookStore (ctx.webhookStore) rather than calling the Avito
 * API. The receiver itself is src/http/webhook.ts; events flow once you point Avito at the
 * configured public URL (messenger_register_webhook / messenger_post_webhook_v3).
 *
 * Three tools:
 *   - messenger_get_webhook_events  (read)  — list received events, newest-first.
 *   - messenger_get_webhook_status  (read)  — receiver config + ring-buffer stats.
 *   - messenger_register_webhook    (write) — subscribe Avito to the configured receiver URL.
 *
 * The register function is NOT wired into domain-registry.ts here — the orchestrator does that.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logger } from '../logger.js';
import { defineTool, type DomainRegister } from '../core/tool-factory.js';
import { evaluatePolicy } from '../core/policy.js';

/**
 * Normalises the `since` filter to a millisecond epoch suitable for
 * WebhookStore.list({ since }). Accepts:
 *   - a number: epoch seconds (< 1e12) → ms, otherwise already ms.
 *   - a numeric string: same rules after parsing.
 *   - an ISO-8601 date string: Date.parse.
 * Returns undefined for anything unparseable (the filter is then skipped).
 */
function resolveSince(raw: number | string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // Pure-numeric string → treat as epoch (seconds or ms).
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return undefined;
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Shows only the last 4 chars of a secret, masking the rest (e.g. "••••ab12"). */
function maskSecret(secret: string): string {
  if (secret.length <= 4) return '•'.repeat(secret.length);
  return '•'.repeat(secret.length - 4) + secret.slice(-4);
}

/**
 * Rejects URLs Avito's infrastructure can never deliver to: non-HTTPS schemes,
 * loopback/wildcard hosts and RFC 1918 private ranges. Registering such a URL
 * "succeeds" on the Avito side but silently delivers nothing — the worst
 * possible failure mode for a webhook subscription.
 */
function assertAvitoReachableUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Webhook URL is not a valid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.');
  const isPrivate =
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isLoopback || isPrivate) {
    throw new Error(
      `Webhook URL host '${host}' is not reachable from Avito (loopback/private address). ` +
        'Set AVITO_MCP_WEBHOOK_PUBLIC_URL (or AVITO_MCP_HTTP_PUBLIC_URL) to the public ' +
        'HTTPS address of this server, or pass `url` explicitly.',
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `Webhook URL must be HTTPS (got ${url.protocol}//): Avito only delivers events to public HTTPS endpoints.`,
    );
  }
}

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ: events ──────────────────────────────

  const eventsDecision = evaluatePolicy('messenger_get_webhook_events', 'read', ctx.config);
  if (!eventsDecision.allowed) {
    logger.info(
      { tool: 'messenger_get_webhook_events', risk: 'read', reason: eventsDecision.reason },
      'tool hidden by policy',
    );
  } else {
    server.registerTool(
      'messenger_get_webhook_events',
      {
        title: 'Received webhook events',
        description:
          'Returns Avito messenger webhook events RECEIVED by this server (new chat messages), newest-first. ' +
          'Reads the in-process buffer filled by the webhook receiver — does NOT call the Avito API and ' +
          'does NOT mark anything as read. Requires the receiver to be enabled (set AVITO_MCP_WEBHOOK_SECRET) ' +
          'and Avito subscribed to the receiver URL (messenger_register_webhook). Supports filtering by chat_id, ' +
          'a `since` cutoff (ISO-8601 timestamp or epoch seconds/ms), and a `limit`. ' +
          'Check the receiver config and buffer stats with messenger_get_webhook_status.',
        inputSchema: {
          since: z
            .union([z.number(), z.string()])
            .optional()
            .describe(
              'Only events received at/after this time. Accepts an ISO-8601 string (e.g. "2026-06-09T10:00:00Z") ' +
                'or an epoch number (seconds or milliseconds). Omit for no lower bound.',
            ),
          chat_id: z
            .string()
            .optional()
            .describe('Filter to a single chat_id (as seen in the event payload). Omit for all chats.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum number of events to return (1–100). Omit to return all retained events.'),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { risk: 'read', environment: 'local' },
      },
      async (args): Promise<CallToolResult> => {
        // Receiver disabled → no store. Report clearly how to enable it instead of failing.
        if (!ctx.webhookStore) {
          const note = {
            enabled: false,
            events: [],
            count: 0,
            hint:
              'Webhook receiver is disabled. Set AVITO_MCP_WEBHOOK_SECRET (and ' +
              'AVITO_MCP_WEBHOOK_PUBLIC_URL for a public domain) to enable it, then call ' +
              'messenger_register_webhook so Avito starts delivering events.',
          };
          return {
            content: [
              {
                type: 'text',
                text:
                  'Webhook receiver is disabled — no events are being collected. ' +
                  'Enable it by setting AVITO_MCP_WEBHOOK_SECRET (and AVITO_MCP_WEBHOOK_PUBLIC_URL ' +
                  'for a public domain), then register the URL with Avito via messenger_register_webhook.',
              },
            ],
            structuredContent: note,
          };
        }

        const since = resolveSince(args.since as number | string | undefined);
        const chatId = args.chat_id as string | undefined;
        const limit = args.limit as number | undefined;
        const events = ctx.webhookStore.list({ since, chatId, limit });
        return {
          content: [{ type: 'text', text: JSON.stringify(events, null, 2) }],
          structuredContent: { enabled: true, events, count: events.length },
        };
      },
    );
  }

  // ────────────────────────────── READ: status ──────────────────────────────

  const statusDecision = evaluatePolicy('messenger_get_webhook_status', 'read', ctx.config);
  if (!statusDecision.allowed) {
    logger.info(
      { tool: 'messenger_get_webhook_status', risk: 'read', reason: statusDecision.reason },
      'tool hidden by policy',
    );
  } else {
    server.registerTool(
      'messenger_get_webhook_status',
      {
        title: 'Webhook receiver status',
        description:
          'Returns the configuration and live stats of this server\'s Avito webhook RECEIVER: whether it is enabled, ' +
          'the public URL, the subscribe URL (with the secret masked), and ring-buffer counters (retained / total / last received). ' +
          'Does NOT call the Avito API. Use it to verify the receiver is set up before messenger_register_webhook, ' +
          'then read collected events with messenger_get_webhook_events.',
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
        const w = ctx.config.webhook;
        const publicUrl = w.enabled ? w.publicUrl : null;
        // Subscribe URL with the secret masked — never echo the real secret.
        const subscribeUrl =
          w.enabled && w.secret ? `${w.publicUrl}${w.path}/${maskSecret(w.secret)}` : null;
        const hint = w.enabled
          ? 'Receiver is enabled. Subscribe Avito to the (unmasked) URL via messenger_register_webhook, ' +
            'then poll messenger_get_webhook_events.'
          : 'Receiver is disabled. Set AVITO_MCP_WEBHOOK_SECRET (and AVITO_MCP_WEBHOOK_PUBLIC_URL for a public domain) to enable it.';
        const payload = {
          enabled: w.enabled,
          public_url: publicUrl,
          subscribe_url: subscribeUrl,
          stats: ctx.webhookStore?.stats() ?? null,
          hint,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  }

  // ────────────────────────────── WRITE: register ──────────────────────────────

  // Subscribes Avito to the configured receiver URL. Reuses the generic confirmation /
  // dry-run / idempotency machinery via defineTool. The default URL is computed from the
  // webhook config; caller input may repeat that URL but must not redirect events elsewhere.
  defineTool(server, ctx, {
    name: 'messenger_register_webhook',
    title: '⚠️ Register webhook receiver',
    risk: 'write',
    description:
      'Subscribes Avito to THIS server\'s configured webhook receiver URL so messenger events (new chat messages) start flowing. ' +
      'Registers only the URL derived from the webhook config (AVITO_MCP_WEBHOOK_PUBLIC_URL + path + secret). ' +
      'Adds a webhook subscription (additive — it does not delete other subscriptions); Avito will then ' +
      'POST events to the URL (requires a PUBLIC HTTPS address reachable from the internet; localhost does not work). ' +
      'Same operation as messenger_post_webhook_v3, but auto-fills the URL from config. ' +
      'Pairs with messenger_get_webhook_events (read received events) and messenger_get_webhook_status (receiver config). ' +
      'To unsubscribe, use messenger_post_webhook_unsubscribe.',
    method: 'POST',
    path: '/messenger/v3/webhook',
    domain: 'messenger',
    input: {
      url: z
        .string()
        .url()
        .optional()
        .describe(
          'Optional explicit copy of the configured receiver URL Avito should POST events to. ' +
            'For safety, it must equal publicUrl + path + secret; omit to auto-fill it.',
        ),
    },
    body: {
      contentType: 'application/json',
      // The registration endpoint changes where Avito will send future messenger events.
      // Never allow a caller-provided URL to redirect those events to an arbitrary host;
      // it may only repeat the operator-configured receiver URL.
      defaults: (c) => {
        const w = c.config.webhook;
        if (!w.enabled || !w.secret) {
          throw new Error(
            'Webhook receiver is not configured: set AVITO_MCP_WEBHOOK_SECRET (and ' +
              'AVITO_MCP_WEBHOOK_PUBLIC_URL for a public domain).',
          );
        }
        return { url: `${w.publicUrl}${w.path}/${w.secret}` };
      },
      transform: (body) => {
        const expectedUrl = `${ctx.config.webhook.publicUrl}${ctx.config.webhook.path}/${ctx.config.webhook.secret}`;
        const url = typeof body.url === 'string' ? body.url : undefined;
        if (!url) {
          throw new Error('Webhook receiver URL could not be computed from config.');
        }
        if (url !== expectedUrl) {
          throw new Error(
            'Webhook URL override must match the configured receiver URL; arbitrary webhook destinations are not allowed.',
          );
        }
        assertAvitoReachableUrl(url);
        return body;
      },
    },
  });
};
