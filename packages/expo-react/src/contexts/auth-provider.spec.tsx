// A drift guard for the expo auth provider. web-react's auth-provider.spec.tsx is
// canonical for what these transitions mean; the two providers are duplicated source, and
// the header here says the pair "must stay in step" — so a spec that passes on web's copy
// is exactly the thing that proves nothing about this one.
//
// The `'ending'` phase is the reason this file exists. Its own header records that nothing
// on this platform observes it TODAY — this client keeps its selection in React state, not
// a URL, so it has no auto-navigating effect to misfire the way web's links page did. That
// makes the phase deletable with no visible symptom on a device, and re-openable the moment
// someone adds the first such effect. It is fully observable HERE, at the state machine,
// which is where the rule actually lives.
//
// Two things bite HARDER on this platform than on web, and both are asserted:
//   - the app process OUTLIVES a sign-out, so there is no reload to clean up behind a
//     flip straight to 'unauthenticated' — the exit <Redirect> would race a wipe that
//     still has decrypted bookmarks in sqlite and plaintext blobs on disk;
//   - for the same reason, the react-query cache must be cleared explicitly: nothing else
//     ever empties it, and its account-scoped reads are keyed by CONSTANTS, so the next
//     account inherits the previous one's subscription answer.
//
// Two modules are stubbed and nothing else: `clearData` (so the wipe can be held open,
// which is what makes the ordering observable) and the session store, whose real
// implementation reaches secure-store. The stub keeps the one behaviour the provider leans
// on — `notifySessionInvalid` fans out WITHOUT deduping, so the burst-collapse test is
// measuring this provider and not a fake that collapsed the burst for it.

import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';

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
    // No deduping — the real store's contract, and the thing this provider has to fix.
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
    // Never read here — the provider deliberately keeps key material out of React state,
    // which is half of what this file asserts by never needing a real one.
    encryptionKey: new Uint8Array(32),
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
    <View>
      <Text testID="status">{value.status}</Text>
      <Text testID="username">{value.username ?? '-'}</Text>
      <Text testID="reason">{value.reason ?? '-'}</Text>
    </View>
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

const status = () => screen.getByTestId('status').props.children;
const textOf = (id: string) => screen.getByTestId(id).props.children;

beforeEach(async () => {
  statuses = [];
  releaseWipe = undefined;
  mockClearData.mockClear();
  mockClearData.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        if (releaseWipe === undefined) resolve();
        else releaseWipe = () => resolve();
      }),
  );
  await clearSession();
});

describe('hydration', () => {
  it('starts at loading, so no screen flashes a signed-out state on cold start', async () => {
    renderProvider();

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('unauthenticated'));
  });

  it('adopts a live persisted session', async () => {
    await saveSession(session());

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(textOf('username')).toBe('alice');
    expect(textOf('reason')).toBe('-');
  });

  // 'expired' is what sends the user to /sign-in?next= instead of home — the difference
  // between resuming where they were and losing the screen they were on.
  it('records `expired` for a stored session whose token has lapsed', async () => {
    await saveSession(session({ expiresAt: Date.now() - 1 }));

    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(textOf('reason')).toBe('expired');
  });

  it('leaves the reason null on a launch that never had a session', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(textOf('reason')).toBe('-');
  });

  // THE INTERRUPTED-EXIT GAP, and it is wider here than on web: clearData's table wipe is
  // one transaction, but the file-system deletes cannot join it, so a launch killed
  // mid-clear leaves orphan PLAINTEXT blobs on disk with no rows pointing at them. Running
  // the wipe on every resolution to signed-out — not only on an expired session — is what
  // catches them on the next launch.
  it('wipes the device even when there was no session to expire', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });

  it('resolves to signed-out if hydration itself fails', async () => {
    (loadSession as jest.Mock).mockRejectedValueOnce(new Error('secure-store unavailable'));

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
    expect(textOf('username')).toBe('bob');
    expect(getSession()?.username).toBe('bob');
  });

  it('clears the previous end reason', async () => {
    await saveSession(session({ expiresAt: Date.now() - 1 }));
    renderProvider();
    await waitFor(() => expect(textOf('reason')).toBe('expired'));

    await act(async () => void (await auth.setSession(session())));

    expect(textOf('reason')).toBe('-');
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

  // THE ORDERING, and the reason this file exists: nothing on a device observes the phase
  // today, so deleting it breaks nothing visible — until the first auto-navigating effect
  // lands. It is observable here, at the state machine, which is where the rule lives.
  it('closes the gate before the wipe, and redirects only after it', async () => {
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
    // …and it passed THROUGH 'ending' rather than jumping straight there: flipping to
    // 'unauthenticated' up front fires the exit <Redirect> against a store that still holds
    // decrypted bookmarks and on-disk plaintext, and this process outlives the sign-out, so
    // no reload cleans up behind it.
    expect(statuses).toEqual(['ending', 'unauthenticated']);
  });

  it('drops the username and the persisted session', async () => {
    await act(async () => void (await auth.endSession()));

    expect(textOf('username')).toBe('-');
    expect(getSession()).toBeNull();
  });

  it('records a deliberate sign-out by default and the caller’s reason when given one', async () => {
    await act(async () => void (await auth.endSession()));
    expect(textOf('reason')).toBe('signed-out');

    await act(async () => void (await auth.setSession(session())));
    await act(async () => void (await auth.endSession('expired')));
    expect(textOf('reason')).toBe('expired');
  });

  // The third per-account store, and the one the device wipe cannot reach. It bites harder
  // here than on web: the process outlives the sign-out, so nothing else ever empties it,
  // and the account-scoped reads are keyed by constants rather than by user.
  it('clears the query cache, which the device wipe cannot reach', async () => {
    const cleared = jest.spyOn(queryClient, 'clear');

    await act(async () => void (await auth.endSession()));

    expect(cleared).toHaveBeenCalled();
  });

  // Both clears run regardless of which one rejects — a failed device wipe must not leave
  // the user stuck signed in with a dead session and no way out.
  it('still reaches signed-out when the wipe fails', async () => {
    mockClearData.mockRejectedValueOnce(new Error('database is locked'));

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

  it('signs out as `expired` when the api client reports an invalid session', async () => {
    await act(async () => {
      notifySessionInvalid();
      await Promise.resolve();
    });

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(textOf('reason')).toBe('expired');
  });

  // The store fans out every notification without deduping, on purpose — collapsing the
  // burst is THIS module's job. Two concurrent failing requests must be one sign-out, not
  // two overlapping wipes of the same tables and files.
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

  // …but the guard resets. A latch that stuck would leave the next expiry undetected for
  // the life of the process — which, on this platform, is the life of the app.
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
