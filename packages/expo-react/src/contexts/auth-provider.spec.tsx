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
import { type ApiClient, sessionProbeEndpoint } from '@stxapps/shared';

import type { SessionRecord } from '../data/session-store';
import * as store from '../data/session-store';
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
  const api = { call: apiCall } as unknown as ApiClient;
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
      ended = auth.endSession();
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

  it('drops the username and the persisted session, and records a deliberate sign-out', async () => {
    await act(async () => void (await auth.endSession()));

    expect(textOf('username')).toBe('-');
    expect(stub.__persisted()).toBeNull();
    expect(textOf('reason')).toBe('signed-out');
  });

  it('clears the query cache, which nothing else in this process ever empties', async () => {
    const cleared = jest.spyOn(queryClient, 'clear');

    await act(async () => void (await auth.endSession()));

    expect(cleared).toHaveBeenCalled();
  });

  it('still reaches signed-out when the wipe fails', async () => {
    mockClearData.mockRejectedValueOnce(new Error('sqlite is gone'));

    await act(async () => void (await auth.endSession()));

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
