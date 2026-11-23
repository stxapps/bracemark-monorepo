import { renderHook } from '@testing-library/react';

import { sessionProbeEndpoint } from '@stxapps/shared';

import { useSessionCheckOnSyncFailure } from './use-session-check-on-sync-failure';

// The background never acts on a verdict its cycle earns, so a revoked session
// whose popup opened on an unsavable page (no editor, so no request of the
// popup's own) read "Sync failed" for good and was never erased. The hook sends
// the probe from the popup instead; what the provider then does with the answer
// is pinned in web-react's auth-provider.spec.

const mockCall = jest.fn();
const mockUseAuth = jest.fn();
const mockUseSync = jest.fn();

// One client for the life of the test, as the real provider's is: a fresh object
// per render would re-run the effect and read as a probe per render.
const mockApi = { call: (...args: unknown[]) => mockCall(...args) };
jest.mock('@stxapps/react', () => ({
  useApiClient: () => mockApi,
}));
jest.mock('@stxapps/web-react', () => ({
  get useAuth() {
    return mockUseAuth;
  },
  get useSync() {
    return mockUseSync;
  },
}));

function given(auth: { status: string; sessionState: string | null }, bgSyncStatus: string) {
  mockUseAuth.mockReturnValue(auth);
  mockUseSync.mockReturnValue({ bgSyncStatus });
}

const SIGNED_IN = { status: 'authenticated', sessionState: 'active' };

beforeEach(() => {
  jest.clearAllMocks();
  mockCall.mockResolvedValue({ ok: true });
});

it('checks the session when the background’s last cycle failed', () => {
  given(SIGNED_IN, 'error');

  renderHook(() => useSessionCheckOnSyncFailure());

  expect(mockCall).toHaveBeenCalledWith(sessionProbeEndpoint, {});
});

it.each([
  ['a healthy cycle', SIGNED_IN, 'idle'],
  ['a cycle in flight', SIGNED_IN, 'syncing'],
  // The auth provider probes an expired session itself.
  ['an expired session', { status: 'authenticated', sessionState: 'expired' }, 'paused'],
  ['no session', { status: 'unauthenticated', sessionState: null }, 'error'],
])('sends nothing for %s', (_name, auth, bg) => {
  given(auth, bg);

  renderHook(() => useSessionCheckOnSyncFailure());

  expect(mockCall).not.toHaveBeenCalled();
});

// Counted from a baseline, not from zero: the test renderer runs mount effects
// twice under StrictMode (docs/testing.md), as the popup's dev root does.
it('checks once per failure, and again when a retry fails', () => {
  given(SIGNED_IN, 'error');
  const { rerender } = renderHook(() => useSessionCheckOnSyncFailure());
  const mounted = mockCall.mock.calls.length;
  expect(mounted).toBeGreaterThan(0);

  rerender();
  expect(mockCall).toHaveBeenCalledTimes(mounted);

  given(SIGNED_IN, 'syncing');
  rerender();
  given(SIGNED_IN, 'error');
  rerender();

  expect(mockCall).toHaveBeenCalledTimes(mounted + 1);
});

it('swallows a probe that fails — the failure was not the session’s to explain', async () => {
  given(SIGNED_IN, 'error');
  mockCall.mockRejectedValue(new Error('offline'));

  renderHook(() => useSessionCheckOnSyncFailure());
  await Promise.resolve();

  // Reaching this line is the assertion: an unhandled rejection fails the run.
  expect(mockCall).toHaveBeenCalled();
});
