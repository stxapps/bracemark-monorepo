import * as React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import { useEntitlements, useSync } from '@stxapps/expo-react';

import { fetchStorePlanProducts, restoreStorePurchases } from '../../lib/iap';
import { SubscriptionSection } from './subscription-section';

// The native half of bracemark-web's `subscription-section.spec.tsx`: on both
// platforms `refreshStatus` is the one handler that has to clear a notice it did
// not set, and on both a survivor contradicts the plan box it sits under.
//
// The scenario differs because the sections do. Web reaches it through the
// activation poll (a webhook that outran 15 tries). There is no poll here —
// verify's response IS the flipped plan — so the notice that goes stale is the
// restore verdict: a user who subscribed on the WEB restores on their phone,
// the store rightly holds nothing, and the "no purchases" line is still up when
// Refresh pulls the Paddle plan the account already has.
//
// The store seam is mocked whole (the same call this file's expo peers make for
// the data layer): `lib/iap` talks to expo-iap and needs a native runtime, and
// `legal-consent` reaches `lib/site`, which THROWS at module scope when
// EXPO_PUBLIC_SITE_URL is unset — as it is under jest.
jest.mock('@stxapps/expo-react', () => ({
  useEntitlements: jest.fn(),
  useSync: jest.fn(),
}));

jest.mock('../../lib/iap', () => ({
  STORE_SOURCE: 'appstore',
  fetchStorePlanProducts: jest.fn(),
  openStoreCheckout: jest.fn(),
  openStoreSubscriptionManagement: jest.fn(),
  restoreStorePurchases: jest.fn(),
}));

jest.mock('../../components/legal-consent', () => ({
  LegalConsent: () => null,
}));

const useEntitlementsMock = useEntitlements as jest.Mock;
const useSyncMock = useSync as jest.Mock;
const fetchStorePlanProductsMock = fetchStorePlanProducts as jest.Mock;
const restoreStorePurchasesMock = restoreStorePurchases as jest.Mock;

const FREE = {
  plan: 'free',
  status: 'none',
  source: null,
  expiresAt: null,
  willRenew: false,
} as const;

// Bought on the web, which is why the store had nothing to restore. Fixed date:
// the box prints it through toLocaleDateString, and a moving one would make the
// rendered string depend on the day the suite runs.
const PLUS_ON_PADDLE = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  expiresAt: Date.UTC(2027, 0, 15),
  willRenew: true,
} as const;

const NO_PURCHASES = 'No purchases to restore on this store account.';

// Read on every render, so assigning it mid-test is how the account's real plan
// "arrives" — the next render after any state change picks it up, which is what
// the query does when refetch resolves with a wider fold.
let subscription: typeof FREE | typeof PLUS_ON_PADDLE = FREE;

beforeEach(() => {
  subscription = FREE;
  useEntitlementsMock.mockImplementation(() => ({
    subscription,
    isLoading: false,
    refetch: jest.fn(() => Promise.resolve({ data: subscription })),
  }));
  useSyncMock.mockReturnValue({ requestSync: jest.fn() });
  // No store on this device, the same shape the section's own catch writes: the
  // cards render at the planning price with a disabled button.
  fetchStorePlanProductsMock.mockResolvedValue({});
  restoreStorePurchasesMock.mockResolvedValue(null);
});

test('clears the restore notice when the status is refreshed', async () => {
  const { getByText, queryByText } = render(<SubscriptionSection />);
  // Flush the catalog effect, so its setState doesn't land outside act().
  await act(async () => {
    await Promise.resolve();
  });

  await act(async () => {
    fireEvent.press(getByText('Restore purchases'));
  });
  expect(getByText(NO_PURCHASES)).toBeTruthy();

  // The web purchase is what Refresh finds — the verdict above is now false.
  subscription = PLUS_ON_PADDLE;
  await act(async () => {
    fireEvent.press(getByText('Refresh'));
  });

  expect(getByText('Plus')).toBeTruthy();
  expect(queryByText(NO_PURCHASES)).toBeNull();
});
