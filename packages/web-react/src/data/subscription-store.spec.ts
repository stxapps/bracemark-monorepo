// Specs for the device-local last-known subscription copy. Everything here is about the
// SAME failure: this cache seeds react-query's placeholderData at first render, so
// whatever it hands back is what gates the paywall before the network answers — and its
// three degradation paths (no storage, corrupt value, wrong shape) all have to end at
// `null`, which reads as "free", rather than at a throw during the first render or a
// malformed plan string reaching `entitlementsOf`.
//
// The wrong-shape case is the one worth a real assertion: `subscriptionStatusSchema` is
// what stands between a stale/hand-edited localStorage value and the entitlement fold,
// and a `JSON.parse` that skipped it would look identical for every valid input.
//
// Storage is stubbed rather than jsdom-provided: this package's jest environment is
// 'node' (jest.config.cts), and the ABSENT-storage branch is a real production path
// (private mode, SSR) that no test could reach if a DOM were always present.

import type { SubscriptionStatus } from '@stxapps/shared';

import {
  clearCachedSubscriptionStatus,
  readCachedStatus,
  writeCachedStatus,
} from './subscription-store';

// A minimal in-memory Storage, installed per test so the no-storage branch stays
// reachable by simply not installing it.
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

function removeStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
}

const PAID: SubscriptionStatus = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  expiresAt: 1_700_000_000_000,
  willRenew: true,
};

afterEach(() => {
  removeStorage();
});

describe('readCachedStatus', () => {
  it('is null when this device has cached nothing', () => {
    installStorage();

    expect(readCachedStatus()).toBeNull();
  });

  // Private mode / SSR: no storage object at all. The optional-chained read must degrade,
  // not throw — a throw here happens during the first render of a signed-in app.
  it('is null when there is no storage at all, rather than throwing', () => {
    removeStorage();

    expect(readCachedStatus()).toBeNull();
  });

  it('round-trips a written status', () => {
    installStorage();
    writeCachedStatus(PAID);

    expect(readCachedStatus()).toEqual(PAID);
  });

  it('is null for a value that is not JSON', () => {
    installStorage({ 'bracemark.subscriptionStatus': '{not json' });

    expect(readCachedStatus()).toBeNull();
  });

  // THE ONE THAT MATTERS: the wire schema, not just JSON.parse, is what a stale or
  // hand-edited value has to satisfy. Without it an arbitrary `plan` string reaches
  // entitlementsOf, which is the fold every client-side gate is derived from.
  it('rejects a shape the wire schema does not accept', () => {
    installStorage({
      'bracemark.subscriptionStatus': JSON.stringify({ plan: 'unlimited-everything' }),
    });

    expect(readCachedStatus()).toBeNull();
  });
});

describe('writeCachedStatus', () => {
  // The in-memory query cache still serves this session — a failed persist is a missing
  // optimization, never an error the user sees.
  it('is a no-op when storage is unavailable', () => {
    removeStorage();

    expect(() => writeCachedStatus(PAID)).not.toThrow();
  });

  it('is a no-op when storage throws (quota, private mode)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
        removeItem: () => undefined,
      },
    });

    expect(() => writeCachedStatus(PAID)).not.toThrow();
  });
});

describe('clearCachedSubscriptionStatus', () => {
  // Called from the sign-out teardown: the next account on this device must not inherit
  // the previous one's plan — an unlocked paywall for someone who never paid.
  it('drops the cached copy so the next account cannot inherit it', () => {
    installStorage();
    writeCachedStatus(PAID);

    clearCachedSubscriptionStatus();

    expect(readCachedStatus()).toBeNull();
  });

  it('is a no-op when storage is unavailable', () => {
    removeStorage();

    expect(() => clearCachedSubscriptionStatus()).not.toThrow();
  });
});
