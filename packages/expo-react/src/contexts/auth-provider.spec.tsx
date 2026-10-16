// A drift guard for the expo auth provider. web-react's auth-provider.spec.tsx is
// canonical for what these transitions mean; the two providers are duplicated source, and
// the header here says the pair "must stay in step" — so a spec that passes on web's copy
// is exactly the thing that proves nothing about this one.
//
// THE RULE (docs/sessions.md) is the main reason it exists now: this provider is the one
// place on the platform that can wipe the device, and it may do so only for an explicit
// sign-out or a `session_revoked` verdict for the generation still persisted here. Expiry
// and an unknown token keep everything; no clock is ever consulted; a verdict for a
// replaced generation does nothing; a failed storage read is not "signed out". Pinned as a
// table below — breaking any of it produces no error anywhere else.
//
// The `'ending'` phase is the other. Nothing on this platform observes it TODAY (this
// client keeps its selection in React state, not a URL), which makes it deletable with no
// visible symptom on a device and re-openable the moment someone adds the first
// auto-navigating effect. It is fully observable HERE. And because the app process
// OUTLIVES a sign-out, the react-query cache must be cleared explicitly — nothing else
// ever empties it.
//
// Two modules are stubbed and nothing else: `clearData` (so the wipe can be held open) and
// the session store, whose real implementation reaches secure-store. The stub keeps what
// the provider leans on: a synchronous mirror over a persisted record, a verdict fan-out
// WITHOUT deduping, and a lifecycle lock that really serializes.

