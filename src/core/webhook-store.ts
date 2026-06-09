/**
 * v0.9.0: in-memory ring buffer of received Avito webhook events.
 *
 * Avito POSTs messenger events to a public URL (see swaggers/messenger.json,
 * operation postWebhookV3). The receiver (src/http/webhook.ts) must answer 200
 * within 2 s, so it only does a synchronous `record()` here and returns — any
 * disk I/O (the optional JSONL log) is fire-and-forget.
 *
 * Mirrors PendingActionStore: a bounded buffer plus an onChange emitter, which
 * backs the subscribable MCP resource `avito://webhook/events` (clients can
 * resources/subscribe and get notifications/resources/updated on every event).
 *
 * Deliberately NOT a source of truth: events older than `bufferSize` fall off.
 * For durable history set AVITO_MCP_WEBHOOK_LOG_FILE (append-only JSONL).
 */
import { appendFile } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { logger } from '../logger.js';

/** Normalised view of one received webhook delivery. */
export interface WebhookEvent {
  /** Server-side receipt id (16 hex) — stable handle even when Avito omits `id`. */
  recv_id: string;
  /** Wall-clock receive time (ms epoch). */
  received_at: number;
  /** Avito's webhook message id (envelope.id), if present. */
  id?: string;
  /** Webhook protocol version (envelope.version), e.g. "v3". */
  version?: string;
  /** Avito send timestamp (envelope.timestamp, unix seconds), if present. */
  timestamp?: number;
  /** Payload kind (envelope.payload.type), typically "message". */
  payload_type?: string;
  /** Chat id from payload.value.chat_id (messenger events). */
  chat_id?: string;
  /** Author id from payload.value.author_id. */
  author_id?: number;
  /** Message type from payload.value.type (text/image/system/...). */
  message_type?: string;
  /** Recipient account id from payload.value.user_id (the subscribed account). */
  user_id?: number;
  /** Linked item id from payload.value.item_id (u2i chats). */
  item_id?: number;
  /** The full raw delivery as received (already JSON-parsed). */
  raw: unknown;
}

export type WebhookChangeListener = (event: WebhookEvent) => void;

interface Envelope {
  id?: unknown;
  version?: unknown;
  timestamp?: unknown;
  payload?: { type?: unknown; value?: Record<string, unknown> };
}

/** Pulls the interesting fields out of the Avito envelope; tolerant of shape drift. */
function summarise(raw: unknown): Omit<WebhookEvent, 'recv_id' | 'received_at' | 'raw'> {
  const env = (raw ?? {}) as Envelope;
  const value = (env.payload?.value ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    id: str(env.id),
    version: str(env.version),
    timestamp: num(env.timestamp),
    payload_type: str(env.payload?.type),
    chat_id: str(value.chat_id),
    author_id: num(value.author_id),
    message_type: str(value.type),
    user_id: num(value.user_id),
    item_id: num(value.item_id),
  };
}

export class WebhookStore {
  private events: WebhookEvent[] = [];
  private listeners: WebhookChangeListener[] = [];
  private total = 0;
  private lastReceivedAt: number | undefined;

  /**
   * @param bufferSize max retained events (oldest dropped past this).
   * @param logFile    optional JSONL path; each event appended fire-and-forget.
   */
  constructor(
    private readonly bufferSize: number,
    private readonly logFile?: string,
  ) {}

  /** Records a raw delivery, returns the normalised event. Never throws. */
  record(raw: unknown): WebhookEvent {
    const event: WebhookEvent = {
      recv_id: randomBytes(8).toString('hex'),
      received_at: Date.now(),
      ...summarise(raw),
      raw,
    };
    this.events.push(event);
    if (this.events.length > this.bufferSize) {
      this.events.splice(0, this.events.length - this.bufferSize);
    }
    this.total += 1;
    this.lastReceivedAt = event.received_at;
    this.appendLog(event);
    this.emit(event);
    return event;
  }

  /**
   * Returns retained events newest-first, optionally filtered.
   * @param opts.since   only events with received_at >= this (ms epoch).
   * @param opts.chatId  only events for this chat_id.
   * @param opts.limit   cap (default = all retained).
   */
  list(opts: { since?: number; chatId?: string; limit?: number } = {}): WebhookEvent[] {
    let out = [...this.events].reverse();
    if (opts.since !== undefined) out = out.filter((e) => e.received_at >= opts.since!);
    if (opts.chatId !== undefined) out = out.filter((e) => e.chat_id === opts.chatId);
    if (opts.limit !== undefined && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out;
  }

  /** Aggregate counters for the status tool. */
  stats(): { retained: number; total_received: number; last_received_at: string | null; buffer_size: number } {
    return {
      retained: this.events.length,
      total_received: this.total,
      last_received_at: this.lastReceivedAt ? new Date(this.lastReceivedAt).toISOString() : null,
      buffer_size: this.bufferSize,
    };
  }

  /** Subscribe to new events. Returns an unsubscribe function. */
  onChange(listener: WebhookChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: WebhookEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A subscriber must never break the receiver.
      }
    }
  }

  private appendLog(event: WebhookEvent): void {
    if (!this.logFile) return;
    appendFile(this.logFile, JSON.stringify(event) + '\n', (err) => {
      if (err) logger.debug({ err, logFile: this.logFile }, 'webhook log append failed');
    });
  }
}
