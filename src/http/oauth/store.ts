/**
 * Bounded in-memory OAuth state with optional durable JSON persistence.
 *
 * Persistence has two important invariants:
 *   - one process owns a store file for its whole lifetime (a PID lease prevents
 *     independent snapshots from overwriting each other);
 *   - writes are serialized and close() waits until the latest mutation is on
 *     disk, using fsync + atomic rename.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { logger } from '../../logger.js';

export interface AuthCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface ConsentRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  issuedAt?: number;
  /** On a refresh record, the access token minted in the same grant. */
  accessToken?: string;
}

interface Snapshot {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const INACTIVE_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_INITIALIZATION_GRACE_MS = 30_000;
export const OAUTH_MAX_CLIENTS = 256;
const MAX_AUTH_CODES = 512;
const MAX_CONSENTS = 256;
const MAX_ACCESS_TOKENS = 1024;
const MAX_REFRESH_TOKENS = 1024;
const MAX_PERSISTED_CLIENT_BYTES = 32 * 1024;
const LEASE_OWNER_MARKER = /^(?:owner\.json|owner-[A-Za-z0-9_-]+\.json)$/;
const LEASE_TRANSITION_MARKER = /^\.transition-(\d+)-[A-Za-z0-9_-]+\.json$/;

interface LeaseIdentity {
  dev: number;
  ino: number;
  directory: boolean;
}

interface LeaseSnapshot {
  leasePath: string;
  markerPath: string;
  contents: string;
  ownerPid: number;
  ownerId: string;
  claimantPid?: number;
  identity: LeaseIdentity;
}

type LeaseTransitionReason = 'reclaim' | 'release';

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function clientIssuedAtMs(client: OAuthClientInformationFull): number {
  const issued = client.client_id_issued_at;
  return typeof issued === 'number' && Number.isFinite(issued) ? issued * 1000 : 0;
}

function validTokenRecord(value: unknown): value is TokenRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Partial<TokenRecord>;
  return (
    typeof rec.clientId === 'string' &&
    Array.isArray(rec.scopes) &&
    rec.scopes.every((scope) => typeof scope === 'string') &&
    typeof rec.expiresAt === 'number' &&
    Number.isFinite(rec.expiresAt) &&
    (rec.resource === undefined || typeof rec.resource === 'string') &&
    (rec.accessToken === undefined || typeof rec.accessToken === 'string')
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validClient(id: string, value: unknown, now: number): value is OAuthClientInformationFull {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const client = value as Partial<OAuthClientInformationFull>;
  if (
    client.client_id !== id ||
    !Array.isArray(client.redirect_uris) ||
    !client.redirect_uris.every((uri) => typeof uri === 'string')
  ) {
    return false;
  }
  const issuedAt = clientIssuedAtMs(client as OAuthClientInformationFull);
  if (issuedAt <= 0 || now - issuedAt >= CLIENT_TTL_MS) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_PERSISTED_CLIENT_BYTES;
  } catch {
    return false;
  }
}

export class OAuthStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private consents = new Map<string, ConsentRecord>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();

  private flushScheduled = false;
  private flushTail: Promise<void> = Promise.resolve();
  private dirtyVersion = 0;
  private persistedVersion = 0;
  private sweepTimer?: NodeJS.Timeout;
  private closePromise?: Promise<void>;
  private closing = false;
  private persistenceError?: unknown;
  private leasePath?: string;
  private leaseMarkerPath?: string;
  private leaseContents?: string;
  private leaseId?: string;
  private leaseIdentity?: LeaseIdentity;

