import { constants, promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { logger } from '../logger.js';
import { withFileLock } from './file-lock.js';
import { syncDirectory } from './runtime-state.js';

export interface TokenRecord {
  version: 1;
  /** SHA-256 of the normalized API origin + client id + profile id. */
  accountFingerprint: string;
  accessToken: string;
  /** unix milliseconds */
  expiresAt: number;
}

/**
 * Hook for requesting a new token from Avito. Returns access_token + expiresIn (sec).
 * Implemented in AvitoClient (to avoid introducing circular dependencies).
 */
export type TokenFetcher = () => Promise<{ accessToken: string; expiresIn: number }>;

export interface TokenAccountBinding {
  baseUrl: string;
  clientId: string;
  profileId?: number;
}

export interface TokenMetadata {
  present: boolean;
  expiresAt?: number;
}

/** Does not persist account identifiers in plaintext next to the bearer token. */
export function createTokenAccountFingerprint(binding: TokenAccountBinding): string {
  let apiOrigin: string;
  try {
    apiOrigin = new URL(binding.baseUrl).origin.toLowerCase();
  } catch {
    apiOrigin = binding.baseUrl.replace(/\/+$/, '').toLowerCase();
  }
  return createHash('sha256')
    .update(JSON.stringify([apiOrigin, binding.clientId, binding.profileId ?? null]))
    .digest('hex');
}

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
    binding: TokenAccountBinding = {
      baseUrl: 'unbound://local',
      clientId: '',
      profileId: undefined,
    },
  ) {
    this.accountFingerprint = createTokenAccountFingerprint(binding);
  }

  private readonly accountFingerprint: string;

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

  /** Returns account-bound cache metadata without exposing the bearer token. */
  async getMetadata(): Promise<TokenMetadata> {
    const record = this.cache ?? (await this.readFile());
    return record ? { present: true, expiresAt: record.expiresAt } : { present: false };
  }

  /** Minimal readiness check: the token state directory exists and is writable. */
  async isStorageReady(): Promise<boolean> {
    const directory = dirname(this.filePath);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory()) return false;
      await fs.access(directory, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clears the cache and removes the file — the next getToken() is guaranteed to refresh.
   * Used on a 401 to avoid picking up a known-revoked token from disk.
   * Async so that file removal is guaranteed to complete before the next getToken().
   */
  async invalidate(): Promise<void> {
    this.cache = undefined;
    try {
      await withFileLock(
        this.filePath,
        async () => {
          try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<TokenRecord>;
            // Read + conditional delete share the same lease as refresh/write, so
            // another account cannot replace the file between these operations.
            if (parsed.accountFingerprint === this.accountFingerprint) {
              await fs.rm(this.filePath, { force: true });
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        },
        { timeoutMs: this.lockTimeoutMs },
      );
    } catch (err) {
      logger.warn({ err, filePath: this.filePath }, 'failed to invalidate token file');
      // Retrying with a cache file we failed to invalidate would resend a token
      // already rejected with 401. Fail this request and let a later call retry
      // after the lease/storage problem clears.
      throw err;
    }
  }

  /**
   * Forced refresh. Two-layer protection against a refresh storm:
   *   1) in-process: a single inflight Promise per process
   *   2) cross-process: a directory lease on {filePath}.lock with PID + stale-detection
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
              version: 1,
              accountFingerprint: this.accountFingerprint,
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
      const parsed = JSON.parse(raw) as Partial<TokenRecord>;
      if (
        parsed.version === 1 &&
        parsed.accountFingerprint === this.accountFingerprint &&
        typeof parsed.accessToken === 'string' &&
        typeof parsed.expiresAt === 'number'
      ) {
        return {
          version: 1,
          accountFingerprint: parsed.accountFingerprint,
          accessToken: parsed.accessToken,
          expiresAt: parsed.expiresAt,
        };
      }
      logger.warn(
        { filePath: this.filePath },
        'token file is legacy, invalid, or belongs to another account; ignoring',
      );
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      logger.warn({ err, filePath: this.filePath }, 'failed to read token file');
      return undefined;
    }
  }

  private async writeFile(record: TokenRecord): Promise<void> {
    const directory = dirname(this.filePath);
    const tmp = join(
      directory,
      `.${basename(this.filePath)}.${randomBytes(12).toString('hex')}.tmp`,
    );
    let handle: import('node:fs/promises').FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // wx prevents following or truncating a pre-planted temp path. Sync the
      // complete 0600 file before the atomic rename, then sync the directory so
      // the new name itself survives a power loss on supporting filesystems.
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record, null, 2), 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tmp, this.filePath);
      await syncDirectory(directory);
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      logger.warn({ err, filePath: this.filePath }, 'failed to persist token to file');
    }
  }
}
