/**
 * @jest-environment jsdom
 */
// The first sync is the one wait in this app that a user is asked to trust, and
// every rule this gate holds is invisible from the outside.
//
// The NO-FLASH pair is semantic, not a timing race: 'checking' is a single
// IndexedDB read that happens on every mount, so a returning visit must go
// 'checking' → 'ready' without ever painting a loading screen — while a first
// pull that finishes fast must not flicker the screen it did show, which is what
// the minimum-visible floor is for. Both are one-frame bugs nobody catches by
// looking.
//
// The ACCESSIBILITY rules here are the tripwire in docs/accessibility.md, in
// both directions, and neither has a lint rule or a type behind it:
//   - the error MOUNTS, so it must announce — and the carrier is the WRAPPER, so
//     the reassurance under the headline is announced too. A screen-reader user
//     who hears only "couldn't sync" has no idea whether pressing the button
//     starts over, which is the whole reason that second line exists.
//   - the progress count must NOT announce. It updates ~10 times a second, and
//     an `aria-live` here would be the password-strength mistake multiplied by a
//     thousand. It rides `aria-valuetext` on the progressbar instead, and the
//     visible copy of the same string is `aria-hidden` so it isn't read twice.
//
// The `role="progressbar"` also carries `aria-valuemax={total}`, which is the
// honest denominator the engine hands over — the reason this screen may show a
// bar and a percent at all, rather than an invented one easing toward 90%.

import { act, render, screen } from '@testing-library/react';

import type { InitialSyncProgress } from '@stxapps/shared';

import { InitialSyncGate } from './initial-sync-gate';

let mockStoreStatus = 'ready';
let mockProgress: InitialSyncProgress | null = null;
let mockSessionState: 'active' | 'expired' = 'active';
let mockLastError: string | null = null;
const retryInitialSync = jest.fn();

jest.mock('@stxapps/web-react', () => ({
  useSync: () => ({
    storeStatus: mockStoreStatus,
    initialSyncProgress: mockProgress,
    retryInitialSync,
    lastError: mockLastError,
  }),
  useAuth: () => ({ username: 'alice', sessionState: mockSessionState }),
  usePendingChangesCount: () => 0,
  useSignOut: () => ({ mutate: jest.fn(), isPending: false }),
}));

function mount() {
  const view = render(
    <InitialSyncGate>
      <p>the app</p>
    </InitialSyncGate>,
  );
  return {
    ...view,
    advance: () =>
      view.rerender(
        <InitialSyncGate>
          <p>the app</p>
        </InitialSyncGate>,
      ),
  };
}

const appIsShowing = () => screen.queryByText('the app') !== null;
const decryptingIsShowing = () => screen.queryByText('Decrypting your links…') !== null;

