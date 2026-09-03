/**
 * @jest-environment jsdom
 */
// Specs for the entitlement read — the hook that wraps the `GET /v1/iap/status` query with
// the device-local last-known copy so a cold or offline start keeps the account's plan
// instead of flashing free and re-locking the user's features until the network answers.
//
// The load-bearing rule is the `isPlaceholderData` guard on the persist effect. It is
// counter-intuitive and completely silent: react-query reports `status: 'success'` the
// WHOLE time it is serving placeholderData, so `isSuccess` alone does not mean "fresh".
// Usually writing the placeholder back would be a harmless rewrite of what was just read —
// but the placeholder can be ANOTHER ACCOUNT's cached answer (the query keys are
// constants, not per-user; the sign-out `queryClient.clear()` closes that from the other
// side), and persisting it pins the previous account's plan into the new account's device
// cache. Nothing errors; a user simply has features they never paid for, or loses ones
// they did.
//
// The other two rules are about not flashing:
//   - `isLoading` is true ONLY on a cold start with nothing cached, so a device with a
//     cached plan never shows a paywall while the first answer is in flight;
//   - the fallback chain is fresh → cached → FREE, so free is the last resort rather than
//     the starting state.
//
// The query and the store are stubbed at their module boundaries; the fold itself
// (`entitlementsOf`) is real, so the gates asserted here are the same table the server's
// enforcement and the paywall copy read.

import { renderHook } from '@testing-library/react';

import { entitlementsOf, type SubscriptionStatus } from '@stxapps/shared';

import { useEntitlements } from './use-entitlements';

const FREE: SubscriptionStatus = {
  plan: 'free',
  status: 'none',
  source: null,
  expiresAt: null,
  willRenew: false,
};

const PLUS: SubscriptionStatus = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  expiresAt: 1_700_000_000_000,
  willRenew: true,
};

const mockRefetch = jest.fn();
let mockQuery: {
  data?: SubscriptionStatus;
  isSuccess: boolean;
  isPlaceholderData: boolean;
  isPending: boolean;
};
let mockPlaceholderSeen: (SubscriptionStatus | undefined)[];

jest.mock('@stxapps/react', () => ({
  FREE_SUBSCRIPTION_STATUS: {
    plan: 'free',
    status: 'none',
    source: null,
    expiresAt: null,
    willRenew: false,
  },
  useSubscriptionStatus: (options: { placeholderData?: SubscriptionStatus }) => {
    mockPlaceholderSeen.push(options.placeholderData);
    return { ...mockQuery, refetch: mockRefetch };
  },
}));

let mockCached: SubscriptionStatus | null;
const mockRead = jest.fn(() => mockCached);
const mockWrite = jest.fn();
jest.mock('../data/subscription-store', () => ({
  readCachedStatus: () => mockRead(),
  writeCachedStatus: (status: SubscriptionStatus) => mockWrite(status),
}));

beforeEach(() => {
  mockCached = null;
  mockQuery = { data: undefined, isSuccess: false, isPlaceholderData: false, isPending: true };
  mockPlaceholderSeen = [];
  mockRead.mockClear();
  mockWrite.mockClear();
});

describe('the placeholder', () => {
  // Read ONCE per mount, via a lazy useState — a per-render read would hand react-query a
  // new object identity every render, which is exactly the unstable-value shape that
  // churns a query's internals.
  it('reads the device cache once per mount, not once per render', () => {
    mockCached = PLUS;

    const { rerender } = renderHook(() => useEntitlements());
    rerender();
    rerender();

    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockPlaceholderSeen.every((seen) => seen === mockPlaceholderSeen[0])).toBe(true);
  });

  it('passes no placeholder when this device has nothing cached', () => {
    const { result } = renderHook(() => useEntitlements());

    expect(mockPlaceholderSeen[0]).toBeUndefined();
    expect(result.current.subscription).toEqual(FREE);
  });
});

describe('the persist effect', () => {
  it('persists a fresh answer as the device’s last-known copy', () => {
    mockQuery = { data: PLUS, isSuccess: true, isPlaceholderData: false, isPending: false };

    renderHook(() => useEntitlements());

    expect(mockWrite).toHaveBeenCalledWith(PLUS);
  });

  // THE GUARD. `isSuccess` is true while placeholderData is being served, so without the
  // isPlaceholderData check this writes the placeholder straight back — and the
  // placeholder can belong to a DIFFERENT account.
  it('does not persist while react-query is still serving the placeholder', () => {
    mockCached = PLUS;
    mockQuery = { data: PLUS, isSuccess: true, isPlaceholderData: true, isPending: false };

    renderHook(() => useEntitlements());

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('does not persist a query that has not succeeded', () => {
    mockQuery = { data: PLUS, isSuccess: false, isPlaceholderData: false, isPending: false };

    renderHook(() => useEntitlements());

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('does not persist an undefined answer', () => {
    mockQuery = { data: undefined, isSuccess: true, isPlaceholderData: false, isPending: false };

    renderHook(() => useEntitlements());

    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('the resolved subscription', () => {
  it('prefers the fresh answer', () => {
    mockCached = FREE;
    mockQuery = { data: PLUS, isSuccess: true, isPlaceholderData: false, isPending: false };

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.subscription).toEqual(PLUS);
  });

  // THE OFFLINE / COLD-START CASE, and the reason the cache exists at all: a paying user
  // opening the app with no network keeps their plan instead of watching their features
  // re-lock.
  it('falls back to the device’s last-known plan while the network is unanswered', () => {
    mockCached = PLUS;

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.subscription).toEqual(PLUS);
    expect(result.current.entitlements).toEqual(entitlementsOf('plus'));
  });

  it('falls back to free only when there is neither an answer nor a cache', () => {
    const { result } = renderHook(() => useEntitlements());

    expect(result.current.subscription).toEqual(FREE);
    expect(result.current.entitlements).toEqual(entitlementsOf('free'));
  });

  // The gates here must be the SAME table the server enforces and the paywall copy quotes
  // — derived, never restated, so a catalog change moves all three together.
  it('derives entitlements from the shared fold, whatever the plan', () => {
    mockQuery = { data: PLUS, isSuccess: true, isPlaceholderData: false, isPending: false };

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.entitlements).toEqual(entitlementsOf(PLUS.plan));
  });
});

describe('isLoading', () => {
  // Callers skip paywall flashes on this. True only when there is genuinely nothing to
  // show yet.
  it('is true only on a cold start with nothing cached', () => {
    const { result } = renderHook(() => useEntitlements());

    expect(result.current.isLoading).toBe(true);
  });

  it('is false while a cached plan is available, however pending the query', () => {
    mockCached = PLUS;

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.isLoading).toBe(false);
  });

  it('is false once the query has settled', () => {
    mockQuery = { data: FREE, isSuccess: true, isPlaceholderData: false, isPending: false };

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.isLoading).toBe(false);
  });
});

describe('refetch', () => {
  // The post-checkout poll inspects the RESOLVED value directly rather than racing a
  // re-render, so this has to be the query's own refetch and not a wrapper that discards
  // the answer.
  it('exposes the query’s refetch so a poll can read the answer directly', async () => {
    mockRefetch.mockResolvedValue({ data: PLUS });
    const { result } = renderHook(() => useEntitlements());

    await expect(result.current.refetch()).resolves.toEqual({ data: PLUS });
  });
});
