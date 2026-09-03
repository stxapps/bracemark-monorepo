// Specs for the session store — the in-memory mirror every synchronous consumer reads,
// and the IndexedDB copy that survives a reload.
//
// Two behaviours here are load-bearing and neither announces itself when broken:
//
//   - `getToken` WITHHOLDS an expired token while `getSession` still returns the record.
//     That asymmetry is the point (session-store.ts): the bearer token is stale, but the
//     non-extractable `encryptionKey` still decrypts this device's cached data offline.
//     Collapse the two and you either send known-401 requests forever, or you lose
//     offline reads the moment a token lapses.
//   - `notifySessionInvalid` is a PURE FAN-OUT with no deduping, because the subscriber
//     (auth-provider) owns the lifecycle being guarded. A store that quietly collapsed
//     the second notification would make a real double-failure invisible to whoever
//     later needs to see it.
//
// The persistence half is asserted on a real `CryptoKey` rather than a stand-in, because
// the whole reason this store is IndexedDB and not localStorage is that a non-extractable
// key cannot be serialized to a string — and structured clone has to give it back still
// non-extractable. A plain object would pass a test that the real record fails.
//
// A RELOAD is spelled as a module reset, which is what it actually is: the IndexedDB row
// survives, the module-scope mirror does not. Faking it by nulling the mirror some other
// way would test a state the app never reaches.

import {
  clearSession,
  getSession,
  getToken,
  notifySessionInvalid,
  onSessionInvalid,
  saveSession,
  type SessionRecord,
} from './session-store';

const HOUR = 60 * 60 * 1000;

// A real non-extractable AES-GCM key — the thing that forced IndexedDB on this store.
function newKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function record(patch: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  return {
    username: 'alice',
    token: 'tok_live',
    expiresAt: Date.now() + HOUR,
    encryptionKey: await newKey(),
    ...patch,
  };
}

// A page reload: the persisted row is still there, the module-scope mirror is gone.
function afterReload(): typeof import('./session-store') {
  jest.resetModules();
  return require('./session-store') as typeof import('./session-store');
}

beforeEach(async () => {
  await clearSession();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getSession / getToken', () => {
  it('are null with no session', () => {
    expect(getSession()).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('serve a live session synchronously, with no await', async () => {
    const session = await record();
    await saveSession(session);

    expect(getSession()).toEqual(session);
    expect(getToken()).toBe('tok_live');
  });

  // THE ASYMMETRY. The token is withheld (sending it would just earn a 401), but the
  // record — and with it the encryption key — stays available so cached data still
  // decrypts offline.
  it('withholds an expired token while keeping the record and its key', async () => {
    const session = await record({ expiresAt: Date.now() - 1 });
    await saveSession(session);

    expect(getToken()).toBeNull();
    expect(getSession()?.encryptionKey).toBe(session.encryptionKey);
  });

  // The boundary is `<=`: a token expiring exactly now is already useless.
  it('treats a token expiring exactly now as expired', async () => {
    const now = Date.now();
    await saveSession(await record({ expiresAt: now }));
    jest.spyOn(Date, 'now').mockReturnValue(now);

    expect(getToken()).toBeNull();
  });
});

describe('persistence', () => {
  // The reason this store exists at all: a reload must not force the user back through
  // the password + Argon2id derivation.
  it('reloads a saved session — key included — across a reload', async () => {
    await saveSession(await record());

    const store = afterReload();
    const loaded = await store.loadSession();

    expect(loaded?.username).toBe('alice');
    expect(loaded?.token).toBe('tok_live');
    expect(loaded?.encryptionKey).toBeInstanceOf(CryptoKey);
  });

  // The property that ruled out localStorage AND ruled out re-importing the key on load:
  // structured clone returns the CryptoKey itself, still non-extractable — so script on
  // this origin can use it in-page but cannot exfiltrate its bytes.
  it('returns the key still non-extractable after a round trip', async () => {
    await saveSession(await record());

    const loaded = await afterReload().loadSession();

    const key = loaded?.encryptionKey;
    expect(key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow();
  });

  // Hydration is the point of loadSession: the auth provider calls it once, and every
  // synchronous reader (the api client's auth header) works off the mirror thereafter.
  it('hydrates the synchronous mirror as a side effect of loading', async () => {
    await saveSession(await record());

    const store = afterReload();
    expect(store.getSession()).toBeNull();
    await store.loadSession();

    expect(store.getToken()).toBe('tok_live');
  });

  // One active session at a time — a second account signing in on this device replaces
  // the first rather than leaving two rows for a load to choose between.
  it('replaces the stored session rather than accumulating sessions', async () => {
    await saveSession(await record());
    await saveSession(await record({ username: 'bob', token: 'tok_bob' }));

    expect((await afterReload().loadSession())?.username).toBe('bob');
  });

  it('clears both the mirror and the persisted copy', async () => {
    await saveSession(await record());

    await clearSession();

    expect(getSession()).toBeNull();
    expect(await afterReload().loadSession()).toBeNull();
  });
});

describe('onSessionInvalid', () => {
  // The api client signals; it never mutates session state. This is the wire that lets
  // it stay a pure reader while the provider stays the sole writer.
  it('notifies every subscriber', () => {
    const first = jest.fn();
    const second = jest.fn();
    const offFirst = onSessionInvalid(first);
    const offSecond = onSessionInvalid(second);

    notifySessionInvalid();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
    offSecond();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = jest.fn();
    const off = onSessionInvalid(listener);

    off();
    notifySessionInvalid();

    expect(listener).not.toHaveBeenCalled();
  });

  // A pure fan-out on purpose: two concurrent failing requests really do fire twice, and
  // collapsing that here would hide it from the subscriber that owns the decision.
  it('fans out every notification without deduping', () => {
    const listener = jest.fn();
    const off = onSessionInvalid(listener);

    notifySessionInvalid();
    notifySessionInvalid();

    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
