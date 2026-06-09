/**
 * v0.9.0: Avito webhook RECEIVER (the inbound side).
 *
 * Avito POSTs messenger events to a public URL we register via messenger_post_webhook_v3
 * (operation postWebhookV3, path '/messenger/v3/webhook'). The receiver must answer
 * HTTP 200 within a 2 s timeout, so the handler is strictly synchronous: it does a
 * constant-time secret check, hands the raw body to WebhookStore.record() (which does
 * its own fire-and-forget disk logging) and returns immediately. Never throws.
 *
 * There is NO signature header in Avito's webhook protocol — the only auth is the
 * unguessable secret embedded in the URL PATH (POST {path}/{secret}). We compare it
 * with crypto.timingSafeEqual and answer 404 (not 401/403) on any mismatch so an
 * attacker can't distinguish "wrong secret" from "no receiver here".
 *
 * Avito also probes the URL during registration with
 *   curl --connect-timeout 2 <url> -i -d '{}'
 * expecting a 200 — an empty `{}` body (no `payload` field) is treated as a
 * verification ping: we answer 200 but record nothing.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';

import type { WebhookConfig } from '../config.js';
import { logger } from '../logger.js';
import type { WebhookStore } from '../core/webhook-store.js';

/**
 * Constant-time secret comparison. Node's timingSafeEqual requires equal-length
 * buffers, so a length mismatch short-circuits to false (without leaking the
 * expected length through a thrown error). Exported for the app-level error
 * handler, which must honour the always-200 contract for genuine Avito
 * deliveries even when body parsing failed.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Builds the Express Router that accepts Avito's webhook deliveries.
 *
 * Mounts a single route: POST `${webhookConfig.path}/:secret`. The router is inert
 * (every request → 404) unless the receiver is both enabled and has a secret — this
 * keeps the surface area zero when the operator hasn't opted in.
 */
export function createWebhookRouter(webhookConfig: WebhookConfig, store: WebhookStore): Router {
  const router = Router();
  const expected = webhookConfig.secret;

  router.post(`${webhookConfig.path}/:secret`, (req, res) => {
    try {
      // Receiver disabled or no secret configured → behave as if the route doesn't exist.
      if (!webhookConfig.enabled || !expected) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Constant-time secret check; 404 on mismatch (don't reveal validity).
      const provided = req.params.secret ?? '';
      if (!secretsMatch(provided, expected)) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Only persist real deliveries. The verification ping is an empty `{}` with no
      // `payload` field — answer 200 but record nothing.
      const body = req.body as unknown;
      const looksLikeEvent =
        body !== null &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'payload' in (body as Record<string, unknown>);
      if (looksLikeEvent) {
        store.record(body);
      }

      // Always answer 200 FAST — Avito's 2 s timeout is unforgiving.
      res.status(200).json({ ok: true });
    } catch (err) {
      // A handler must NEVER throw out: that could surface as a non-200 and make
      // Avito retry/disable the subscription. Log and answer 200 anyway.
      logger.error({ err }, 'webhook receiver handler error (answered 200 anyway)');
      if (!res.headersSent) res.status(200).json({ ok: true });
    }
  });

  return router;
}