describe('InitialSyncGate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStoreStatus = 'ready';
    mockProgress = null;
    mockSessionState = 'active';
    mockLastError = null;
    retryInitialSync.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the app once the store is ready', () => {
    mount();
    expect(appIsShowing()).toBe(true);
  });

  // An EXPIRED session caught this device's first sync mid-way (docs/sessions.md).
  // Nothing failed, so this is not the "Couldn’t sync" error, and retrying would
  // only earn the same answer: the gate says sync is paused and offers the resume.
  it('offers a sign-in, not a retry, when an expired session holds up the first sync', () => {
    mockStoreStatus = 'error';
    mockSessionState = 'expired';
    mockLastError = 'Signing in again will finish setting up this device.';

    mount();

    expect(appIsShowing()).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Sync is paused');
    expect(screen.getByRole('button', { name: 'Sign in to resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('no flash', () => {
    // Every mount begins here, including every returning visit.
    it('shows neither the app nor a loading screen while checking', () => {
      mockStoreStatus = 'checking';
      mount();
      expect(appIsShowing()).toBe(false);
      expect(decryptingIsShowing()).toBe(false);
    });

    it('goes straight to the app on a returning visit', () => {
      mockStoreStatus = 'checking';
      const { advance } = mount();

      mockStoreStatus = 'ready';
      act(advance);
      expect(decryptingIsShowing()).toBe(false);
      expect(appIsShowing()).toBe(true);
    });

    // The floor, from the other side: a first pull that finishes in 50ms showed
    // the screen, so it holds rather than flickering.
    it('holds the first-sync screen for its minimum once it has appeared', () => {
      mockStoreStatus = 'checking';
      const { advance } = mount();

      mockStoreStatus = 'syncing-initial';
      act(advance);
      expect(decryptingIsShowing()).toBe(true);

      mockStoreStatus = 'ready';
      act(advance);
      expect(decryptingIsShowing()).toBe(true);
      expect(appIsShowing()).toBe(false);

      act(() => void jest.advanceTimersByTime(500));
      expect(appIsShowing()).toBe(true);
    });

    // A slow pull has already outlasted the floor, so nothing is held back.
    it('releases immediately when the pull outlasted the floor', () => {
      mockStoreStatus = 'checking';
      const { advance } = mount();

      mockStoreStatus = 'syncing-initial';
      act(advance);
      act(() => void jest.advanceTimersByTime(5000));

      mockStoreStatus = 'ready';
      act(advance);
      expect(appIsShowing()).toBe(true);
    });
  });

  describe('the decrypting screen', () => {
    // Real work with no denominator yet. A bar parked at 0% looks broken for
    // exactly as long as the listing takes.
    it('renders the headline alone while the pull is still listing', () => {
      mockStoreStatus = 'syncing-initial';
      mockProgress = null;
      mount();

      expect(decryptingIsShowing()).toBe(true);
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('carries the count on the progressbar itself, against the real total', () => {
      mockStoreStatus = 'syncing-initial';
      mockProgress = { done: 40, total: 200 };
      mount();

      const bar = screen.getByRole('progressbar', { name: 'Decrypting your links' });
      expect(bar.getAttribute('aria-valuetext')).toBe('40 of 200 items');
      expect(bar.getAttribute('aria-valuenow')).toBe('40');
      expect(bar.getAttribute('aria-valuemax')).toBe('200');
    });

    // ~10 updates a second. A live region here would be unusable.
    it('never announces the count as it climbs', () => {
      mockStoreStatus = 'syncing-initial';
      mockProgress = { done: 40, total: 200 };
      const { container } = mount();

      expect(container.querySelector('[aria-live]')).toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    // The progressbar already announces this exact string as its value, so the
    // visible copy must be hidden or the count is read twice.
    it('hides the visible count from assistive tech', () => {
      mockStoreStatus = 'syncing-initial';
      mockProgress = { done: 40, total: 200 };
      mount();

      expect(screen.getByText('40 of 200 items').closest('[aria-hidden="true"]')).not.toBeNull();
    });

    // The engine only reports a positive total, but this component is a package
    // boundary away from that guarantee and the failure mode is a NaN fill — so a
    // zero total draws the indeterminate track, claiming no value at all.
    it('survives a zero total rather than rendering a NaN fill', () => {
      mockStoreStatus = 'syncing-initial';
      mockProgress = { done: 0, total: 0 };
      mount();

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBeNull();
      expect(bar.firstElementChild).toBeNull();
      expect(document.body.textContent).not.toContain('NaN');
    });
  });

  describe('when the first sync fails', () => {
    beforeEach(() => {
      mockStoreStatus = 'error';
    });

    // The tripwire: an error that MOUNTS has to announce, and the carrier is the
    // wrapper so the reassurance is part of what is announced.
    it('announces the failure and the reassurance together', () => {
      mount();

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('Couldn’t sync your links.');
      expect(alert.textContent).toContain('picks up where it left off');
    });

    it('offers a retry that actually retries', () => {
      mount();

      act(() => screen.getByRole('button', { name: 'Try again' }).click());
      expect(retryInitialSync).toHaveBeenCalled();
    });

    it('does not leak the app behind the error screen', () => {
      mount();
      expect(appIsShowing()).toBe(false);
    });

    // A retry is a FRESH attempt, so the floor is stamped from when the screen
    // re-appears rather than from the try that already failed. Carrying the old
    // stamp across silently disarms the floor for every retry — the one path
    // where the pull is most likely to be fast, since it resumes.
    it('re-stamps the floor when a retry goes back through checking', () => {
      mockStoreStatus = 'checking';
      const { advance } = mount();

      // The attempt that fails, long enough to outlast the floor on its own.
      mockStoreStatus = 'syncing-initial';
      act(advance);
      act(() => void jest.advanceTimersByTime(5000));
      mockStoreStatus = 'error';
      act(advance);

      // Try again.
      mockStoreStatus = 'checking';
      act(advance);
      mockStoreStatus = 'syncing-initial';
      act(advance);
      expect(decryptingIsShowing()).toBe(true);

      mockStoreStatus = 'ready';
      act(advance);
      expect(appIsShowing()).toBe(false); // held by the new floor, not the old one

      act(() => void jest.advanceTimersByTime(500));
      expect(appIsShowing()).toBe(true);
    });
  });
});
