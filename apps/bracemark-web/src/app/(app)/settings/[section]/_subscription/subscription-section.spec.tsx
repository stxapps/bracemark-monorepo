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
// app-level modules it calls. `@/components/legal-consent` used to be mocked
// alongside them for a mechanical reason and not a design one: it imports
// `@/lib/site`, which throws at module scope on a missing NEXT_PUBLIC_SITE_URL,
// and jest saw no env at all. `.env.test` supplies it now, so the real component
// renders here (docs/env-files.md, _the test env_).
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

// Paid, but a renewal failed and Paddle is retrying — the fold's `grace`.
const PLUS_GRACE = { ...PLUS, status: 'grace' } as const;

// Read fresh on every render, so assigning it mid-test is how the webhook
// "lands" — the next render after any state change picks up the new plan, which
// is exactly what the real query does when refetch resolves with a wider fold.
let mockSubscription: typeof FREE | typeof PLUS | typeof PLUS_GRACE = FREE;
const mockRefetch = jest.fn(() => Promise.resolve({ data: mockSubscription }));
const mockRequestSync = jest.fn();
const mockApiCall = jest.fn(() => Promise.resolve({ transactionId: 'txn_test' }));
// What the section hands openPaddleCheckout — the slice these tests read.
type OpenOptions = { transactionId: string; onCompleted: () => void };
const mockOpenPaddleCheckout = jest.fn(({ onCompleted }: OpenOptions) => void onCompleted());

jest.mock('@stxapps/web-react', () => ({
  useEntitlements: () => ({
    subscription: mockSubscription,
    isLoading: false,
    refetch: mockRefetch,
  }),
  useSync: () => ({ requestSync: mockRequestSync }),
}));

jest.mock('@stxapps/react', () => ({
  useApiClient: () => ({ call: mockApiCall }),
}));

jest.mock('@/lib/paddle', () => ({
  openPaddleCheckout: (opts: OpenOptions) => mockOpenPaddleCheckout(opts),
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

  // Paddle's emails link to this page as `?_ptxn=txn_…` (it is the default
  // payment link). Before this path existed the page opened nothing for a
  // subscriber: Paddle.js only loaded for a free account's price preview, so a
  // customer in dunning clicking "update your payment details" got a settings
  // page and no way to pay from it.
  describe('a Paddle payment link', () => {
    // Hold the overlay open instead of completing it at once, so each test can
    // decide what the webhook has done by the time payment finishes.
    function holdOverlay(): { opts: () => OpenOptions | undefined } {
      let captured: OpenOptions | undefined;
      mockOpenPaddleCheckout.mockImplementationOnce((opts: OpenOptions) => {
        captured = opts;
      });
      return { opts: () => captured };
    }

    // The dunning account renders the `grace` notice, an error-tone
    // SettingsNotice that scrolls itself into view on mount — which jsdom, with
    // no layout, doesn't implement (the settings-kit spec stubs it the same way).
    beforeAll(() => {
      Element.prototype.scrollIntoView = jest.fn();
    });

    afterEach(() => {
      window.history.replaceState(null, '', '/');
    });

    it('opens its checkout on arrival and takes it out of the address bar', async () => {
      window.history.replaceState(null, '', '/settings/subscription?_ptxn=txn_01abc&keep=1');
      const overlay = holdOverlay();

      await act(async () => {
        render(<SubscriptionSection />);
      });

      expect(overlay.opts()?.transactionId).toBe('txn_01abc');
      // Stripped, and only that parameter: a reload must not re-open the
      // overlay, and Paddle.js must not find it to auto-open a second one.
      expect(window.location.search).toBe('?keep=1');

      // A free account completing it is a PURCHASE — the recovery email for an
      // abandoned checkout — so it takes the activation poll.
      mockSubscription = PLUS;
      await act(async () => {
        overlay.opts()?.onCompleted();
      });
      expect(screen.getByText(/You’re on Plus now/)).toBeTruthy();
      expect(mockRequestSync).toHaveBeenCalled();
    });

    it('waits for a payment issue to clear when a subscriber in dunning pays', async () => {
      mockSubscription = PLUS_GRACE;
      window.history.replaceState(null, '', '/settings/subscription?_ptxn=txn_01dunning');
      const overlay = holdOverlay();

      await act(async () => {
        render(<SubscriptionSection />);
      });
      expect(overlay.opts()?.transactionId).toBe('txn_01dunning');

      // The plan never moves here, so the purchase poll's "plan changed" test
      // would spin to its timeout. What the webhook moves is the status.
      mockSubscription = PLUS;
      await act(async () => {
        overlay.opts()?.onCompleted();
      });
      expect(screen.getByText('Payment received — the payment issue is resolved.')).toBeTruthy();
      expect(screen.queryByText(/You’re on/)).toBeNull();
    });

    it('ignores a value that is not a transaction id, and still strips it', async () => {
      window.history.replaceState(null, '', '/settings/subscription?_ptxn=javascript:alert(1)');

      await act(async () => {
        render(<SubscriptionSection />);
      });

      expect(mockOpenPaddleCheckout).not.toHaveBeenCalled();
      expect(window.location.search).toBe('');
    });
  });
});
