/**
 * @jest-environment jsdom
 */
// Specs for the web auth provider — the lifecycle owner, and so the one place that can
// wipe this device. What it has to get right produces no error when it goes wrong:
//
// 1. THE RULE (docs/sessions.md). Session handling wipes only for an explicit sign-out,
//    or a `session_revoked` verdict for the generation still persisted here. An expired
//    or unknown session KEEPS everything and enters the expired state; a verdict for a
//    replaced generation does nothing; no clock is consulted, ever; and a failed storage
//    read is not "signed out". Pinned as a table below.
//
// 2. THE `'ending'` PHASE. The teardown flips to 'ending' BEFORE the wipe, so the
//    signed-in subtree unmounts while the store still has data in it (the links page once
//    read its own `?list=` as deleted and fired `router.replace` into AuthGuard's exit
//    navigation — docs/data-lifecycle.md, _the sign-out teardown_). It must not flip
//    straight to 'unauthenticated' either: that starts the exit navigation mid-wipe.
//
// 3. FINISHING AN INTERRUPTED TEARDOWN — the wipe on a load that finds no session — and
//    only when the absence was actually read.
//
// Two modules are stubbed and nothing else: `clearData`, because WHEN it runs relative to
// the status flips is the subject (so it has to be holdable open), and the session store,
// whose IndexedDB half needs a `structuredClone` jsdom doesn't have. The stub keeps what
// the provider leans on: a synchronous mirror over a persisted record, a verdict fan-out
// WITHOUT deduping (so a burst-collapse test measures the provider), and a lifecycle lock
// that really serializes.

import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';

import { ApiClientProvider } from '@stxapps/react';
import { type ApiClient, sessionProbeEndpoint } from '@stxapps/shared';

import type { SessionRecord } from '../data/session-store';
import * as store from '../data/session-store';
import * as syncStore from '../data/sync-store';
import { AuthProvider, useAuth } from './auth-provider';

// Test-only handles on the stub below.
interface StoreStub {
  __setPersisted: (record: SessionRecord | null) => void;
  __persisted: () => SessionRecord | null;
  __emitChange: (message: store.SessionChangeMessage) => void;
}
const stub = store as unknown as typeof store & StoreStub;

