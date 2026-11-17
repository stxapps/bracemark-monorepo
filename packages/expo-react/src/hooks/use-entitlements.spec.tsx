// The expo sibling of web-react's hooks/use-entitlements.spec.tsx, for the two fields the
// iOS share drain reads (apps/bracemark-expo components/share-bridge.tsx): `isKnown` tells
// the FREE fallback from a free ANSWER, and `isFetching` tells "an answer is on its way"
// from a query react-query has paused offline. The drain waits while `!isKnown &&
// isFetching`, and keeps a Safari copy when the plan is not known; a field that read wrong
// would either hold every share until the network came back or drop a paying account's
// copy for good, and nothing would say so.
//
// The query and the store are stubbed at their module boundaries, as on web.

import { renderHook } from '@testing-library/react-native';

import type { SubscriptionStatus } from '@stxapps/shared';

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

let mockQuery: {
  data?: SubscriptionStatus;
  isSuccess: boolean;
  isPlaceholderData: boolean;
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
};

jest.mock('@stxapps/react', () => ({
  FREE_SUBSCRIPTION_STATUS: {
    plan: 'free',
    status: 'none',
    source: null,
    expiresAt: null,
    willRenew: false,
  },
  useSubscriptionStatus: () => ({ ...mockQuery, refetch: jest.fn() }),
}));

let mockCached: SubscriptionStatus | null;
jest.mock('../data/subscription-store', () => ({
  readCachedStatus: () => mockCached,
  writeCachedStatus: jest.fn(),
}));

beforeEach(() => {
  mockCached = null;
  mockQuery = {
    data: undefined,
    isSuccess: false,
    isPlaceholderData: false,
    isPending: true,
    fetchStatus: 'fetching',
  };
});

it('is not known while nothing is cached and nothing has answered, and an answer is coming', () => {
  const { result } = renderHook(() => useEntitlements());

  expect(result.current.isKnown).toBe(false);
  expect(result.current.isFetching).toBe(true);
  expect(result.current.entitlements.keptCopies).toBe(false);
});

it('is known from the device’s cached copy, however pending the query', () => {
  mockCached = PLUS;

  const { result } = renderHook(() => useEntitlements());

  expect(result.current.isKnown).toBe(true);
  expect(result.current.entitlements.keptCopies).toBe(true);
});

it('is known from a free answer: free is then the answer, not the fallback', () => {
  mockQuery = {
    data: FREE,
    isSuccess: true,
    isPlaceholderData: false,
    isPending: false,
    fetchStatus: 'idle',
  };

  const { result } = renderHook(() => useEntitlements());

  expect(result.current.isKnown).toBe(true);
  expect(result.current.isFetching).toBe(false);
});

// Offline, react-query holds the query pending with nothing in flight: no answer is coming.
it('is not fetching while the query is paused offline, though still loading', () => {
  mockQuery = { ...mockQuery, fetchStatus: 'paused' };

  const { result } = renderHook(() => useEntitlements());

  expect(result.current.isLoading).toBe(true);
  expect(result.current.isFetching).toBe(false);
  expect(result.current.isKnown).toBe(false);
});

// A failed query with nothing cached: settled, nothing in flight, and still not an answer.
it('is neither known nor fetching after the query failed with nothing cached', () => {
  mockQuery = { ...mockQuery, isPending: false, fetchStatus: 'idle' };

  const { result } = renderHook(() => useEntitlements());

  expect(result.current.isKnown).toBe(false);
  expect(result.current.isFetching).toBe(false);
});
