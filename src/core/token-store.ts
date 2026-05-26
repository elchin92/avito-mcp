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
 * Hook для запроса нового токена у Avito. Возвращает access_token + expiresIn (sec).
 * Реализуется в AvitoClient (чтобы не плодить циклические зависимости).
 */
export type TokenFetcher = () => Promise<{ accessToken: string; expiresIn: number }>;

/**
 * Хранит OAuth access_token между запусками в .avito-token.json + in-memory cache.
 * Защищает от parallel-refresh через одиночный Promise.
 * Атомарная запись: write tmp → rename.
 *
 * Refresh-стратегии:
 *   - upfront: getToken() возвращает текущий если он истечёт > skewMs в будущем
 *   - reactive: invalidate() стирает кэш, следующий getToken() сделает refresh
 */
export class TokenStore {
  private cache?: TokenRecord;
  private inflight?: Promise<TokenRecord>;
  private skewMs = 60_000; // обновляем за минуту до истечения

  /**
   * v0.7.0: межпроцессный lock. Default 30s timeout — если другой процесс
   * висит дольше, мы всё равно бросим понятную ошибку, а не зависнем навсегда.
   * Можно переопределить через AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS — но не в TokenStore;
   * на этом уровне просто принимаем число.
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

    // 1) попробуем подгрузить из файла
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
   * Сбрасывает кэш и удаляет файл — следующий getToken() обязательно сделает refresh.
   * Используется при 401, чтобы не подхватить заведомо отозванный токен с диска.
   * Async, чтобы удаление файла гарантированно завершилось до следующего getToken().
   */
  async invalidate(): Promise<void> {
    this.cache = undefined;
    await fs.rm(this.filePath, { force: true }).catch(() => {
      /* best-effort: ENOENT и т.п. */
    });
  }

  /**
   * Принудительный refresh. Двухслойная защита от storm'а:
   *   1) in-process: один Promise inflight на процесс
   *   2) cross-process: file lock на {filePath}.lock с PID + stale-detection
   *
   * Внутри cross-process lock сразу re-read файла: вдруг другой процесс уже
   * обновил токен пока мы ждали lock. Тогда не дёргаем /token Avito повторно.
   */
  async refresh(): Promise<TokenRecord> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        return await withFileLock(
          this.filePath,
          async () => {
            // Re-read под lock'ом — может, другой процесс уже всё сделал.
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