jest.mock('../data/session-store', () => {
  let current: SessionRecord | null = null;
  let persisted: SessionRecord | null = null;
  let minted = 0;
  // (Parameter names in these types carry the `mock` prefix only because jest's hoist
  // check reads them as out-of-scope variables otherwise.)
  const verdictListeners = new Set<(mockEvent: unknown) => void>();
  const changeListeners = new Set<(mockMessage: unknown) => void>();
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
    peekSession: jest.fn(() => Promise.resolve(persisted)),
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
      verdictListeners.add(listener);
      return () => verdictListeners.delete(listener);
    },
    // No deduping — the real store's contract, and the thing the provider has to fix.
    notifySessionVerdict: (event: unknown) => {
      for (const listener of verdictListeners) listener(event);
    },
    onSessionChange: (listener: (mockMessage: unknown) => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    publishSessionChange: jest.fn(),
    withSessionLock: (run: () => Promise<unknown>) => {
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
    __setPersisted: (record: SessionRecord | null) => {
      persisted = record;
    },
    __persisted: () => persisted,
    __emitChange: (message: unknown) => {
      for (const listener of changeListeners) listener(message);
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
    encryptionKey: {} as CryptoKey,
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
    <div>
      <span data-testid="status">{value.status}</span>
      <span data-testid="username">{value.username ?? '-'}</span>
      <span data-testid="reason">{value.reason ?? '-'}</span>
      <span data-testid="state">{value.sessionState ?? '-'}</span>
    </div>
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

const text = (id: string) => screen.getByTestId(id).textContent;
const status = () => text('status');

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
  mockClearData.mockClear();
  jest.clearAllMocks();
  stub.__setPersisted(null);
});

describe('hydration', () => {
  it('starts at loading, so nothing flashes a signed-out state', async () => {
    renderProvider();

    expect(status()).toBe('loading');
    await waitFor(() => expect(status()).toBe('unauthenticated'));
  });

  it('adopts a persisted session, in the state it was persisted with', async () => {
    stub.__setPersisted(session({ state: 'expired' }));

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(text('username')).toBe('alice');
    expect(text('state')).toBe('expired');
    expect(text('reason')).toBe('-');
  });

  // THE SPECIMEN (docs/sessions.md): the code this replaced cleared a stored session
  // whose `expiresAt` had passed on the DEVICE clock — a timed delete of every library.
  it('signs a session in however long ago it was minted, and wipes nothing', async () => {
    stub.__setPersisted({ ...session(), expiresAt: Date.now() - YEAR } as SessionRecord);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * YEAR);

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(text('state')).toBe('active');
    expect(mockClearData).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  // A record from before the redesign reads with an empty generation; the owner assigns
  // one under the lock and persists it — an ACTIVE session, not a corrupt one.
  it('assigns and persists a generation for a pre-redesign record', async () => {
    stub.__setPersisted(session({ generation: '' }));

    renderProvider();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(stub.__persisted()?.generation).not.toBe('');
    expect(store.saveSession).toHaveBeenCalledTimes(1);
  });

  it('leaves the reason null when there was never a session', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(text('reason')).toBe('-');
  });

  // THE INTERRUPTED-EXIT GAP. The teardown is several independent clears, so a tab closed
  // mid-wipe can leave DECRYPTED bookmarks behind with no session row — which is exactly
  // the state this path sees.
  it('finishes an interrupted teardown when the store has no session', async () => {
    renderProvider();

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });

  // A storage read failure is not proof the device was signed out.
  it('resolves to signed-out WITHOUT wiping if the session store cannot be read', async () => {
    (store.loadSession as jest.Mock).mockRejectedValueOnce(new Error('IndexedDB unavailable'));

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
    expect(text('reason')).toBe('revoked');
  });

  it('keeps everything on `session_expired`/`session_unknown`, and pauses', async () => {
    await signedIn();

    await verdict('expired');

    await waitFor(() => expect(text('state')).toBe('expired'));
    expect(status()).toBe('authenticated');
    expect(mockClearData).not.toHaveBeenCalled();
    // Persisted, so a relaunch doesn't repeat a cycle it already knows will fail.
    expect(stub.__persisted()).toMatchObject({ state: 'expired', generation: 'gen-1' });
  });

  // ⚠ A verdict belongs to the session that sent the request. After a resume (a new
  // generation), a delayed answer for the old token must not touch the new session.
  it.each(['revoked', 'expired'] as const)(
    'ignores `%s` for a generation that is no longer current',
    async (v) => {
      await signedIn({ generation: 'gen-new' });

      await verdict(v, 'gen-old');

      expect(status()).toBe('authenticated');
      expect(text('state')).toBe('active');
      expect(mockClearData).not.toHaveBeenCalled();
      expect(stub.__persisted()).toMatchObject({ state: 'active', generation: 'gen-new' });
    },
  );

  // The probe's point: an expired device can still hear a retained revocation.
  it('wipes an EXPIRED session on `session_revoked` for its generation', async () => {
    await signedIn({ state: 'expired' });

    await verdict('revoked');

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });

  // Concurrent failing requests each fire a verdict (the store fans out without
  // deduping); the lock makes the second find the work done.
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

  it('collapses a burst of expiries into one write', async () => {
    await signedIn();

    await act(async () => {
      store.notifySessionVerdict({ verdict: 'expired', generation: 'gen-1' });
      store.notifySessionVerdict({ verdict: 'expired', generation: 'gen-1' });
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(text('state')).toBe('expired'));
    expect(store.saveSession).toHaveBeenCalledTimes(1);
  });

  it('can be revoked again after a later sign-in', async () => {
    await signedIn();
    await verdict('revoked');
    await waitFor(() => expect(status()).toBe('unauthenticated'));

    await act(async () => void (await auth.setSession(session())));
    mockClearData.mockClear();
    const generation = stub.__persisted()?.generation as string;

    await verdict('revoked', generation);

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });
});

describe('the probe', () => {
  it('asks once on launch while expired', async () => {
    await signedIn({ state: 'expired' });

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith(sessionProbeEndpoint, {});
  });

  it('asks nothing while active', async () => {
    await signedIn();

    expect(apiCall).not.toHaveBeenCalled();
  });

  it('asks again on return to the foreground', async () => {
    await signedIn({ state: 'expired' });
    apiCall.mockClear();

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(apiCall).toHaveBeenCalledTimes(1);
  });
});

describe('setSession', () => {
  it('refuses adoption when the previous account cannot be read', async () => {
    await signedIn({ state: 'expired' });
    const failure = new Error('session storage temporarily unavailable');
    (store.peekSession as jest.Mock).mockRejectedValueOnce(failure);

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
    expect(text('username')).toBe('bob');
    expect(text('state')).toBe('active');
    expect(stub.__persisted()?.generation).toMatch(/^minted-/);
    // Every other context sharing the record is told to re-read it (never the token).
    expect(store.publishSessionChange).toHaveBeenCalledWith({
      generation: stub.__persisted()?.generation,
    });
  });

  // RESUME: the same username signs in again from the expired state. Token and
  // generation replaced, state active — and the local store, queued edits included,
  // untouched.
  it('resumes an expired session without touching the local store', async () => {
    await signedIn({ state: 'expired', token: 'tok-old' });

    await act(async () => void (await auth.setSession({ ...session(), token: 'tok-new' })));

    expect(text('state')).toBe('active');
    expect(stub.__persisted()).toMatchObject({ token: 'tok-new', state: 'active' });
    expect(stub.__persisted()?.generation).not.toBe('gen-1');
    expect(mockClearData).not.toHaveBeenCalled();
  });

  // A different account's library must be gone before a new account is adopted over it.
  it('tears a different account down before adopting a new one', async () => {
    await signedIn();

    await act(async () => void (await auth.setSession(session({ username: 'bob' }))));

    expect(mockClearData).toHaveBeenCalledTimes(1);
    expect(text('username')).toBe('bob');
    expect(status()).toBe('authenticated');
  });

  it('clears the previous end reason', async () => {
    await signedIn();
    await verdict('revoked');
    await waitFor(() => expect(text('reason')).toBe('revoked'));

    await act(async () => void (await auth.setSession(session())));

    expect(text('reason')).toBe('-');
  });
});

describe('endSession', () => {
  beforeEach(async () => {
    await signedIn();
  });

  // THE ORDERING. 'ending' has to be observable BEFORE the wipe resolves, and
  // 'unauthenticated' only after.
  it('closes the gate before the wipe, and navigates only after it', async () => {
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

  // The record goes before the data: if the wipe is interrupted, the next load finds
  // no session and finishes it.
  it('drops the session record before the data, and announces it', async () => {
    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(text('username')).toBe('-');
    expect(stub.__persisted()).toBeNull();
    expect(store.publishSessionChange).toHaveBeenCalledWith({
      generation: null,
      reason: 'signed-out',
    });
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

  it('records a deliberate sign-out by default', async () => {
    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(text('reason')).toBe('signed-out');
  });

  // The third per-account store, and the one clearData can't reach.
  it('clears the query cache, which the device wipe cannot reach', async () => {
    const cleared = jest.spyOn(queryClient, 'clear');

    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(cleared).toHaveBeenCalled();
  });

  it('still reaches signed-out when the wipe fails', async () => {
    mockClearData.mockRejectedValueOnce(new Error('IndexedDB is gone'));

    await act(async () => void (await auth.endSession(SIGNED_IN)));

    expect(status()).toBe('unauthenticated');
    expect(stub.__persisted()).toBeNull();
  });
});

describe('another context changed the session', () => {
  // The other context already wiped; this one only closes its UI — no second wipe that
  // could land on an account adopted in between.
  it('closes this context when another one tore the session down', async () => {
    await signedIn();
    stub.__setPersisted(null);

    await act(async () => {
      stub.__emitChange({ generation: null, reason: 'revoked' });
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(status()).toBe('unauthenticated'));
    expect(text('reason')).toBe('revoked');
    expect(mockClearData).not.toHaveBeenCalled();
  });

  // A resume in another tab: this tab picks up the new state and keeps its data.
  it('adopts a resume from another context', async () => {
    await signedIn({ state: 'expired' });
    stub.__setPersisted(session({ generation: 'gen-2', token: 'tok-2' }));

    await act(async () => {
      stub.__emitChange({ generation: 'gen-2' });
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(text('state')).toBe('active'));
    expect(store.getSession()?.token).toBe('tok-2');
    expect(mockClearData).not.toHaveBeenCalled();
  });

  it('re-reads the record on return to the foreground', async () => {
    await signedIn();
    stub.__setPersisted(session({ state: 'expired' }));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(text('state')).toBe('expired'));
  });
});

describe('useAuth', () => {
  it('refuses to be used outside the provider', () => {
    const noise = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow(/AuthProvider/);

    noise.mockRestore();
  });
});
