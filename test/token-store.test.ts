import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  TokenStore,
  createTokenAccountFingerprint,
  type TokenRecord,
} from '../src/core/token-store.js';

const ACCOUNT_A = { baseUrl: 'https://api.avito.ru/', clientId: 'client-a', profileId: 1 };
const ACCOUNT_B = { baseUrl: 'https://api.avito.ru', clientId: 'client-b', profileId: 2 };

describe('TokenStore', () => {
  let tokenFile: string;

  beforeEach(() => {
    tokenFile = join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`);
  });

  afterEach(async () => {
    await fs.rm(tokenFile, { force: true });
  });

  it('fetches fresh token when no cache exists', async () => {
    const fetcher = vi.fn().mockResolvedValue({ accessToken: 'tok1', expiresIn: 3600 });
    const store = new TokenStore(tokenFile, fetcher);
    expect(await store.getToken()).toBe('tok1');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('persists token to disk and reuses from in-memory cache', async () => {
    const fetcher = vi.fn().mockResolvedValue({ accessToken: 'tok2', expiresIn: 3600 });
    const store = new TokenStore(tokenFile, fetcher);
    await store.getToken();
    await store.getToken();
    await store.getToken();
    expect(fetcher).toHaveBeenCalledOnce();
    const onDisk = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.accountFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk.accessToken).toBe('tok2');
    expect(onDisk.expiresAt).toBeGreaterThan(Date.now());
  });

  it('uses on-disk token across new TokenStore instance', async () => {
    const fetcher1 = vi.fn().mockResolvedValue({ accessToken: 'tok3', expiresIn: 3600 });
    const store1 = new TokenStore(tokenFile, fetcher1);
    await store1.getToken();

    const fetcher2 = vi.fn().mockResolvedValue({ accessToken: 'unused', expiresIn: 3600 });
    const store2 = new TokenStore(tokenFile, fetcher2);
    expect(await store2.getToken()).toBe('tok3');
    expect(fetcher2).not.toHaveBeenCalled();
  });

  it('refreshes when token expired (skew window)', async () => {
    let returned = 'old';
    const fetcher = vi.fn().mockImplementation(async () => ({
      accessToken: returned,
      expiresIn: 30, // expires in 30s, within 60s skew → treated as expired
    }));
    const store = new TokenStore(tokenFile, fetcher);
    await store.getToken();
    returned = 'fresh';
    expect(await store.getToken()).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces refresh on next getToken', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'first', expiresIn: 3600 })
      .mockResolvedValueOnce({ accessToken: 'second', expiresIn: 3600 });
    const store = new TokenStore(tokenFile, fetcher);
    expect(await store.getToken()).toBe('first');
    await store.invalidate();
    expect(await store.getToken()).toBe('second');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces parallel refresh into single fetcher call', async () => {
    let resolveFetcher: ((v: { accessToken: string; expiresIn: number }) => void) | null = null;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((resolve) => {
          if (!resolveFetcher) resolveFetcher = resolve;
        }),
    );
    const store = new TokenStore(tokenFile, fetcher);
    const p1 = store.getToken();
    const p2 = store.getToken();
    const p3 = store.getToken();

    // Wait for all three async getToken() calls to reach the shared refresh().
    // Each one does an async readFile() first, then awaits refresh(); on slow CI
    // (GitHub Actions Node 20.x) two setImmediate ticks isn't enough — poll the
    // fetcher mock with a 2s deadline instead.
    const deadline = Date.now() + 2000;
    while (fetcher.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(fetcher).toHaveBeenCalledOnce();
    expect(resolveFetcher).not.toBeNull();
    resolveFetcher!({ accessToken: 'shared', expiresIn: 3600 });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['shared', 'shared', 'shared']);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not reuse a shared token file across different accounts', async () => {
    const fetcherA = vi.fn().mockResolvedValue({ accessToken: 'account-a-token', expiresIn: 3600 });
    const storeA = new TokenStore(tokenFile, fetcherA, 30_000, ACCOUNT_A);
    expect(await storeA.getToken()).toBe('account-a-token');

    const fetcherB = vi.fn().mockResolvedValue({ accessToken: 'account-b-token', expiresIn: 3600 });
    const storeB = new TokenStore(tokenFile, fetcherB, 30_000, ACCOUNT_B);
    expect(await storeB.getMetadata()).toEqual({ present: false });
    expect(await storeB.getToken()).toBe('account-b-token');
    expect(fetcherB).toHaveBeenCalledOnce();

    const onDisk = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    expect(onDisk.accountFingerprint).toBe(createTokenAccountFingerprint(ACCOUNT_B));
    expect(onDisk.accountFingerprint).not.toBe(createTokenAccountFingerprint(ACCOUNT_A));
  });

  it('serializes account-conditional invalidation with a successor refresh', async () => {
    const fetcherA = vi.fn().mockResolvedValue({ accessToken: 'account-a-token', expiresIn: 3600 });
    const storeA = new TokenStore(tokenFile, fetcherA, 5_000, ACCOUNT_A);
    await storeA.getToken();

    const actualReadFile = fs.readFile.bind(fs);
    let markInvalidateRead!: () => void;
    const invalidateRead = new Promise<void>((resolve) => {
      markInvalidateRead = resolve;
    });
    let releaseInvalidateRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseInvalidateRead = resolve;
    });
    let intercepted = false;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
      const value = await actualReadFile(path, options);
      if (!intercepted && String(path) === tokenFile) {
        intercepted = true;
        markInvalidateRead();
        await readGate;
      }
      return value;
    });

    try {
      const invalidation = storeA.invalidate();
      await invalidateRead;

      const fetcherB = vi
        .fn()
        .mockResolvedValue({ accessToken: 'account-b-successor', expiresIn: 3600 });
      const storeB = new TokenStore(tokenFile, fetcherB, 5_000, ACCOUNT_B);
      const successorRefresh = storeB.refresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetcherB).not.toHaveBeenCalled();

      releaseInvalidateRead();
      await Promise.all([invalidation, successorRefresh]);
      const onDisk = JSON.parse(await actualReadFile(tokenFile, 'utf8')) as TokenRecord;
      expect(onDisk.accountFingerprint).toBe(createTokenAccountFingerprint(ACCOUNT_B));
      expect(onDisk.accessToken).toBe('account-b-successor');
    } finally {
      releaseInvalidateRead();
      readSpy.mockRestore();
    }
  });

  it('rejects legacy unbound token records', async () => {
    await fs.writeFile(
      tokenFile,
      JSON.stringify({ accessToken: 'legacy-token', expiresAt: Date.now() + 3_600_000 }),
    );
    const fetcher = vi.fn().mockResolvedValue({ accessToken: 'bound-token', expiresIn: 3600 });
    const store = new TokenStore(tokenFile, fetcher, 30_000, ACCOUNT_A);
    expect(await store.getMetadata()).toEqual({ present: false });
    expect(await store.getToken()).toBe('bound-token');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('creates a missing parent directory before acquiring the lock', async () => {
    const root = join(tmpdir(), `avito-token-nested-${randomBytes(6).toString('hex')}`);
    tokenFile = join(root, 'deep', 'token.json');
    const fetcher = vi.fn().mockResolvedValue({ accessToken: 'nested', expiresIn: 3600 });
    const store = new TokenStore(tokenFile, fetcher, 30_000, ACCOUNT_A);
    expect(await store.getToken()).toBe('nested');
    expect(JSON.parse(await fs.readFile(tokenFile, 'utf8')).accessToken).toBe('nested');
    if (process.platform !== 'win32') {
      expect((await fs.stat(join(root, 'deep'))).mode & 0o077).toBe(0);
      expect((await fs.stat(tokenFile)).mode & 0o077).toBe(0);
    }
    expect((await fs.readdir(join(root, 'deep'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
    await fs.rm(root, { recursive: true, force: true });
  });
});
