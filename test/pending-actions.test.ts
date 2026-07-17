import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

import { PendingActionLimitError, PendingActionStore } from '../src/core/pending-actions.js';

const tempDirs: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    join(tmpdir(), `avito-pending-${randomBytes(6).toString('hex')}-`),
  );
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const input = (name: string) => ({
  toolName: name,
  risk: 'write' as const,
  summary: name,
  args: {},
  execute: async () => ({ content: [] }),
});

describe('PendingActionStore capacity', () => {
  it('fails explicitly at the cap instead of growing without bound', () => {
    const store = new PendingActionStore(60_000, 2);
    store.create(input('one'));
    store.create(input('two'));
    expect(() => store.create(input('three'))).toThrow(PendingActionLimitError);
    expect(store.size()).toBe(2);
  });

  it('cleans expired actions before enforcing the cap', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const store = new PendingActionStore(10, 1);
      store.create(input('expired'));
      now.mockReturnValue(1_011);
      expect(() => store.create(input('replacement'))).not.toThrow();
      expect(store.list()[0]?.toolName).toBe('replacement');
    } finally {
      now.mockRestore();
    }
  });
});

describe('PendingActionStore shared confirmation lockout', () => {
  it('aggregates failures atomically across session references', () => {
    const sharedStore = new PendingActionStore(60_000);
    const action = sharedStore.create(input('protected'));
    const sessionA = sharedStore;
    const sessionB = sharedStore;

    expect(sessionA.recordFailedConfirmation(action.id, 3)).toEqual({
      found: true,
      failedAttempts: 1,
      locked: false,
    });
    expect(sessionB.recordFailedConfirmation(action.id, 3)).toEqual({
      found: true,
      failedAttempts: 2,
      locked: false,
    });
    expect(sessionA.recordFailedConfirmation(action.id, 3)).toEqual({
      found: true,
      failedAttempts: 3,
      locked: true,
    });
    expect(sessionB.get(action.id)).toBeUndefined();
    expect(sessionB.recordFailedConfirmation(action.id, 3).found).toBe(false);
  });

  it('allows only one session to atomically claim an action for execution', () => {
    const store = new PendingActionStore(60_000);
    const action = store.create(input('one-shot'));
    const sessionA = store;
    const sessionB = store;
    const claims = [sessionA.take(action.id), sessionB.take(action.id)];
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims[0]?.id).toBe(action.id);
    expect(claims[1]).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('resets failures after successful secret validation', () => {
    const store = new PendingActionStore(60_000);
    const action = store.create(input('protected'));
    store.recordFailedConfirmation(action.id, 3);
    store.resetConfirmationFailures(action.id);
    expect(store.recordFailedConfirmation(action.id, 3).failedAttempts).toBe(1);
  });

  it('shares persistent lockout failures across processes and restarts', async () => {
    const stateDir = await makeTempStateDir();
    const namespace = 'test-namespace';
    const persistent = { stateDir, namespace };
    const creator = new PendingActionStore(60_000, 1000, persistent);
    creator.registerExecutor('protected', async () => ({ content: [] }));
    const action = await creator.createPersistent(input('protected'));
    const actionFile = join(stateDir, namespace, 'pending', `${action.id}.json`);

    expect(await fs.stat(actionFile)).toBeDefined();
    expect(await creator.recordFailedConfirmationPersistent(action.id, 3)).toEqual({
      found: true,
      failedAttempts: 1,
      locked: false,
    });

    const secondProcess = new PendingActionStore(60_000, 1000, persistent);
    secondProcess.registerExecutor('protected', async () => ({ content: [] }));
    expect(await secondProcess.recordFailedConfirmationPersistent(action.id, 3)).toEqual({
      found: true,
      failedAttempts: 2,
      locked: false,
    });

    const restartedProcess = new PendingActionStore(60_000, 1000, persistent);
    restartedProcess.registerExecutor('protected', async () => ({ content: [] }));
    expect(await restartedProcess.recordFailedConfirmationPersistent(action.id, 3)).toEqual({
      found: true,
      failedAttempts: 3,
      locked: true,
    });

    await expect(fs.stat(actionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await restartedProcess.getPersistent(action.id)).toBeUndefined();
    expect(await creator.listPersistent()).not.toContainEqual(
      expect.objectContaining({ id: action.id }),
    );
    expect(await creator.isActivePersistent(action.id)).toBe(false);
    expect(await creator.getPersistent(action.id)).toBeUndefined();
    expect(await creator.takePersistent(action.id)).toBeUndefined();
  });

  it('serializes concurrent persistent failures and locks exactly once', async () => {
    const stateDir = await makeTempStateDir();
    const namespace = 'failure-race-namespace';
    const persistent = { stateDir, namespace };
    const creator = new PendingActionStore(60_000, 1000, persistent);
    const action = await creator.createPersistent(input('protected'));
    const stores = Array.from(
      { length: 3 },
      () => new PendingActionStore(60_000, 1000, persistent),
    );

    const failures = await Promise.all(
      stores.map((store) => store.recordFailedConfirmationPersistent(action.id, 3)),
    );

    expect(failures.filter((failure) => failure.locked)).toHaveLength(1);
    expect(
      failures
        .filter((failure) => failure.found)
        .map((failure) => failure.failedAttempts)
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3]);
    expect(await creator.takePersistent(action.id)).toBeUndefined();
  });

  it('serializes final lockout with a concurrent persistent claim', async () => {
    const stateDir = await makeTempStateDir();
    const namespace = 'race-namespace';
    const persistent = { stateDir, namespace };
    const creator = new PendingActionStore(60_000, 1000, persistent);
    creator.registerExecutor('protected', async () => ({ content: [] }));
    const action = await creator.createPersistent(input('protected'));

    expect(await creator.recordFailedConfirmationPersistent(action.id, 2)).toMatchObject({
      failedAttempts: 1,
      locked: false,
    });

    const failingProcess = new PendingActionStore(60_000, 1000, persistent);
    const claimingProcess = new PendingActionStore(60_000, 1000, persistent);
    claimingProcess.registerExecutor('protected', async () => ({ content: [] }));
    const [failure, claim] = await Promise.all([
      failingProcess.recordFailedConfirmationPersistent(action.id, 2),
      claimingProcess.takePersistent(action.id),
    ]);

    expect(Number(failure.locked) + Number(claim !== undefined)).toBe(1);
    expect(await claimingProcess.takePersistent(action.id)).toBeUndefined();
  });

  it('does not report cancellation after another process claimed the action', async () => {
    const stateDir = await makeTempStateDir();
    const namespace = 'cancel-after-claim-namespace';
    const persistent = { stateDir, namespace };
    const creator = new PendingActionStore(60_000, 1000, persistent);
    const action = await creator.createPersistent(input('protected'));
    const claimingProcess = new PendingActionStore(60_000, 1000, persistent);
    claimingProcess.registerExecutor('protected', async () => ({ content: [] }));

    expect(await claimingProcess.takePersistent(action.id)).toMatchObject({ id: action.id });
    expect(await creator.deletePersistent(action.id)).toBe(false);
    expect(await creator.getPersistent(action.id)).toBeUndefined();
    expect(await creator.listPersistent()).toEqual([]);
  });

  it('lets exactly one of concurrent cancellation or claim win', async () => {
    const stateDir = await makeTempStateDir();
    const namespace = 'cancel-claim-race-namespace';
    const persistent = { stateDir, namespace };
    const cancellingProcess = new PendingActionStore(60_000, 1000, persistent);
    const action = await cancellingProcess.createPersistent(input('protected'));
    const claimingProcess = new PendingActionStore(60_000, 1000, persistent);
    claimingProcess.registerExecutor('protected', async () => ({ content: [] }));

    const [cancelled, claim] = await Promise.all([
      cancellingProcess.deletePersistent(action.id),
      claimingProcess.takePersistent(action.id),
    ]);

    expect(Number(cancelled) + Number(claim !== undefined)).toBe(1);
    expect(await claimingProcess.takePersistent(action.id)).toBeUndefined();
  });

  it('lets only one process claim a persistent action', async () => {
    const stateDir = await makeTempStateDir();
    const namespace = 'claim-race-namespace';
    const persistent = { stateDir, namespace };
    const creator = new PendingActionStore(60_000, 1000, persistent);
    const action = await creator.createPersistent(input('protected'));
    const stores = Array.from(
      { length: 2 },
      () => new PendingActionStore(60_000, 1000, persistent),
    );
    for (const store of stores) {
      store.registerExecutor('protected', async () => ({ content: [] }));
    }

    const claims = await Promise.all(stores.map((store) => store.takePersistent(action.id)));

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(await creator.takePersistent(action.id)).toBeUndefined();
  });

  it('keeps a durable claimed marker until execution is completed', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const stateDir = await makeTempStateDir();
      const namespace = 'claimed-lifecycle-namespace';
      const persistent = { stateDir, namespace };
      const creator = new PendingActionStore(10, 1000, persistent);
      const action = await creator.createPersistent({
        ...input('protected'),
        idempotencyKey: 'claimed-key',
        argsHash: 'claimed-hash',
      });
      const claimingStore = new PendingActionStore(10, 1000, persistent);
      claimingStore.registerExecutor('protected', async () => ({ content: [] }));
      const observer = new PendingActionStore(10, 1000, persistent);

      expect(await claimingStore.takePersistent(action.id)).toMatchObject({ id: action.id });
      now.mockReturnValue(1_011);
      expect(await observer.isActivePersistent(action.id)).toBe(true);
      expect(await observer.getPersistent(action.id)).toBeUndefined();
      expect(await observer.listPersistent()).toEqual([]);
      expect(await observer.deletePersistent(action.id)).toBe(false);
      expect(await observer.isActivePersistent(action.id)).toBe(true);
      expect(await observer.hasClaimedPersistent('protected', 'claimed-key', 'claimed-hash')).toBe(
        true,
      );

      expect(await claimingStore.completePersistent(action.id)).toBe(true);
      expect(await observer.isActivePersistent(action.id)).toBe(false);
      expect(await observer.hasClaimedPersistent('protected', 'claimed-key', 'claimed-hash')).toBe(
        false,
      );
    } finally {
      now.mockRestore();
    }
  });

  it('durably removes expired actions and does not report them as cancelled', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const stateDir = await makeTempStateDir();
      const namespace = 'expired-namespace';
      const persistent = { stateDir, namespace };
      const creator = new PendingActionStore(10, 1000, persistent);
      const action = await creator.createPersistent(input('protected'));
      const actionFile = join(stateDir, namespace, 'pending', `${action.id}.json`);

      now.mockReturnValue(1_011);
      expect(await creator.getPersistent(action.id)).toBeUndefined();
      await expect(fs.stat(actionFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await creator.deletePersistent(action.id)).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

describe('PendingActionStore confirmation rate limit', () => {
  it('shares a sliding-window budget by principal and resets after the window', () => {
    const store = new PendingActionStore(60_000);
    for (let index = 0; index < 20; index += 1) {
      expect(store.checkConfirmationRateLimit('principal-a', 1_000 + index).allowed).toBe(true);
    }
    const limited = store.checkConfirmationRateLimit('principal-a', 1_020);
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(store.checkConfirmationRateLimit('principal-b', 1_020).allowed).toBe(true);
    expect(store.checkConfirmationRateLimit('principal-a', 61_001).allowed).toBe(true);
  });
});
