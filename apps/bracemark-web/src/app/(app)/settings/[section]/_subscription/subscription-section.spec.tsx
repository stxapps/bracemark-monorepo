import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { SubscriptionSection } from './subscription-section';

// Pins the one state this section can reach where two things on screen disagree:
// a checkout whose webhook outran the activation poll leaves the "still
// processing" notice up, and the next Refresh flips the plan box to Plus
// underneath it. `refreshStatus` is the only handler that has to clear a notice
// it did not set (startCheckout and the expo section's restore both clear at
// entry), so nothing else in the file would catch a regression here.
//
// A component spec rather than an e2e flow, per docs/testing.md, _the layer to
// reach for_: the contradiction is a property of this component's own state, and
// the browser layer would have to buy a real Paddle overlay and a real webhook
// to assert it.
//
// The whole IAP edge is mocked — every hook this section reads, plus the two
// app-level modules it calls. `@/components/legal-consent` is mocked for a
// mechanical reason and not a design one: it imports `@/lib/site`, which THROWS
// at module scope when NEXT_PUBLIC_SITE_URL is unset (as it is under jest).
const FREE = {
  plan: 'free',
  status: 'none',
  source: null,
  expiresAt: null,
  willRenew: false,
} as const;

const PLUS = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  // Fixed, not Date.now()-relative: the box prints this through toLocaleDateString
  // and a moving date would make the rendered string depend on the run.
  expiresAt: Date.UTC(2027, 0, 15),
  willRenew: true,
} as const;

// Read fresh on every render, so assigning it mid-test is how the webhook
// "lands" — the next render after any state change picks up the new plan, which
// is exactly what the real query does when refetch resolves with a wider fold.
let mockSubscription: typeof FREE | typeof PLUS = FREE;
const mockRefetch = jest.fn(() => Promise.resolve({ data: mockSubscription }));
const mockRequestSync = jest.fn();
const mockApiCall = jest.fn(() => Promise.resolve({ transactionId: 'txn_test' }));
const mockOpenPaddleCheckout = jest.fn(
  ({ onCompleted }: { onCompleted: () => void }) => void onCompleted(),
);

jest.mock('@stxapps/web-react', () => ({
  useEntitlements: () => ({ subscription: mockSubscription, isLoading: false, refetch: mockRefetch }),
  useSync: () => ({ requestSync: mockRequestSync }),
}));

jest.mock('@stxapps/react', () => ({
  useApiClient: () => ({ call: mockApiCall }),
}));

jest.mock('@/lib/paddle', () => ({
  openPaddleCheckout: (opts: { onCompleted: () => void }) => mockOpenPaddleCheckout(opts),
}));

jest.mock('@/components/legal-consent', () => ({
  LegalConsent: () => null,
}));

jest.mock('./use-paddle-prices', () => ({
  usePaddlePrices: () => ({ data: undefined, isFetched: true }),
}));

describe('SubscriptionSection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSubscription = FREE;
    mockRefetch.mockClear();
    mockRequestSync.mockClear();
    mockApiCall.mockClear();
    mockOpenPaddleCheckout.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears the activation notice when the status is refreshed', async () => {
    render(<SubscriptionSection />);

    // Buy Plus. The mocked overlay completes immediately, which starts the
    // activation poll — and the poll reads a plan that never flips, because the
    // webhook has not landed yet.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Plus' }));
    });

    // Exhaust every try, so the poll gives up and posts the timeout notice —
    // the one that tells the user to come back and check. Async advancement:
    // each iteration awaits a refetch promise between two timer waits, and the
    // sync `advanceTimersByTime` would not let those microtasks run.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15 * 2000);
    });
    expect(screen.getByText(/still processing/)).toBeTruthy();

    // The webhook lands while that notice is on screen. Refresh is what the
    // notice just told the user to press.
    mockSubscription = PLUS;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    // The plan box now reads Plus — which is precisely what makes a surviving
    // "still processing" a contradiction rather than merely stale.
    expect(screen.getByText('Plus')).toBeTruthy();
    expect(screen.queryByText(/still processing/)).toBeNull();
  });
});
