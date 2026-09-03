/**
 * @jest-environment jsdom
 */
// Specs for the web auth provider — specifically the three orderings it exists to get
// right, none of which produces an error when it goes wrong.
//
// 1. THE `'ending'` PHASE. `endSession` flips to 'ending' BEFORE the wipe, so the
//    signed-in subtree unmounts while the store still has data in it. Without that there
//    is a live frame where the store is empty and status is still 'authenticated', and
//    every effect that treats data DISAPPEARING as a deletion misfires on it — on
//    bracemark-web that was the links page reading its own `?list=` as deleted and firing
//    `router.replace` into AuthGuard's exit navigation, two navigators in one frame
//    (docs/data-lifecycle.md, _the sign-out teardown_). CLAUDE.md records that the
//    ordering has no test at the app level, because `location.replace` absorbs the stray
//    dispatch there: deleting the phase breaks nothing observable until the next
//    auto-navigating effect lands. It IS observable here, at the provider, which is
//    where the ordering actually lives — so this is that missing pin.
//    It also must not flip straight to 'unauthenticated': that starts the exit
//    navigation, and a cross-origin `location.replace` mid-wipe could tear the document
//    down with decrypted bookmarks still in IndexedDB.
//
// 2. THE WIPE ON EVERY RESOLUTION TO SIGNED-OUT, not just on an expired session. The
//    teardown is several independent clears, so a tab closed mid-wipe leaves plaintext
//    with no session row; the mount path catches exactly that on the next load.
//
// 3. THE 401 BURST COLLAPSE. Concurrent failing requests each fire
//    `notifySessionInvalid` (the store fans out without deduping, deliberately), and the
//    provider is what turns a burst into ONE sign-out.
//
// Two modules are stubbed and nothing else: `clearData`, because the point of most of
// these tests is WHEN it runs relative to the status flips (so the wipe has to be
// holdable open), and the session store, whose IndexedDB half needs a `structuredClone`
// the jsdom environment doesn't have. The stub keeps the two behaviours the provider
// actually leans on — the mirror is synchronous, and `notifySessionInvalid` fans out to
// every subscriber WITHOUT deduping (session-store.spec.ts pins that against the real
// module), so the burst-collapse test below is measuring this provider and not a fake
// that quietly collapsed the burst for it.

import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';

import {
  clearSession,
  getSession,
  loadSession,
  notifySessionInvalid,
  saveSession,
  type SessionRecord,
} from '../data/session-store';
import { AuthProvider, useAuth } from './auth-provider';

jest.mock('../data/session-store', () => {
  let current: SessionRecord | null = null;
  const listeners = new Set<() => void>();
  return {
    getSession: () => current,
    saveSession: (record: SessionRecord) => {
      current = record;
      return Promise.resolve();
    },
    loadSession: jest.fn(() => Promise.resolve(current)),
    clearSession: () => {
      current = null;
      return Promise.resolve();
    },
    onSessionInvalid: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // No deduping — the real store's contract, and the thing the provider has to fix.
    notifySessionInvalid: () => {
      for (const listener of listeners) listener();
    },
  };
});

// The wipe, held open on demand so the status DURING it is observable.
let releaseWipe: (() => void) | undefined;
const mockClearData = jest.fn(
  () =>
    new Promise<void>((resolve) => {
      if (releaseWipe === undefined) resolve();
      else releaseWipe = () => resolve();
    }),
);
jest.mock('../data/clear-data', () => ({ clearData: () => mockClearData() }));

const HOUR = 60 * 60 * 1000;

function session(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    username: 'alice',
    token: 'tok',
    expiresAt: Date.now() + HOUR,
    // Never read here — the provider deliberately keeps key material out of React
    // state, and asserting that is the point (only `username`/`status` reach the tree).
    encryptionKey: {} as CryptoKey,
    ...patch,
  };
}

// Every status the provider passed through, in order — the only way to see a transient
// frame like 'ending', which a final-state assertion cannot.
let statuses: string[];
let auth: ReturnType<typeof useAuth>;

function Probe() {
  const value = useAuth();
  auth = value;
  useEffect(() => {
    statuses.push(value.status);
  }, [value.status]);
  return (
    <div>
      <span data-testid="status">{value.status}</span>
      <span data-testid="username">{value.username ?? '-'}</span>
      <span data-testid="reason">{value.reason ?? '-'}</span>
    </div>
  );
}

let queryClient: QueryClient;

function renderProvider() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const status = () => screen.getByTestId('status').textContent;

beforeEach(async () => {
  statuses = [];
  releaseWipe = undefined;
  mockClearData.mockClear();
  await clearSession();
});

describe('hydration', () => {
  it('starts at loading, so nothing flashes a signed-out state', async () => {
    renderProvider();

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('unauthenticated'));
  });

  it('adopts a live persisted session', async () => {
    await saveSession(session());

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('username').textContent).toBe('alice');
    // A direct visit that resolved to a session has nothing to explain.
    expect(screen.getByTestId('reason').textContent).toBe('-');
  });

  // 'expired' is what sends the user to /sign-in?next= instead of out to the marketing
  // site — the difference between resuming where they were and losing the page.
  it('records `expired` for a stored session whose token has lapsed', async () => {
    await saveSession(session({ expiresAt: Date.now() - 1 }));

    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(screen.getByTestId('reason').textContent).toBe('expired');
  });

  // A direct visit by a guest: no session ever existed this load, so there is no reason
  // to give and AuthGuard sends them to the landing page rather than to a resume URL.
  it('leaves the reason null when there was never a session', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(screen.getByTestId('reason').textContent).toBe('-');
  });

  // THE INTERRUPTED-EXIT GAP. The teardown is several independent clears, so a tab closed
  // mid-wipe can leave DECRYPTED bookmarks behind with no session row — which is exactly
  // the state this path sees. Running the wipe on every resolution to signed-out, not
  // only on an expired session, is what closes it.
  it('wipes the device even when there was no session to expire', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });

  it('resolves to signed-out if hydration itself fails', async () => {
    (loadSession as jest.Mock).mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
  });
});