  constructor(private readonly storeFile?: string) {
    if (this.storeFile) {
      mkdirSync(dirname(this.storeFile), { recursive: true, mode: 0o700 });
      this.acquireLease();
      try {
        this.loadSync();
        this.sweepExpired();
      } catch (err) {
        this.releaseLease();
        throw err;
      }
    }
    this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000);
    this.sweepTimer.unref();
  }

  isReady(): boolean {
    return (
      !this.closing &&
      this.persistenceError === undefined &&
      (!this.storeFile || this.leasePath !== undefined)
    );
  }

  /** Flushes the latest snapshot and releases the process lease. Idempotent. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.closePromise = (async () => {
      try {
        // Let a previously queued microtask append its write first, then enqueue
        // one final snapshot. enqueueFlush recovers from an earlier failed write.
        await Promise.resolve();
        while (this.storeFile && this.persistedVersion < this.dirtyVersion) {
          await this.enqueueFlush(false);
        }
        await this.flushTail;
      } finally {
        this.releaseLease();
      }
    })();
    return this.closePromise;
  }

  /** Synchronous cleanup for failures while the OAuth router is still being constructed. */
  abortStartup(): void {
    this.closing = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.releaseLease();
  }

  sweepExpired(now = Date.now()): number {
    let removed = 0;
    for (const [code, rec] of this.authCodes) {
      if (rec.expiresAt <= now) {
        this.authCodes.delete(code);
        removed += 1;
      }
    }
    for (const [token, rec] of this.consents) {
      if (rec.expiresAt <= now) {
        this.consents.delete(token);
        removed += 1;
      }
    }
    let persistentRemoved = false;
    for (const [clientId, client] of this.clients) {
      const issuedAt = clientIssuedAtMs(client);
      const inactiveExpired =
        issuedAt > 0 &&
        now - issuedAt >= INACTIVE_CLIENT_TTL_MS &&
        !this.hasActiveArtifacts(clientId, now);
      if (issuedAt <= 0 || now - issuedAt >= CLIENT_TTL_MS || inactiveExpired) {
        this.clients.delete(clientId);
        this.removeTokensForClient(clientId);
        persistentRemoved = true;
        removed += 1;
      }
    }
    for (const map of [this.accessTokens, this.refreshTokens]) {
      for (const [token, rec] of map) {
        if (rec.expiresAt <= now) {
          map.delete(token);
          persistentRemoved = true;
          removed += 1;
        }
      }
    }
    if (persistentRemoved) this.scheduleFlush();
    return removed;
  }

  static newSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  static newId(): string {
    return randomBytes(16).toString('base64url');
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    const issuedAt = clientIssuedAtMs(client);
    const now = Date.now();
    if (
      issuedAt <= 0 ||
      now - issuedAt >= CLIENT_TTL_MS ||
      (now - issuedAt >= INACTIVE_CLIENT_TTL_MS && !this.hasActiveArtifacts(clientId, now))
    ) {
      this.clients.delete(clientId);
      this.removeTokensForClient(clientId);
      this.scheduleFlush();
      return undefined;
    }
    return client;
  }

  hasClientCapacity(): boolean {
    this.sweepExpired();
    return (
      this.clients.size < OAUTH_MAX_CLIENTS ||
      this.findOldestInactiveClient(Date.now()) !== undefined
    );
  }

  putClient(client: OAuthClientInformationFull): void {
    this.assertMutable();
    if (!this.clients.has(client.client_id) && this.clients.size >= OAUTH_MAX_CLIENTS) {
      const evictable = this.findOldestInactiveClient(Date.now());
      if (!evictable) throw new Error(`OAuth client capacity (${OAUTH_MAX_CLIENTS}) reached`);
      this.clients.delete(evictable);
      this.removeTokensForClient(evictable);
    }
    this.clients.set(client.client_id, structuredClone(client));
    this.scheduleFlush();
  }

  createConsent(rec: Omit<ConsentRecord, 'expiresAt'>): string {
    this.assertMutable();
    this.evictOldest(this.consents, MAX_CONSENTS);
    const token = OAuthStore.newSecret();
    this.consents.set(token, { ...rec, expiresAt: Date.now() + CONSENT_TTL_MS });
    return token;
  }

  peekConsent(token: string): ConsentRecord | undefined {
    return this.getUnexpired(this.consents, token);
  }

  takeConsent(token: string): ConsentRecord | undefined {
    const rec = this.consents.get(token);
    if (!rec) return undefined;
    this.consents.delete(token);
    return rec.expiresAt > Date.now() ? rec : undefined;
  }

  createAuthCode(rec: Omit<AuthCodeRecord, 'expiresAt'>): string {
    this.assertMutable();
    this.evictOldest(this.authCodes, MAX_AUTH_CODES);
    const code = OAuthStore.newSecret();
    this.authCodes.set(code, { ...rec, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
    return code;
  }

  peekAuthCode(code: string): AuthCodeRecord | undefined {
    return this.getUnexpired(this.authCodes, code);
  }

  takeAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.authCodes.get(code);
    if (!rec) return undefined;
    this.authCodes.delete(code);
    return rec.expiresAt > Date.now() ? rec : undefined;
  }

  createAccessToken(rec: TokenRecord): string {
    this.assertMutable();
    this.evictOldest(this.accessTokens, MAX_ACCESS_TOKENS);
    const token = OAuthStore.newSecret();
    this.accessTokens.set(token, { ...rec, issuedAt: rec.issuedAt ?? Date.now() });
    this.scheduleFlush();
    return token;
  }

  createRefreshToken(rec: TokenRecord): string {
    this.assertMutable();
    this.evictOldest(this.refreshTokens, MAX_REFRESH_TOKENS);
    const token = OAuthStore.newSecret();
    this.refreshTokens.set(token, { ...rec, issuedAt: rec.issuedAt ?? Date.now() });
    this.scheduleFlush();
    return token;
  }

  getAccessToken(token: string): TokenRecord | undefined {
    return this.getPersistentToken(this.accessTokens, token);
  }

  getRefreshToken(token: string): TokenRecord | undefined {
    return this.getPersistentToken(this.refreshTokens, token);
  }

  deleteAccessToken(token: string): void {
    this.assertMutable();
    if (this.accessTokens.delete(token)) this.scheduleFlush();
  }

  deleteRefreshToken(token: string): void {
    this.assertMutable();
    if (this.refreshTokens.delete(token)) this.scheduleFlush();
  }

  /** Revokes a token and every token from the same issued pair, for its owner only. */
  revokeTokenFamily(clientId: string, token: string): boolean {
    this.assertMutable();
    const refresh = this.refreshTokens.get(token);
    if (refresh) {
      if (refresh.clientId !== clientId) return false;
      this.refreshTokens.delete(token);
      if (refresh.accessToken) {
        const access = this.accessTokens.get(refresh.accessToken);
        if (access?.clientId === clientId) this.accessTokens.delete(refresh.accessToken);
      }
      this.scheduleFlush();
      return true;
    }

    const access = this.accessTokens.get(token);
    if (!access || access.clientId !== clientId) return false;
    this.accessTokens.delete(token);
    for (const [refreshToken, rec] of this.refreshTokens) {
      if (rec.clientId === clientId && rec.accessToken === token) {
        this.refreshTokens.delete(refreshToken);
      }
    }
    this.scheduleFlush();
    return true;
  }

  private assertMutable(): void {
    if (this.closing) throw new Error('OAuth store is closing');
  }

  private getUnexpired<T extends { expiresAt: number }>(
    map: Map<string, T>,
    key: string,
  ): T | undefined {
    const rec = map.get(key);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return rec;
  }

  private getPersistentToken(
    map: Map<string, TokenRecord>,
    token: string,
  ): TokenRecord | undefined {
    const rec = map.get(token);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      map.delete(token);
      this.scheduleFlush();
      return undefined;
    }
    return rec;
  }

  private evictOldest<T extends { expiresAt: number }>(map: Map<string, T>, limit: number): void {
    while (map.size >= limit) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, rec] of map) {
        if (rec.expiresAt < oldest) {
          oldest = rec.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  private removeTokensForClient(clientId: string): void {
    for (const [token, rec] of this.accessTokens) {
      if (rec.clientId === clientId) this.accessTokens.delete(token);
    }
    for (const [token, rec] of this.refreshTokens) {
      if (rec.clientId === clientId) this.refreshTokens.delete(token);
    }
  }

  private hasActiveArtifacts(clientId: string, now: number): boolean {
    for (const rec of this.consents.values()) {
      if (rec.clientId === clientId && rec.expiresAt > now) return true;
    }
    for (const rec of this.authCodes.values()) {
      if (rec.clientId === clientId && rec.expiresAt > now) return true;
    }
    for (const rec of this.accessTokens.values()) {
      if (rec.clientId === clientId && rec.expiresAt > now) return true;
    }
    for (const rec of this.refreshTokens.values()) {
      if (rec.clientId === clientId && rec.expiresAt > now) return true;
    }
    return false;
  }

  private findOldestInactiveClient(now: number): string | undefined {
    let oldestId: string | undefined;
    let oldestIssuedAt = Number.POSITIVE_INFINITY;
    for (const [clientId, client] of this.clients) {
      if (this.hasActiveArtifacts(clientId, now)) continue;
      const issuedAt = clientIssuedAtMs(client);
      if (issuedAt < oldestIssuedAt) {
        oldestId = clientId;
        oldestIssuedAt = issuedAt;
      }
    }
    return oldestId;
  }

  private loadSync(): void {
    if (!this.storeFile) return;
    let raw: string;
    try {
      raw = readFileSync(this.storeFile, 'utf8');
      chmodSync(this.storeFile, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Unable to read OAuth store ${this.storeFile}`, { cause: err });
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!plainRecord(parsed)) throw new Error('snapshot root must be an object');
      for (const key of ['clients', 'accessTokens', 'refreshTokens'] as const) {
        if (parsed[key] !== undefined && !plainRecord(parsed[key])) {
          throw new Error(`${key} must be an object`);
        }
      }
      const snap = parsed as Partial<Snapshot>;
      const now = Date.now();
      const clients = Object.entries(snap.clients ?? {})
        .filter(([id, client]) => validClient(id, client, now))
        .sort(([, a], [, b]) => clientIssuedAtMs(a) - clientIssuedAtMs(b))
        .slice(-OAUTH_MAX_CLIENTS);
      for (const [id, client] of clients) this.clients.set(id, client);
      for (const [token, rec] of Object.entries(snap.accessTokens ?? {}).slice(
        -MAX_ACCESS_TOKENS,
      )) {
        if (validTokenRecord(rec) && rec.expiresAt > now && this.clients.has(rec.clientId)) {
          this.accessTokens.set(token, rec);
        }
      }
      for (const [token, rec] of Object.entries(snap.refreshTokens ?? {}).slice(
        -MAX_REFRESH_TOKENS,
      )) {
        if (validTokenRecord(rec) && rec.expiresAt > now && this.clients.has(rec.clientId)) {
          this.refreshTokens.set(token, rec);
        }
      }
      logger.debug(
        {
          storeFile: this.storeFile,
          clients: this.clients.size,
          accessTokens: this.accessTokens.size,
          refreshTokens: this.refreshTokens.size,
        },
        'oauth store: loaded from file',
      );
    } catch (err) {
      throw new Error(`Unable to parse OAuth store ${this.storeFile}`, { cause: err });
    }
  }

  private scheduleFlush(): void {
    this.dirtyVersion += 1;
    if (!this.storeFile || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.closing) return;
      void this.enqueueFlush(true);
    });
  }

  /** Appends exactly one writer to the serialized chain. */
  private enqueueFlush(logFailure: boolean): Promise<void> {
    if (!this.storeFile) return this.flushTail;
    const requestedVersion = this.dirtyVersion;
    const operation = this.flushTail
      .catch(() => undefined)
      .then(async () => {
        if (this.persistedVersion >= requestedVersion) return;
        const snapshotVersion = this.dirtyVersion;
        await this.writeSnapshot();
        this.persistedVersion = Math.max(this.persistedVersion, snapshotVersion);
        this.persistenceError = undefined;
      })
      .catch((err: unknown) => {
        this.persistenceError = err;
        throw err;
      });
    this.flushTail = operation;
    if (logFailure) {
      void operation.catch((err: unknown) => {
        logger.error({ err, storeFile: this.storeFile }, 'oauth store: durable flush failed');
      });
    }
    return operation;
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.storeFile) return;
    const snapshot: Snapshot = {
      version: 1,
      clients: Object.fromEntries(this.clients),
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens),
    };
    const directory = dirname(this.storeFile);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const tmp = join(
      directory,
      `.${basename(this.storeFile)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tmp, this.storeFile);
      // Persist the rename itself on filesystems that support directory fsync.
      try {
        const dirHandle = await fs.open(directory, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw err;
      }
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private acquireLease(): void {
    if (!this.storeFile) return;
    const leasePath = `${this.storeFile}.process.lock`;
    const leaseId = OAuthStore.newId();
    const leaseContents = JSON.stringify({ pid: process.pid, id: leaseId });
    const markerPath = join(leasePath, `owner-${leaseId}.json`);
    // Reclaims and lost publication races do not adjudicate anything, so they must not
    // consume the budget meant for EEXIST decisions, or a successful reclaim would end
    // in a generic 'Unable to acquire'.
    for (let adjudications = 0, guard = 0; adjudications < 2 && guard < 8; guard += 1) {
      try {
        // mkdir owns the path; the generation-specific marker is the atomic
        // transition baton used by both stale cleanup and normal release.
        mkdirSync(leasePath, { mode: 0o700 });
        writeFileSync(markerPath, leaseContents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        // Ownership proved by content, not by inode: a reclaim can remove this directory
        // between the mkdir and this write, and ext4 hands the freed inode to whoever
        // recreates the path, so identityOf() cannot tell our generation from theirs.
        // A directory holding anything but our marker is not ours.
        this.beforeLeaseOwnershipCheck(leasePath);
        if (!this.soleLeaseMarker(leasePath, `owner-${leaseId}.json`)) {
          // Our marker may be sitting inside a generation we do not own. Its name carries
          // our id, so removing it can never disturb a competitor; removing the directory
          // would destroy a live lease.
          rmSync(markerPath, { force: true });
          try {
            rmdirSync(leasePath); // ENOTEMPTY unless nobody published at all
          } catch {
            // A competitor's marker is there, which is exactly what we want to leave alone.
          }
          continue;
        }
        const stat = lstatSync(leasePath);
        this.leasePath = leasePath;
        this.leaseMarkerPath = markerPath;
        this.leaseContents = leaseContents;
        this.leaseId = leaseId;
        this.leaseIdentity = this.identityOf(stat);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Our directory was reclaimed underneath us before the marker landed. That is
        // ordinary contention, not a failure to report to the caller.
        if (code === 'ENOENT') continue;
        if (code !== 'EEXIST') throw err;
        // A lease that cannot name an owner is unreachable for inspectLease(), which
        // refuses it and leaves the server unable to start until someone deletes the
        // directory by hand. Reclaiming it first turns that into a self-healing start.
        if (this.reclaimAbandonedLease(leasePath)) continue;
        let snapshot: LeaseSnapshot;
        try {
          snapshot = this.inspectLease(leasePath);
        } catch (inspectErr) {
          if ((inspectErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw inspectErr;
        }
        if (processIsAlive(snapshot.ownerPid)) {
          throw new Error(
            `OAuth store ${this.storeFile} is already owned by active process ${snapshot.ownerPid}; ` +
              'use a distinct AVITO_MCP_OAUTH_STORE_FILE per server instance',
            { cause: err },
          );
        }
        if (snapshot.claimantPid && processIsAlive(snapshot.claimantPid)) {
          throw new Error(`OAuth store ${this.storeFile} lease transition is already active`, {
            cause: err,
          });
        }
        if (!snapshot.identity.directory) {
          throw new Error(
            `OAuth store ${this.storeFile} has a stale legacy lease; remove it manually`,
            { cause: err },
          );
        }
        adjudications += 1;
        this.transitionLease(snapshot, 'reclaim');
      }
    }
    throw new Error(`Unable to acquire OAuth store lease for ${this.storeFile}`);
  }

  /** The lease directory holds exactly our marker and nothing else recognized. */
  private soleLeaseMarker(leasePath: string, markerName: string): boolean {
    try {
      const recognized = readdirSync(leasePath).filter(
        (name) => LEASE_OWNER_MARKER.test(name) || LEASE_TRANSITION_MARKER.test(name),
      );
      return recognized.length === 1 && recognized[0] === markerName;
    } catch {
      return false;
    }
  }

  /**
   * Reclaims a lease directory whose shape cannot name an owner — the mirror of
   * removeIfAbandoned() in src/core/file-lock.ts, and reachable the same way: mkdirSync
   * publishes the directory and the owner marker lands in it a moment later, so a
   * process killed inside that window leaves a directory with nothing to identify.
   *
   * inspectLease() cannot adjudicate that shape and throws, and acquireLease() only
   * resumes on ENOENT, so what should be a transient leftover instead keeps the HTTP
   * transport from starting at all until an operator removes the directory.
   *
   * The gates are the same two that make this safe there: no marker may name a live
   * process, and nothing here may have been touched within the initialization grace,
   * which a healthy owner never satisfies because its marker write lands microseconds
   * after the mkdir and bumps the directory mtime with it.
   */
  private reclaimAbandonedLease(leasePath: string): boolean {
    let stat: Stats;
    let entries: string[];
    try {
      stat = lstatSync(leasePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      entries = readdirSync(leasePath);
    } catch {
      return false;
    }

    // Exactly one marker that names an owner is the healthy shape; inspectLease() decides
    // that one by pid. A marker that cannot be parsed names nobody and is therefore just
    // as unadjudicable as no marker at all — and it is the likeliest residue of all, since
    // writeFileSync creates the marker before it writes it, so a process killed inside
    // that call leaves a zero-byte one behind. Without this it would keep the transport
    // down permanently, which is the exact failure this reclaim exists to end.
    const recognized = entries.filter(
      (name) => LEASE_OWNER_MARKER.test(name) || LEASE_TRANSITION_MARKER.test(name),
    );
    if (recognized.length === 1 && this.leaseMarkerNamesAnOwner(leasePath, recognized[0]!)) {
      return false;
    }

    let newestMtimeMs = stat.mtimeMs;
    for (const name of entries) {
      let entryStat: Stats;
      try {
        entryStat = lstatSync(join(leasePath, name));
      } catch {
        // The entry vanished mid-scan, so someone is actively working in here.
        return false;
      }
      newestMtimeMs = Math.max(newestMtimeMs, entryStat.mtimeMs);
      const pid = this.leaseEntryOwnerPid(leasePath, name, entryStat);
      if (pid !== undefined && processIsAlive(pid)) return false;
    }
    if (Date.now() - newestMtimeMs <= LEASE_INITIALIZATION_GRACE_MS) return false;

    // Everything above read a directory another process may be replacing. A lease
    // published in the meantime carries a fresh mtime, so requiring it unchanged keeps
    // the reclaim off a successor that took the path while we were looking.
    try {
      const current = lstatSync(leasePath);
      if (
        !current.isDirectory() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.mtimeMs !== stat.mtimeMs
      ) {
        return false;
      }
    } catch {
      return false;
    }

    try {
      if (entries.length === 0) {
        // rmdir refuses with ENOTEMPTY the instant a marker appears, so a generation that
        // published while we looked survives even if it reused this very inode.
        rmdirSync(leasePath);
      } else {
        const movedPath = `${leasePath}.transitioned-${OAuthStore.newId()}`;
        renameSync(leasePath, movedPath);
        try {
          rmSync(movedPath, { recursive: true, force: true });
        } catch {
          // The lease path is free the moment the rename lands. A failed delete leaves
          // litter, not a blocked lease, so it must not turn the reclaim into a failure.
        }
      }
    } catch {
      return false;
    }
    logger.warn(
      { lease: basename(leasePath), ageMs: Math.round(Date.now() - newestMtimeMs) },
      'oauth store: reclaimed an abandoned lease',
    );
    return true;
  }

  /** True when this marker identifies an owner, so inspectLease() can adjudicate it by pid. */
  private leaseMarkerNamesAnOwner(leasePath: string, name: string): boolean {
    // A transition marker carries its claimant pid in the filename, so it always names one.
    if (LEASE_TRANSITION_MARKER.test(name)) return true;
    try {
      this.parseLeaseOwner(readFileSync(join(leasePath, name), 'utf8'));
      return true;
    } catch {
      return false;
    }
  }

  /** The process an entry claims, when it can be read; undefined leaves the age gate in charge. */
  private leaseEntryOwnerPid(
    leasePath: string,
    name: string,
    entryStat: Stats,
  ): number | undefined {
    const transition = LEASE_TRANSITION_MARKER.exec(name);
    if (transition) return Number(transition[1]);
    if (!LEASE_OWNER_MARKER.test(name) || !entryStat.isFile() || entryStat.isSymbolicLink()) {
      return undefined;
    }
    try {
      return this.parseLeaseOwner(readFileSync(join(leasePath, name), 'utf8')).pid;
    } catch {
      return undefined;
    }
  }

  private inspectLease(leasePath: string): LeaseSnapshot {
    const stat = lstatSync(leasePath);
    const identity = this.identityOf(stat);
    if (!identity.directory) {
      const contents = readFileSync(leasePath, 'utf8');
      const owner = this.parseLeaseOwner(contents);
      return {
        leasePath,
        markerPath: leasePath,
        contents,
        ownerPid: owner.pid,
        ownerId: owner.id,
        identity,
      };
    }

    const markerNames = readdirSync(leasePath).filter(
      (name) => LEASE_OWNER_MARKER.test(name) || LEASE_TRANSITION_MARKER.test(name),
    );
    if (markerNames.length !== 1) {
      if (Date.now() - stat.mtimeMs < LEASE_INITIALIZATION_GRACE_MS) {
        throw new Error(`OAuth store ${this.storeFile} lease is being initialized`);
      }
      throw new Error(
        `OAuth store ${this.storeFile} lease owner marker is missing or ambiguous; ` +
          'remove the stale lease manually',
      );
    }

    const markerName = markerNames[0]!;
    const markerPath = join(leasePath, markerName);
    let contents: string;
    let owner: { pid: number; id: string };
    try {
      contents = readFileSync(markerPath, 'utf8');
      owner = this.parseLeaseOwner(contents);
    } catch (err) {
      if (Date.now() - stat.mtimeMs < LEASE_INITIALIZATION_GRACE_MS) {
        throw new Error(`OAuth store ${this.storeFile} lease is being initialized`, {
          cause: err,
        });
      }
      throw new Error(
        `OAuth store ${this.storeFile} lease owner marker is unreadable; ` +
          'remove the stale lease manually',
        { cause: err },
      );
    }

    const transition = LEASE_TRANSITION_MARKER.exec(markerName);
    if (!transition && markerName !== 'owner.json' && markerName !== `owner-${owner.id}.json`) {
      throw new Error(
        `OAuth store ${this.storeFile} lease owner generation does not match its marker`,
      );
    }
    return {
      leasePath,
      markerPath,
      contents,
      ownerPid: owner.pid,
      ownerId: owner.id,
      claimantPid: transition ? Number(transition[1]) : undefined,
      identity,
    };
  }

  private parseLeaseOwner(contents: string): { pid: number; id: string } {
    const value = JSON.parse(contents) as { pid?: unknown; id?: unknown };
    if (
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.id !== 'string' ||
      !value.id
    ) {
      throw new Error('Invalid OAuth lease owner marker');
    }
    return { pid: value.pid, id: value.id };
  }

  private identityOf(stat: Stats): LeaseIdentity {
    return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
  }

  private sameIdentity(left: LeaseIdentity, right: LeaseIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.directory === right.directory;
  }

  private leaseMatches(snapshot: LeaseSnapshot, leasePath: string, markerPath: string): boolean {
    try {
      const current = this.identityOf(lstatSync(leasePath));
      return (
        this.sameIdentity(snapshot.identity, current) &&
        readFileSync(markerPath, 'utf8') === snapshot.contents
      );
    } catch {
      return false;
    }
  }

  private transitionLease(snapshot: LeaseSnapshot, reason: LeaseTransitionReason): boolean {
    if (!this.leaseMatches(snapshot, snapshot.leasePath, snapshot.markerPath)) return false;
    this.beforeLeaseTransition(reason, snapshot.leasePath);

    const claimId = OAuthStore.newId();
    const claimedMarkerPath = join(
      snapshot.leasePath,
      `.transition-${process.pid}-${claimId}.json`,
    );
    try {
      renameSync(snapshot.markerPath, claimedMarkerPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    if (!this.leaseMatches(snapshot, snapshot.leasePath, claimedMarkerPath)) return false;

    const transitionedPath = `${snapshot.leasePath}.transitioned-${claimId}`;
    renameSync(snapshot.leasePath, transitionedPath);
    const transitionedMarkerPath = join(transitionedPath, basename(claimedMarkerPath));
    if (!this.leaseMatches(snapshot, transitionedPath, transitionedMarkerPath)) {
      throw new Error(`OAuth store ${this.storeFile} lease identity changed during transition`);
    }
    rmSync(transitionedPath, { recursive: true, force: true });
    return true;
  }

  private beforeLeaseTransition(_reason: LeaseTransitionReason, _leasePath: string): void {
    // Tests override this no-op to deterministically exercise generation replacement races.
  }

  private beforeLeaseOwnershipCheck(_leasePath: string): void {
    // Tests override this no-op to publish a competing marker in the window between our
    // marker write and the ownership check that has to notice it.
  }

  private releaseLease(): void {
    if (
      !this.leasePath ||
      !this.leaseMarkerPath ||
      !this.leaseContents ||
      !this.leaseId ||
      !this.leaseIdentity
    ) {
      return;
    }
    try {
      this.transitionLease(
        {
          leasePath: this.leasePath,
          markerPath: this.leaseMarkerPath,
          contents: this.leaseContents,
          ownerPid: process.pid,
          ownerId: this.leaseId,
          identity: this.leaseIdentity,
        },
        'release',
      );
    } catch {
      // A missing or replaced lease is harmless during shutdown.
    } finally {
      this.leasePath = undefined;
      this.leaseMarkerPath = undefined;
      this.leaseContents = undefined;
      this.leaseId = undefined;
      this.leaseIdentity = undefined;
    }
  }
}
