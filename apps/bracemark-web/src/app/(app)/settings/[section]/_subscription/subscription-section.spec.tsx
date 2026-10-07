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
type OpenOptions = { transactionId: string; theme: string; onCompleted: () => void };
// Async like the real one, so a test can reject it the way a blocked Paddle.js
// does — a stub that threw synchronously would reach the same catch by a route
// the app never takes.
const mockOpenPaddleCheckout = jest.fn(({ onCompleted }: OpenOptions): Promise<void> => {
  onCompleted();
  return Promise.resolve();
});

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

// Mocked rather than wrapped in a real <ThemeProvider>, which would drag in the
// whole settings data layer for one string. 'dark' because it is the value that
// can be wrong: light is also what a forgotten setting produces.
jest.mock('@stxapps/web-ui/contexts/theme-provider', () => ({
  useTheme: () => ({ effectiveTheme: 'dark' }),
}));

jest.mock('./use-paddle-prices', () => ({
  usePaddlePrices: () => ({ data: undefined, isFetched: true }),
}));

describe('SubscriptionSection', () => {
  // Every error-tone SettingsNotice scrolls itself into view on mount — the
  // dunning account's `grace` line, and both failed-upgrade messages below —
  // and jsdom, having no layout, doesn't implement it (the settings-kit spec
  // stubs it the same way).
  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
  });

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

  // `next dev` runs under StrictMode, whose mount → cleanup → mount reuses every
  // ref. The poll's "unmounted" ref used to be set by that first cleanup and never
  // reset, so the poll bailed after its first refetch without clearing `busy`:
  // the plan box flipped to Plus, "Finishing your upgrade…" stayed up forever and
  // every button on the page stayed disabled. Every render here is under
  // StrictMode (docs/testing.md); a production build never double-mounts.
  it('settles the activation poll and gives the controls back', async () => {
    render(<SubscriptionSection />);

    // The webhook has already landed by the poll's first read.
    mockRefetch.mockImplementationOnce(() => {
      mockSubscription = PLUS;
      return Promise.resolve({ data: PLUS });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Plus' }));
    });

    expect(screen.getByText(/You’re on Plus now/)).toBeTruthy();
    expect(screen.queryByText('Finishing your upgrade…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Manage billing' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  // Paddle's overlay is a third-party iframe on their origin: no class of ours
  // reaches inside it, and it opens LIGHT unless told otherwise — so a dark-mode
  // account would get a white payment sheet thrown over a dark page. The setting
  // rides on each OPEN, and has to: Paddle.js initializes much earlier (the
  // price preview), `Paddle.Update()` carries no checkout settings, and the
  // theme can move in between — the OS flipping under `system`, `custom`
  // crossing its hour, or the user changing it in Settings.
  it('opens the overlay in the theme the page is rendering', async () => {
    render(<SubscriptionSection />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Plus' }));
    });

    expect(mockOpenPaddleCheckout).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  // One button, two failures behind it, and they do not have the same remedy —
  // which is the thing these two pin, since a single catch reading `e.message`
  // satisfies neither and looks fine on screen.
  describe('an upgrade that fails', () => {
    it('sends the user to a reload when the payment overlay cannot load', async () => {
      // Paddle.js blocked (an ad blocker, a dropped connection). The SDK caches
      // that rejection for the life of the page — a second press cannot even
      // re-fetch the script — so "Please try again" would be a button that
      // provably does nothing, and the sentence has to name the reload instead.
      mockOpenPaddleCheckout.mockRejectedValueOnce(new Error('Failed to load Paddle.js - v1'));

      render(<SubscriptionSection />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Plus' }));
      });

      // role="alert", via the error-tone notice: this mounts while the user is
      // waiting for an overlay that never appeared, so a silent one is a screen
      // reader user staring at nothing (docs/accessibility.md).
      expect(screen.getByRole('alert').textContent).toBe(
        'Could not open the payment page. Reload the page and try again.',
      );
      // Never the thrown string — a vendor build id in front of a customer who
      // was trying to pay (docs/brand-assets.md, _errors have a fixed shape_).
      expect(screen.queryByText(/Paddle\.js/)).toBeNull();
    });

    it('offers another try when it is the checkout call that fails', async () => {
      // The other half, and the reason the two catches are separate: this one
      // IS retryable in place — `iap/checkout` is idempotent within its window,
      // so pressing again re-uses the pending transaction rather than minting a
      // second payable one — so it must not send the user off to reload.
      mockApiCall.mockRejectedValueOnce(new Error('Request failed with status 500'));

      render(<SubscriptionSection />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Plus' }));
      });

      expect(screen.getByRole('alert').textContent).toBe(
        'Could not start the upgrade. Please try again.',
      );
      // No transaction was created, so nothing opened — and the busy flag is
      // cleared, which is what puts the button back under the finger it asks.
      expect(mockOpenPaddleCheckout).not.toHaveBeenCalled();
      // No jest-dom in this workspace, so the attribute directly.
      expect(screen.getByRole('button', { name: 'Upgrade to Plus' }).hasAttribute('disabled')).toBe(
        false,
      );
    });
  });

  // The one catch in this section that still printed `e.message` after the two
  // above were split — the same status line, behind the other button.
  it('says the portal could not open, never the request’s status line', async () => {
    mockSubscription = PLUS;
    mockApiCall.mockRejectedValueOnce(new Error('Request failed with status 502'));

    render(<SubscriptionSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    });

    expect(screen.getByRole('alert').textContent).toBe(
      'Could not open the billing portal. Please try again.',
    );
    expect(screen.queryByText(/Request failed/)).toBeNull();
    // Retryable in place — the busy flag is cleared and the button is back.
    expect(screen.getByRole('button', { name: 'Manage billing' }).hasAttribute('disabled')).toBe(
      false,
    );
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
        return Promise.resolve();
      });
      return { opts: () => captured };
    }

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

      // A free account completing it is a PURCHASE — a dunning sub that has
      // already lapsed — so it takes the activation poll.
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