describe('setSession', () => {
  it('persists the session and flips to authenticated', async () => {
    renderProvider();
    await waitFor(() => expect(status()).toBe('unauthenticated'));

    await act(async () => void (await auth.setSession(session({ username: 'bob' }))));

    expect(status()).toBe('authenticated');
    expect(screen.getByTestId('username').textContent).toBe('bob');
    expect(getSession()?.username).toBe('bob');
  });

  // Signing in clears whatever explained the previous exit — otherwise a stale 'expired'
  // outlives the session it described.
  it('clears the previous end reason', async () => {
    await saveSession(session({ expiresAt: Date.now() - 1 }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('reason').textContent).toBe('expired'));

    await act(async () => void (await auth.setSession(session())));

    expect(screen.getByTestId('reason').textContent).toBe('-');
  });
});

describe('endSession', () => {
  beforeEach(async () => {
    await saveSession(session());
    renderProvider();
    await waitFor(() => expect(status()).toBe('authenticated'));
    statuses.length = 0;
    mockClearData.mockClear();
  });

  // THE ORDERING. 'ending' has to be observable BEFORE the wipe resolves, and
  // 'unauthenticated' only after — the first half unmounts the observers, the second half
  // starts the navigation.
  it('closes the gate before the wipe, and navigates only after it', async () => {
    releaseWipe = () => undefined; // hold the wipe open
    let ended: Promise<void>;
    act(() => {
      ended = auth.endSession();
    });

    await waitFor(() => expect(status()).toBe('ending'));
    expect(mockClearData).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseWipe?.();
      await ended;
    });

    expect(status()).toBe('unauthenticated');
    // …and it passed THROUGH 'ending' rather than jumping straight there: a flip to
    // 'unauthenticated' up front would start the exit navigation mid-wipe.
    expect(statuses).toEqual(['ending', 'unauthenticated']);
  });

  it('drops the username and the persisted session', async () => {
    await act(async () => void (await auth.endSession()));

    expect(screen.getByTestId('username').textContent).toBe('-');
    expect(getSession()).toBeNull();
  });

  // The default is a DELIBERATE sign-out, which leaves the app for the marketing site;
  // 'expired' goes to /sign-in?next= instead. The provider is the only thing that knows
  // which happened.
  it('records a deliberate sign-out by default', async () => {
    await act(async () => void (await auth.endSession()));

    expect(screen.getByTestId('reason').textContent).toBe('signed-out');
  });

  it('records the caller’s reason when given one', async () => {
    await act(async () => void (await auth.endSession('expired')));

    expect(screen.getByTestId('reason').textContent).toBe('expired');
  });

  // The third per-account store, and the one clearData can't reach: react-query's cache
  // is keyed by CONSTANTS, not by user, so a second account in the same JS context would
  // otherwise inherit the first's subscription answer — and useEntitlements would persist
  // that wrong plan into the new account's device cache.
  it('clears the query cache, which the device wipe cannot reach', async () => {
    const cleared = jest.spyOn(queryClient, 'clear');

    await act(async () => void (await auth.endSession()));

    expect(cleared).toHaveBeenCalled();
  });

  // Both clears run regardless of which one rejects — a failed device wipe must not leave
  // the user stuck signed in with a dead session.
  it('still reaches signed-out when the wipe fails', async () => {
    mockClearData.mockRejectedValueOnce(new Error('IndexedDB is gone'));

    await act(async () => void (await auth.endSession()));

    expect(status()).toBe('unauthenticated');
    expect(getSession()).toBeNull();
  });
});

describe('the invalid-session listener', () => {
  beforeEach(async () => {
    await saveSession(session());
    renderProvider();
    await waitFor(() => expect(status()).toBe('authenticated'));
    mockClearData.mockClear();
  });

  // A 401 anywhere means the token is dead — the provider drops to signed-out with
  // 'expired', so AuthGuard resumes the user at /sign-in?next= rather than ejecting them
  // to the landing page as if they had chosen to leave.
  it('signs out as `expired` when the api client reports an invalid session', async () => {
    await act(async () => {
      notifySessionInvalid();
      await Promise.resolve();
    });

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(screen.getByTestId('reason').textContent).toBe('expired');
  });

  // The store fans out every notification without deduping, on purpose — collapsing the
  // burst is THIS module's job. Two concurrent failing requests must be one sign-out, not
  // two overlapping wipes.
  it('collapses a burst of concurrent 401s into a single sign-out', async () => {
    await act(async () => {
      notifySessionInvalid();
      notifySessionInvalid();
      notifySessionInvalid();
      await Promise.resolve();
    });

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });

  // …but the guard resets, so a later session can be invalidated too. A latch that stuck
  // would leave the next expiry undetected for the life of the tab.
  it('can invalidate again after a later sign-in', async () => {
    await act(async () => {
      notifySessionInvalid();
      await Promise.resolve();
    });
    await waitFor(() => expect(status()).toBe('unauthenticated'));

    await act(async () => void (await auth.setSession(session())));
    mockClearData.mockClear();

    await act(async () => {
      notifySessionInvalid();
      await Promise.resolve();
    });

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });
});

describe('useAuth', () => {
  it('refuses to be used outside the provider', () => {
    const noise = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow(/AuthProvider/);

    noise.mockRestore();
  });
});
