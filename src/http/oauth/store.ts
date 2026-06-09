/**
 * v0.9.0: in-memory backing store for the self-hosted single-tenant OAuth 2.1
 * authorization+resource server (see ./provider.ts).
 *
 * Four record kinds:
 *   - registered clients   (Dynamic Client Registration, RFC 7591)
 *   - one-time auth codes   (bound to client/PKCE/redirect/scopes/resource, ~5 min TTL)
 *   - access tokens         (→ {clientId, scopes, resource, expiresAt})
 *   - refresh tokens        (→ {clientId, scopes, resource, expiresAt})
 *
 * All ids/secrets/codes come from crypto.randomBytes. Codes are single-use:
 * takeAuthCode() atomically reads-and-deletes.
 *
 * Persistence is OPTIONAL and best-effort. When `storeFile` is set we snapshot
 * the whole state to JSON (atomic tmp→rename, mode 0600) after every mutation,
 * debounced via a microtask flag, and load it once at construction. A failed
 * read/write is logged at debug and otherwise ignored — losing the file just
 * means clients must re-register and re-authenticate, which is acceptable for a
 * single-tenant deployment. Tokens are NOT a source of truth for anything money.
 */
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import { logger } from '../../logger.js';

/** A pending authorization code minted at /authorize/approve, redeemed at /token. */
export interface AuthCodeRecord {
  clientId: string;
  /** PKCE S256 challenge from the original /authorize request. */
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  /** RFC 8707 resource indicator (href), if the client sent one. */
  resource?: string;
  /** Absolute expiry, ms epoch. */
  expiresAt: number;
}

/** An access or refresh token record. */
export interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  /** Absolute expiry, ms epoch. */
  expiresAt: number;
  /**
   * On refresh-token records: the access token this refresh token was minted
   * with, so rotation can revoke the pair eagerly (the client abandons the old
   * access token on refresh — lazy expiry would never collect it).
   */
  accessToken?: string;
}

/** Shape persisted to (and loaded from) the optional JSON file. */
interface Snapshot {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
  // Auth codes are intentionally NOT persisted: they are short-lived and
  // single-use, and surviving a restart would only widen the replay window.
}