import { useEffect } from 'react';
import { AppState, Text, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import { ApiClientProvider } from '@stxapps/react';
import { type AuthApiClient, sessionProbeEndpoint } from '@stxapps/shared';

import type { SessionRecord } from '../data/session-store';
import * as store from '../data/session-store';
import * as syncStore from '../data/sync-store';
import { AuthProvider, useAuth } from './auth-provider';

interface StoreStub {
  __setPersisted: (record: SessionRecord | null) => void;
  __persisted: () => SessionRecord | null;
}
const stub = store as unknown as typeof store & StoreStub;

jest.mock('../data/session-store', () => {
  let current: SessionRecord | null = null;
  let persisted: SessionRecord | null = null;
  let minted = 0;
  // (The `mock` prefix on these parameter names is only for jest's hoist check.)
  const listeners = new Set<(mockEvent: unknown) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    getSession: () => current,
    saveSession: jest.fn((record: SessionRecord) => {
      current = record;
      persisted = record;
      return Promise.resolve();
    }),
    loadSession: jest.fn(() => {
      current = persisted;
      return Promise.resolve(persisted);
    }),
    clearSession: jest.fn(() => {
      current = null;
      persisted = null;
      return Promise.resolve();
    }),
    activeRecord: (credentials: object) => ({
      ...credentials,
      state: 'active',
      generation: `minted-${++minted}`,
    }),
    onSessionVerdict: (listener: (mockEvent: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // No deduping — the real store's contract, and the thing this provider has to fix.
    notifySessionVerdict: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
    withSessionLock: (run: () => Promise<unknown>) => {
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
    __setPersisted: (record: SessionRecord | null) => {
      persisted = record;
    },
    __persisted: () => persisted,
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
jest.mock('../data/sync-store', () => ({
  seedNewAccount: jest.fn(() => Promise.resolve()),
  beginInitialSync: jest.fn(() => Promise.resolve()),
}));

// The target a sign-out started from signedIn() names: its generation.
const SIGNED_IN = { generation: 'gen-1' };

const YEAR = 365 * 24 * 60 * 60 * 1000;

function session(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    username: 'alice',
    token: 'tok',
    // Never read here — the provider deliberately keeps key material out of React state.
    encryptionKey: new Uint8Array(32),
    state: 'active',
    generation: 'gen-1',
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
      <Text testID="state">{value.sessionState ?? '-'}</Text>
    </View>
  );
}

let queryClient: QueryClient;
let apiCall: jest.Mock;

function renderProvider() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiCall = jest.fn(() => new Promise(() => undefined)); // the probe never answers here
  const api = { call: apiCall } as unknown as AuthApiClient;
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={api}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

const textOf = (id: string) => screen.getByTestId(id).props.children;
const status = () => textOf('status');

async function signedIn(patch: Partial<SessionRecord> = {}) {
  stub.__setPersisted(session(patch));
  renderProvider();
  await waitFor(() => expect(status()).toBe('authenticated'));
  statuses.length = 0;
  mockClearData.mockClear();
}

async function verdict(v: 'revoked' | 'expired', generation = 'gen-1') {
  await act(async () => {
    store.notifySessionVerdict({ verdict: v, generation });
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  statuses = [];
  releaseWipe = undefined;
  jest.clearAllMocks();
  mockClearData.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        if (releaseWipe === undefined) resolve();
        else releaseWipe = () => resolve();
      }),
  );
  stub.__setPersisted(null);
});

describe('hydration', () => {
  it('starts at loading, so nothing flashes a signed-out screen', async () => {
    renderProvider();

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('unauthenticated'));
  });

  it('adopts a persisted session in the state it was persisted with', async () => {
    stub.__setPersisted(session({ state: 'expired' }));

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(textOf('username')).toBe('alice');
    expect(textOf('state')).toBe('expired');
  });

  // THE SPECIMEN: the code this replaced cleared a stored session whose `expiresAt` had
  // passed on the DEVICE clock.
  it('signs a session in however long ago it was minted, and wipes nothing', async () => {
    stub.__setPersisted({ ...session(), expiresAt: Date.now() - YEAR } as SessionRecord);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * YEAR);

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(mockClearData).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('assigns and persists a generation for a pre-redesign record', async () => {
    stub.__setPersisted(session({ generation: '' }));

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(stub.__persisted()?.generation).not.toBe('');
  });

  it('finishes an interrupted teardown when the store has no session', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
    expect(textOf('reason')).toBe('-');
  });

  it('resolves to signed-out WITHOUT wiping if secure-store cannot be read', async () => {
    (store.loadSession as jest.Mock).mockRejectedValueOnce(new Error('keychain unavailable'));

    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).not.toHaveBeenCalled();
  });

  // Startup reads the session store and nothing else for a signed-in account: a
  // wait on the DATA store here (another tab's long transaction, a newer build's
  // upgrade) would hold the app — and the lifecycle lock — for as long as it lasts.
  it('never touches the data store to adopt a persisted session', async () => {
    await signedIn();

    expect(syncStore.beginInitialSync).not.toHaveBeenCalled();
    expect(syncStore.seedNewAccount).not.toHaveBeenCalled();
  });
});

describe('the rule, as a table', () => {
  it('wipes on `session_revoked` for the current generation, and says why', async () => {
    await signedIn();

    await verdict('revoked');

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
    expect(stub.__persisted()).toBeNull();
    expect(textOf('reason')).toBe('revoked');
  });

  it('keeps everything on `session_expired`/`session_unknown`, and pauses', async () => {
    await signedIn();

    await verdict('expired');

    await waitFor(() => expect(textOf('state')).toBe('expired'));
    expect(status()).toBe('authenticated');
    expect(mockClearData).not.toHaveBeenCalled();
    expect(stub.__persisted()).toMatchObject({ state: 'expired', generation: 'gen-1' });
  });

  it.each(['revoked', 'expired'] as const)(
    'ignores `%s` for a generation that is no longer current',
    async (v) => {
      await signedIn({ generation: 'gen-new' });

      await verdict(v, 'gen-old');

      expect(status()).toBe('authenticated');
      expect(textOf('state')).toBe('active');
      expect(mockClearData).not.toHaveBeenCalled();
    },
  );

  it('collapses a burst of revocations into one teardown', async () => {
    await signedIn();

    await act(async () => {
      store.notifySessionVerdict({ verdict: 'revoked', generation: 'gen-1' });
      store.notifySessionVerdict({ verdict: 'revoked', generation: 'gen-1' });
      store.notifySessionVerdict({ verdict: 'revoked', generation: 'gen-1' });
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });
});

describe('the probe', () => {
  it('asks once on launch while expired, and again on return to the foreground', async () => {
    const listeners: ((next: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (next: string) => void);
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    await signedIn({ state: 'expired' });

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith(sessionProbeEndpoint, {});

    act(() => listeners.forEach((listener) => listener('active')));
    expect(apiCall).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('asks nothing while active', async () => {
    await signedIn();

    expect(apiCall).not.toHaveBeenCalled();
  });
});

describe('setSession', () => {
  it('refuses adoption when the previous account cannot be read', async () => {
    await signedIn({ state: 'expired' });
    const failure = new Error('session storage temporarily unavailable');
    (store.loadSession as jest.Mock).mockRejectedValueOnce(failure);

    await act(async () => {
      await expect(auth.setSession(session({ username: 'bob' }))).rejects.toThrow(failure);
    });

    expect(stub.__persisted()).toMatchObject({ username: 'alice', generation: 'gen-1' });
    expect(store.saveSession).not.toHaveBeenCalled();
    expect(mockClearData).not.toHaveBeenCalled();
  });

  it('refuses adoption when the previous account wipe fails', async () => {
    await signedIn();
    const failure = new Error('local data could not be cleared');
    mockClearData.mockRejectedValueOnce(failure);

    await act(async () => {
      await expect(auth.setSession(session({ username: 'bob' }))).rejects.toThrow(failure);
    });

    expect(store.saveSession).not.toHaveBeenCalled();
    expect(stub.__persisted()?.username).not.toBe('bob');
    // Retrying in the same mounted provider must finish the interrupted wipe.
    await act(async () => {
      await auth.setSession(session({ username: 'bob' }));
    });
    expect(mockClearData).toHaveBeenCalledTimes(2);
    expect(stub.__persisted()).toMatchObject({ username: 'bob' });
  });

  // Create-account used to seed its first-sync flag BEFORE setSession — whose
  // account-switch teardown then wiped it. The seed has to land after the old
  // library is gone and before the session that exposes it.
  it('seeds a new account after the previous library is wiped, before persisting it', async () => {
    await signedIn();

    await act(async () => {
      await auth.setSession(session({ username: 'bob' }), { newAccount: true });
    });

    const wiped = Math.max(...mockClearData.mock.invocationCallOrder);
    const seed = syncStore.seedNewAccount as jest.Mock;
    expect(seed).toHaveBeenCalledWith('bob');
    const [seeded] = seed.mock.invocationCallOrder;
    const saved = Math.max(...(store.saveSession as jest.Mock).mock.invocationCallOrder);
    expect(wiped).toBeLessThan(seeded);
    expect(seeded).toBeLessThan(saved);
    expect(syncStore.beginInitialSync).not.toHaveBeenCalledWith('bob');
  });

  // Every local write is fenced on the account's ownership row, and a sync cycle
  // may never create it. A session persisted without it could write nothing.
  it('adopts nothing when claiming the account ownership fails', async () => {
    renderProvider();
    await waitFor(() => expect(status()).toBe('unauthenticated'));
    const failure = new Error('the data store is unavailable');
    (syncStore.beginInitialSync as jest.Mock).mockRejectedValueOnce(failure);

    await act(async () => {
      await expect(auth.setSession(session({ username: 'bob' }))).rejects.toThrow(failure);
    });

    expect(stub.__persisted()).toBeNull();
    expect(status()).toBe('unauthenticated');
  });

  it('persists a fresh active generation and flips to authenticated', async () => {
    renderProvider();
    await waitFor(() => expect(status()).toBe('unauthenticated'));

    await act(async () => void (await auth.setSession(session({ username: 'bob' }))));

    expect(status()).toBe('authenticated');
    expect(textOf('username')).toBe('bob');
    expect(stub.__persisted()?.generation).toMatch(/^minted-/);
  });

  // RESUME: token and generation replaced, state active, local store untouched.
  it('resumes an expired session without touching the local store', async () => {
    await signedIn({ state: 'expired', token: 'tok-old' });

    await act(async () => void (await auth.setSession({ ...session(), token: 'tok-new' })));

    expect(textOf('state')).toBe('active');
    expect(stub.__persisted()).toMatchObject({ token: 'tok-new', state: 'active' });
    expect(mockClearData).not.toHaveBeenCalled();
  });

  it('tears a different account down before adopting a new one', async () => {
    await signedIn();

    await act(async () => void (await auth.setSession(session({ username: 'bob' }))));

    expect(mockClearData).toHaveBeenCalledTimes(1);
    expect(textOf('username')).toBe('bob');
  });
});

describe('endSession', () => {
  beforeEach(async () => {
    await signedIn();
  });

  it('closes the gate before the wipe, and redirects only after it', async () => {
    releaseWipe = () => undefined; // hold the wipe open
    let ended: Promise<void>;
    act(() => {
      ended = auth.endSession(SIGNED_IN);
    });

    await waitFor(() => expect(status()).toBe('ending'));
    await waitFor(() => expect(mockClearData).toHaveBeenCalledTimes(1));

    await act(async () => {
      releaseWipe?.();
      await ended;
    });

    expect(status()).toBe('unauthenticated');
    expect(statuses).toEqual(['ending', 'unauthenticated']);
  });

  // A sign-out names the generation whose token it sent. A resume while its
  // request was in flight replaced that generation, and the replacement survives.
  it('does not let a sign-out of a replaced generation wipe its replacement', async () => {
    await act(async () => void (await auth.setSession(session())));
    mockClearData.mockClear();

    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(stub.__persisted()).toMatchObject({ username: 'alice', state: 'active' });
    expect(stub.__persisted()?.generation).not.toBe('gen-1');
    expect(status()).toBe('authenticated');
    expect(mockClearData).not.toHaveBeenCalled();
  });

  // Delete-account names the account: a resume that raced the deletion was
  // revoked with every other session, so its library goes too.
  it('ends every generation of a deleted account', async () => {
    await act(async () => void (await auth.setSession(session())));
    mockClearData.mockClear();

    await act(async () => void (await auth.endSession({ username: 'alice' })));

    expect(stub.__persisted()).toBeNull();
    expect(mockClearData).toHaveBeenCalledTimes(1);
    expect(status()).toBe('unauthenticated');
  });

  it('never ends another account adopted since', async () => {
    await act(async () => void (await auth.setSession(session({ username: 'bob' }))));
    mockClearData.mockClear();

    await act(async () => void (await auth.endSession({ username: 'alice' })));

    expect(stub.__persisted()).toMatchObject({ username: 'bob' });
    expect(status()).toBe('authenticated');
    expect(mockClearData).not.toHaveBeenCalled();
  });

  it('does not wipe data when deletion of the session record fails', async () => {
    const failure = new Error('session deletion failed');
    (store.clearSession as jest.Mock).mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(auth.endSession(SIGNED_IN)).rejects.toThrow(failure);
    });
    expect(mockClearData).not.toHaveBeenCalled();
    expect(stub.__persisted()).toMatchObject({ username: 'alice' });
    expect(status()).toBe('authenticated');
  });

  it('drops the username and the persisted session, and records a deliberate sign-out', async () => {
    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(textOf('username')).toBe('-');
    expect(stub.__persisted()).toBeNull();
    expect(textOf('reason')).toBe('signed-out');
  });

  it('clears the query cache, which nothing else in this process ever empties', async () => {
    const cleared = jest.spyOn(queryClient, 'clear');

    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(cleared).toHaveBeenCalled();
  });

  it('still reaches signed-out when the wipe fails', async () => {
    mockClearData.mockRejectedValueOnce(new Error('sqlite is gone'));

    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(status()).toBe('unauthenticated');
    expect(stub.__persisted()).toBeNull();
  });
});

describe('useAuth', () => {
  it('refuses to be used outside the provider', () => {
    const noise = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow(/AuthProvider/);

    noise.mockRestore();
  });
});
