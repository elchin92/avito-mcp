import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { logger } from '../logger.js';
import { withFileLock } from './file-lock.js';

export interface TokenRecord {
  accessToken: string;
  /** unix milliseconds */
  expiresAt: number;
}

/**
 * Hook for requesting a new token from Avito. Returns access_token + expiresIn (sec).
 * Implemented in AvitoClient (to avoid introducing circular dependencies).
 */
export type TokenFetcher = () => Promise<{ accessToken: string; expiresIn: number }>;

/**
 * Persists the OAuth access_token across runs in .avito-token.json + in-memory cache.
 * Guards against parallel refresh via a single shared Promise.
 * Atomic write: write tmp → rename.
 *
 * Refresh strategies:
 *   - upfront: getToken() returns the current token if it expires > skewMs in the future
 *   - reactive: invalidate() clears the cache, and the next getToken() triggers a refresh
 */
export class TokenStore {
  private cache?: TokenRecord;
  private inflight?: Promise<TokenRecord>;
  private skewMs = 60_000; // refresh one minute before expiry

  /**
   * v0.7.0: cross-process lock. Default 30s timeout — if another process
   * hangs longer, we still throw a clear error instead of blocking forever.
   * Can be overridden via AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS — but not in TokenStore;
   * at this level we simply accept a number.
   */
  constructor(
    private readonly filePath: string,
    private readonly fetcher: TokenFetcher,
    private readonly lockTimeoutMs: number = 30_000,
  ) {}

  async getToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt - Date.now() > this.skewMs) {
      return this.cache.accessToken;
    }

    // 1) try to load from file
    if (!this.cache) {
      const fromFile = await this.readFile();
      if (fromFile && fromFile.expiresAt - Date.now() > this.skewMs) {
        this.cache = fromFile;
        return fromFile.accessToken;
      }
    }

    return (await this.refresh()).accessToken;
  }

  /**
   * Clears the cache and removes the file — the next getToken() is guaranteed to refresh.
   * Used on a 401 to avoid picking up a known-revoked token from disk.
   * Async so that file removal is guaranteed to complete before the next getToken().
   */
  async invalidate(): Promise<void> {
    this.cache = undefined;
    await fs.rm(this.filePath, { force: true }).catch(() => {
      /* best-effort: ENOENT, etc. */
    });
  }

  /**
   * Forced refresh. Two-layer protection against a refresh storm:
   *   1) in-process: a single inflight Promise per process
   *   2) cross-process: a file lock on {filePath}.lock with PID + stale-detection
   *
   * Inside the cross-process lock we immediately re-read the file: another process
   * may have already refreshed the token while we waited for the lock. In that case
   * we don't call Avito's /token endpoint again.
   */
  async refresh(): Promise<TokenRecord> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        return await withFileLock(
          this.filePath,
          async () => {
            // Re-read under the lock — another process may have already done the work.
            const fromFile = await this.readFile();
            if (fromFile && fromFile.expiresAt - Date.now() > this.skewMs) {
              logger.debug(
                { filePath: this.filePath },
                'token refreshed by another process while we waited for lock',
              );
              this.cache = fromFile;
              return fromFile;
            }
            logger.info('refreshing avito access token');
            const fresh = await this.fetcher();
            const record: TokenRecord = {
              accessToken: fresh.accessToken,
              expiresAt: Date.now() + fresh.expiresIn * 1000,
            };
            this.cache = record;
            await this.writeFile(record);
            return record;
          },
          { timeoutMs: this.lockTimeoutMs },
        );
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async readFile(): Promise<TokenRecord | undefined> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as TokenRecord;
      if (typeof parsed.accessToken === 'string' && typeof parsed.expiresAt === 'number') {
        return parsed;
      }
      logger.warn({ filePath: this.filePath }, 'token file shape invalid, ignoring');
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      logger.warn({ err, filePath: this.filePath }, 'failed to read token file');
      return undefined;
    }
  }

  private async writeFile(record: TokenRecord): Promise<void> {
    try {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const tmp = join(
        dirname(this.filePath),
        `.${basename(this.filePath)}.${randomBytes(6).toString('hex')}.tmp`,
      );
      await fs.writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      logger.warn({ err, filePath: this.filePath }, 'failed to persist token to file');
    }
  }
}