/** Authorization-code lifetime: short, per OAuth 2.1 guidance (~5 min cap). */
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export class OAuthStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();

  /** Set when a flush is already scheduled, to coalesce bursty mutations. */
  private flushScheduled = false;

  private sweepTimer?: NodeJS.Timeout;

  /**
   * @param storeFile optional JSON path for best-effort persistence across restarts.
   */
  constructor(private readonly storeFile?: string) {
    if (this.storeFile) this.loadSync();
    // Expired entries are otherwise removed only when that exact key is looked
    // up again — tokens a client walks away from would accumulate forever (in
    // memory AND in the persisted file). unref() so the timer never holds the
    // process open.
    this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000);
    this.sweepTimer.unref();
  }

  /** Stops the periodic sweep (tests / graceful shutdown). */
  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Drops every expired auth code / access token / refresh token. Returns the
   * number of entries removed. Exposed for tests; runs every minute in prod.
   */
  sweepExpired(now = Date.now()): number {
    let removed = 0;
    for (const [code, rec] of this.authCodes) {
      if (rec.expiresAt <= now) {
        this.authCodes.delete(code);
        removed += 1;
      }
    }
    for (const map of [this.accessTokens, this.refreshTokens]) {
      for (const [token, rec] of map) {
        if (rec.expiresAt <= now) {
          map.delete(token);
          removed += 1;
        }
      }
    }
    if (removed > 0) this.scheduleFlush();
    return removed;
  }

  // ─────────────────────────── id/secret generators ───────────────────────────

  /** 32-byte url-safe token/code/secret. */
  static newSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  /** 16-byte url-safe identifier (client_id). */
  static newId(): string {
    return randomBytes(16).toString('base64url');
  }

  // ───────────────────────────────── clients ─────────────────────────────────

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  putClient(client: OAuthClientInformationFull): void {
    this.clients.set(client.client_id, client);
    this.scheduleFlush();
  }

  // ─────────────────────────────── auth codes ────────────────────────────────

  /** Mints, stores and returns a fresh one-time authorization code. */
  createAuthCode(rec: Omit<AuthCodeRecord, 'expiresAt'>): string {
    const code = OAuthStore.newSecret();
    this.authCodes.set(code, { ...rec, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
    // Not persisted — see Snapshot note.
    return code;
  }

  /** Peeks at a code WITHOUT consuming it (used by challengeForAuthorizationCode). */
  peekAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.authCodes.get(code);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      this.authCodes.delete(code);
      return undefined;
    }
    return rec;
  }

  /** Atomically reads AND deletes a code, enforcing single use + expiry. */
  takeAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.authCodes.get(code);
    if (!rec) return undefined;
    this.authCodes.delete(code);
    if (rec.expiresAt <= Date.now()) return undefined;
    return rec;
  }

  // ────────────────────────────────── tokens ─────────────────────────────────

  createAccessToken(rec: TokenRecord): string {
    const token = OAuthStore.newSecret();
    this.accessTokens.set(token, rec);
    this.scheduleFlush();
    return token;
  }

  createRefreshToken(rec: TokenRecord): string {
    const token = OAuthStore.newSecret();
    this.refreshTokens.set(token, rec);
    this.scheduleFlush();
    return token;
  }

  getAccessToken(token: string): TokenRecord | undefined {
    const rec = this.accessTokens.get(token);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      this.accessTokens.delete(token);
      this.scheduleFlush();
      return undefined;
    }
    return rec;
  }

  getRefreshToken(token: string): TokenRecord | undefined {
    const rec = this.refreshTokens.get(token);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      this.refreshTokens.delete(token);
      this.scheduleFlush();
      return undefined;
    }
    return rec;
  }

  deleteAccessToken(token: string): void {
    if (this.accessTokens.delete(token)) this.scheduleFlush();
  }

  deleteRefreshToken(token: string): void {
    if (this.refreshTokens.delete(token)) this.scheduleFlush();
  }

  // ────────────────────────────── persistence ────────────────────────────────

  /** Synchronous load at construction — keeps the constructor simple/ordered. */
  private loadSync(): void {
    if (!this.storeFile) return;
    let raw: string;
    try {
      raw = readFileSync(this.storeFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug({ err, storeFile: this.storeFile }, 'oauth store: load failed, starting empty');
      }
      return;
    }
    try {
      const snap = JSON.parse(raw) as Partial<Snapshot>;
      const now = Date.now();
      for (const [id, c] of Object.entries(snap.clients ?? {})) this.clients.set(id, c);
      for (const [t, r] of Object.entries(snap.accessTokens ?? {})) {
        if (r.expiresAt > now) this.accessTokens.set(t, r);
      }
      for (const [t, r] of Object.entries(snap.refreshTokens ?? {})) {
        if (r.expiresAt > now) this.refreshTokens.set(t, r);
      }
      logger.debug(
        { storeFile: this.storeFile, clients: this.clients.size, tokens: this.accessTokens.size },
        'oauth store: loaded from file',
      );
    } catch (err) {
      logger.debug({ err, storeFile: this.storeFile }, 'oauth store: parse failed, starting empty');
    }
  }

  /** Debounce a flush onto the microtask queue so a single request flushes once. */
  private scheduleFlush(): void {
    if (!this.storeFile || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (!this.storeFile) return;
    const snap: Snapshot = {
      clients: Object.fromEntries(this.clients),
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens),
    };
    try {
      await fs.mkdir(dirname(this.storeFile), { recursive: true });
      const tmp = join(
        dirname(this.storeFile),
        `.${basename(this.storeFile)}.${randomBytes(6).toString('hex')}.tmp`,
      );
      await fs.writeFile(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.storeFile);
    } catch (err) {
      logger.debug({ err, storeFile: this.storeFile }, 'oauth store: flush failed (best-effort)');
    }
  }
}
