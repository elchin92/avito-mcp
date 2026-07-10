/**
 * v0.9.0: Avito webhook RECEIVER (the inbound side).
 *
 * Avito POSTs messenger events to a public URL we register via messenger_post_webhook_v3
 * (operation postWebhookV3, path '/messenger/v3/webhook'). The receiver must answer
 * HTTP 200 within a 2 s timeout. Every secret candidate traverses the same bounded
 * JSON-body path before authentication affects control flow; otherwise a client can
 * distinguish a valid candidate by slowly streaming the request body. A one-second
 * absolute body deadline keeps that uniform path from becoming a slowloris surface.
 *
 * There is NO signature header in Avito's webhook protocol — the only auth is the
 * unguessable secret embedded in the URL PATH (POST {path}/{secret}). We compare
 * fixed-size hashes with crypto.timingSafeEqual and return the same 200/body for
 * valid and invalid candidates, while recording only valid deliveries.
 *
 * Avito also probes the URL during registration with
 *   curl --connect-timeout 2 <url> -i -d '{}'
 * expecting a 200 — an empty `{}` body (no `payload` field) is treated as a
 * verification ping: we answer 200 but record nothing.
 */
import { json, Router, type ErrorRequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';

import type { WebhookConfig } from '../config.js';
import { logger } from '../logger.js';
import type { WebhookStore } from '../core/webhook-store.js';

const MIN_RESPONSE_TIME_MS = 15;
const BODY_DEADLINE_MS = 1_000;

async function uniformOk(req: import('express').Request, res: import('express').Response) {
  const startedAt =
    typeof res.locals.webhookStartedAt === 'number' ? res.locals.webhookStartedAt : Date.now();
  const remaining = MIN_RESPONSE_TIME_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  if (!res.headersSent && !res.writableEnded && !res.destroyed) {
    res.status(200).json({ ok: true });
  }
}

/**
 * Constant-time secret comparison over fixed-size hashes. Exported for focused
 * tests and any future receiver adapters.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  // Hash first so timingSafeEqual always receives fixed-size inputs. This avoids
  // both its equal-length precondition and an early length-dependent return.
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
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
  const invalidSecretLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => void uniformOk(req, res),
  });

  router.post(
    `${webhookConfig.path}/:secret`,
    (req, res, next) => {
      res.locals.webhookStartedAt = Date.now();
      if (!webhookConfig.enabled || !expected) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Compute the constant-time result now, but do not branch on it until the
      // bounded body parser has completed. Correct and incorrect candidates must
      // wait for the same bytes or the path secret becomes a slow-body oracle.
      const secretParam = req.params.secret;
      const provided = Array.isArray(secretParam) ? (secretParam[0] ?? '') : (secretParam ?? '');
      res.locals.webhookSecretValid = secretsMatch(provided, expected);

      const deadline = setTimeout(() => {
        res.locals.webhookBodyTimedOut = true;
        // Do not keep an incomplete request alive after the uniform acknowledgement.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.setHeader('Connection', 'close');
        }
        res.once('finish', () => {
          if (!req.complete && !req.destroyed) req.destroy();
        });
        if (res.locals.webhookSecretValid === true) {
          void uniformOk(req, res);
        } else {
          // Incomplete invalid requests still consume the same per-IP budget as
          // completed guesses; the deadline must not become a limiter bypass.
          invalidSecretLimiter(req, res, () => void uniformOk(req, res));
        }
      }, BODY_DEADLINE_MS);
      const clearDeadline = () => clearTimeout(deadline);
      res.once('finish', clearDeadline);
      res.once('close', clearDeadline);
      next();
    },
    json({ limit: '1mb', strict: true }),
    (req, res, next) => {
      if (res.locals.webhookBodyTimedOut || res.locals.webhookSecretValid === true) {
        next();
        return;
      }
      // Rate-limit only failed authentication attempts, after the common bounded
      // body path. Applying the limiter to valid deliveries could silently lose a
      // legitimate Avito burst.
      invalidSecretLimiter(req, res, next);
    },
    async (req, res) => {
      try {
        // Only persist real deliveries. The verification ping is an empty `{}` with no
        // `payload` field — answer 200 but record nothing.
        const body = req.body as unknown;
        const looksLikeEvent =
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          'payload' in (body as Record<string, unknown>);
        if (
          !res.locals.webhookBodyTimedOut &&
          res.locals.webhookSecretValid === true &&
          looksLikeEvent
        ) {
          store.record(body);
        }

        // Always answer 200 FAST — Avito's 2 s timeout is unforgiving.
        await uniformOk(req, res);
      } catch (err) {
        // A handler must NEVER throw out: that could surface as a non-200 and make
        // Avito retry/disable the subscription. Log and answer 200 anyway.
        logger.error({ err }, 'webhook receiver handler error (answered 200 anyway)');
        await uniformOk(req, res);
      }
    },
  );

  // JSON syntax/size failures must not reveal whether the candidate secret was
  // valid. Invalid attempts still consume their rate-limit budget, but only after
  // the same bounded body path as authenticated deliveries.
  router.use((async (err, req, res, _next) => {
    if (res.locals.webhookBodyTimedOut) return;
    if (res.locals.webhookSecretValid !== true) {
      invalidSecretLimiter(req, res, () => void uniformOk(req, res));
      return;
    }
    await uniformOk(req, res);
    logger.warn({ err: (err as Error).message }, 'webhook delivery body rejected');
  }) as ErrorRequestHandler);

  return router;
}
