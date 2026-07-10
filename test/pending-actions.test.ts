import { describe, expect, it, vi } from 'vitest';

import { PendingActionLimitError, PendingActionStore } from '../src/core/pending-actions.js';

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
