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
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  promises as fs,
} from 'node:fs';
import { dirname } from 'node:path';
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

export interface WebhookLogOptions {
  /** Maximum active JSONL size before rotation. Default: 10 MiB. */
  maxLogBytes?: number;
  /** Total files retained including the active file. Default: 2. */
  retainedFiles?: number;
}

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
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v.slice(0, 512) : undefined;
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

  /** Throttle for append-failure logging: first failure logs, then one per minute. */
  private lastAppendErrorAt = 0;
  private appendQueue: Promise<void> = Promise.resolve();
  private persistenceHealthy = true;
  private readonly maxLogBytes: number;
  private readonly retainedFiles: number;

  /**
   * @param bufferSize max retained events (oldest dropped past this).
   * @param logFile    optional JSONL path; each event appended fire-and-forget.
   */
  constructor(
    private readonly bufferSize: number,
    private readonly logFile?: string,
    logOptions: WebhookLogOptions = {},
  ) {
    this.maxLogBytes = logOptions.maxLogBytes ?? 10 * 1024 * 1024;
    this.retainedFiles = Math.max(1, logOptions.retainedFiles ?? 2);
    if (this.logFile) {
      // fs.appendFile does not create parent directories — without this a typo'd
      // AVITO_MCP_WEBHOOK_LOG_FILE silently loses every event (ENOENT per append).
      try {
        mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
        try {
          const stat = lstatSync(this.logFile);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('webhook log path must be a regular file, not a symlink or device');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
        const fd = openSync(
          this.logFile,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
          0o600,
        );
        try {
          if (!fstatSync(fd).isFile()) throw new Error('webhook log descriptor is not a file');
          fchmodSync(fd, 0o600);
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        this.persistenceHealthy = false;
        logger.warn(
          { err, logFile: this.logFile },
          'webhook log: cannot create parent directory — events will NOT be persisted',
        );
      }
    }
  }

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
  stats(): {
    retained: number;
    total_received: number;
    last_received_at: string | null;
    buffer_size: number;
  } {
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

  /** Waits for queued durability writes; intended for graceful shutdown and tests. */
  async flush(): Promise<void> {
    await this.appendQueue;
  }

  /** False after a configured persistence write fails; true again after a successful append. */
  isReady(): boolean {
    return !this.logFile || this.persistenceHealthy;
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
    // Persist only the normalized envelope metadata. The raw payload can contain
    // message text and customer details and remains in the bounded in-memory buffer.
    const persisted = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'raw'));
    const line = JSON.stringify(persisted) + '\n';
    this.appendQueue = this.appendQueue
      .then(() => this.persistLine(line))
      .catch((err: unknown) => this.logAppendFailure(err));
  }

  private async persistLine(line: string): Promise<void> {
    if (!this.logFile) return;
    const lineBytes = Buffer.byteLength(line);
    let currentBytes = 0;
    try {
      const stat = await fs.lstat(this.logFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('webhook log path must be a regular file, not a symlink or device');
      }
      currentBytes = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (currentBytes > 0 && currentBytes + lineBytes > this.maxLogBytes) {
      await this.rotateLog();
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await fs.open(
      this.logFile,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('webhook log descriptor is not a regular file');
      await handle.writeFile(line, 'utf8');
      await handle.chmod(0o600);
      this.persistenceHealthy = true;
    } finally {
      await handle.close();
    }
  }

  private async rotateLog(): Promise<void> {
    if (!this.logFile) return;
    const backups = this.retainedFiles - 1;
    if (backups === 0) {
      await fs.rm(this.logFile, { force: true });
      return;
    }
    await fs.rm(`${this.logFile}.${backups}`, { force: true });
    for (let index = backups - 1; index >= 1; index -= 1) {
      await fs.rename(`${this.logFile}.${index}`, `${this.logFile}.${index + 1}`).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
    }
    await fs.rename(this.logFile, `${this.logFile}.1`).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  private logAppendFailure(err: unknown): void {
    this.persistenceHealthy = false;
    const now = Date.now();
    if (now - this.lastAppendErrorAt >= 60_000) {
      this.lastAppendErrorAt = now;
      logger.warn(
        { err, logFile: this.logFile },
        'webhook log append failed — events are NOT being persisted',
      );
    }
  }
}
