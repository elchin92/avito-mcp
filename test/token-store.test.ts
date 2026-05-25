import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { TokenStore } from '../src/core/token-store.js';

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

    // дать всем трём async getToken() дойти до общего refresh()
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(resolveFetcher).not.toBeNull();
    resolveFetcher!({ accessToken: 'shared', expiresIn: 3600 });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['shared', 'shared', 'shared']);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
