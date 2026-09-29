// Specs for the session store — the in-memory mirror every synchronous consumer reads,
// and the IndexedDB copy that survives a reload.
//
// The behaviours here that are load-bearing, none of which announces itself when broken:
//
//   - THERE IS NO CLOCK. A record is served, token and key, however old it is — the
//     server decides a session's lifetime and says so with a code (docs/sessions.md).
//     The store this replaced withheld the token after a local `expiresAt`, which is
//     one step from the timed wipe of every library that design is built to prevent.
//   - A pre-redesign record (a stale `expiresAt`, no state, no generation) reads as an
//     ACTIVE session, not a corrupt one — an upgrade must not sign a device out.
//   - `notifySessionVerdict` is a PURE FAN-OUT with no deduping, because the subscriber
//     (auth-provider) owns the lifecycle being guarded.
//   - The lifecycle lock serializes transitions, and the raw session database lets go
//     the moment a newer build asks for it (offline-mode.md, _version skew_).
//
// The persistence half is asserted on a real `CryptoKey` rather than a stand-in, because
// the whole reason this store is IndexedDB and not localStorage is that a non-extractable
// key cannot be serialized to a string — and structured clone has to give it back still
// non-extractable. A plain object would pass a test that the real record fails.
//
// A RELOAD is spelled as a module reset, which is what it actually is: the IndexedDB row
// survives, the module-scope mirror does not.

import {
  clearSession,
  getSession,
  getToken,
  notifySessionVerdict,
  onSessionVerdict,
  peekSession,
  saveSession,
  type SessionRecord,
  withSessionLock,
} from './session-store';
import { isUpdateRequired, resetUpdateRequiredForTests } from './update-required';

const YEAR = 365 * 24 * 60 * 60 * 1000;

// A real non-extractable AES-GCM key — the thing that forced IndexedDB on this store.
function newKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function record(patch: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  return {
    username: 'alice',
    token: 'tok_live',
    encryptionKey: await newKey(),
    state: 'active',
    generation: 'gen-1',
    ...patch,
  };
}

// A page reload: the persisted row is still there, the module-scope mirror is gone.
function afterReload(): typeof import('./session-store') {
  jest.resetModules();
  return require('./session-store') as typeof import('./session-store');
}

// Write a row the way a build from before the session redesign left it.
function putLegacyRow(row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('bracemark-session', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('session');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put(row, 'current');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

beforeEach(async () => {
  await clearSession();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getSession / getToken', () => {
  it('keeps the prior mirror when a replacement cannot be persisted', async () => {
    const previous = await record();
    await saveSession(previous);
    // Functions cannot be structured-cloned into IndexedDB: a real failed put.
    const invalid = {
      ...previous,
      token: 'new',
      encryptionKey: (() => undefined) as unknown as CryptoKey,
    };
    await expect(saveSession(invalid)).rejects.toThrow();
    expect(getSession()).toEqual(previous);
    expect(await peekSession()).toEqual(previous);
  });

  it('keeps the prior mirror when deleting the durable record fails', async () => {
    const previous = await record();
    await saveSession(previous);
    const remove = jest.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() => {
      throw new Error('delete failed');
    });
    await expect(clearSession()).rejects.toThrow('delete failed');
    remove.mockRestore();
    expect(getSession()).toEqual(previous);
    expect(await peekSession()).toEqual(previous);
  });

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

  // THE RULE. No local clock decides anything: a device a year past its sign-in still
  // holds a session, and only the server's answer to that token can change it.
  it('serves the token no matter how much time has passed', async () => {
    await saveSession(await record());
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * YEAR);

    expect(getToken()).toBe('tok_live');
    expect(getSession()?.state).toBe('active');
  });

  // Expired keeps the token (the probe needs it) and the key (the library still opens).
  it('keeps the token and key of an expired session', async () => {
    const session = await record({ state: 'expired' });
    await saveSession(session);

    expect(getToken()).toBe('tok_live');
    expect(getSession()?.encryptionKey).toBe(session.encryptionKey);
  });
});

describe('persistence', () => {
  it('reloads a saved session — key, state and generation included — across a reload', async () => {
    await saveSession(await record({ state: 'expired', generation: 'gen-7' }));

    const loaded = await afterReload().loadSession();

    expect(loaded).toMatchObject({
      username: 'alice',
      token: 'tok_live',
      state: 'expired',
      generation: 'gen-7',
    });
    expect(loaded?.encryptionKey).toBeInstanceOf(CryptoKey);
  });

  // structured clone returns the CryptoKey itself, still non-extractable — so script on
  // this origin can use it in-page but cannot exfiltrate its bytes.
  it('returns the key still non-extractable after a round trip', async () => {
    await saveSession(await record());

    const loaded = await afterReload().loadSession();

    const key = loaded?.encryptionKey;
    expect(key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow();
  });

  it('hydrates the synchronous mirror as a side effect of loading', async () => {
    await saveSession(await record());

    const store = afterReload();
    expect(store.getSession()).toBeNull();
    await store.loadSession();

    expect(store.getToken()).toBe('tok_live');
  });

  // peek is for comparing against the truth without adopting it.
  it('peeks at the persisted record without touching the mirror', async () => {
    await saveSession(await record());
    const store = afterReload();

    expect((await store.peekSession())?.generation).toBe('gen-1');
    expect(store.getSession()).toBeNull();
  });

  // A developer's device from before the redesign: an old `expiresAt` in the past, no
  // state, no generation. Active — with an empty generation the lifecycle owner fills
  // in — and the expiry is dropped, never read.
  it('reads a pre-redesign record as active, whatever its old expiry said', async () => {
    await putLegacyRow({
      username: 'alice',
      token: 'tok_old',
      expiresAt: Date.now() - YEAR,
      encryptionKey: await newKey(),
    });

    const loaded = await afterReload().loadSession();

    expect(loaded).toMatchObject({ username: 'alice', state: 'active', generation: '' });
    expect(loaded).not.toHaveProperty('expiresAt');
  });

  it('never writes a legacy expiry back', async () => {
    await saveSession({ ...(await record()), expiresAt: 1 } as SessionRecord);

    expect(await peekSession()).not.toHaveProperty('expiresAt');
  });

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

describe('onSessionVerdict', () => {
  const event = { verdict: 'expired' as const, generation: 'gen-1' };

  it('notifies every subscriber with the verdict and its generation', () => {
    const first = jest.fn();
    const second = jest.fn();
    const offFirst = onSessionVerdict(first);
    const offSecond = onSessionVerdict(second);

    notifySessionVerdict(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
    offFirst();
    offSecond();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = jest.fn();
    const off = onSessionVerdict(listener);

    off();
    notifySessionVerdict(event);

    expect(listener).not.toHaveBeenCalled();
  });

  // A pure fan-out on purpose: collapsing a burst is the lifecycle owner's decision.
  it('fans out every notification without deduping', () => {
    const listener = jest.fn();
    const off = onSessionVerdict(listener);

    notifySessionVerdict(event);
    notifySessionVerdict(event);

    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('withSessionLock', () => {
  // No Web Locks in this runtime, so this pins the in-context fallback: transitions run
  // one at a time, in order, even when the first is slow and throws.
  it('runs transitions one at a time, in order, past a failure', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = withSessionLock(async () => {
      order.push('a:start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('a:end');
      throw new Error('a failed');
    });
    const next = withSessionLock(async () => {
      order.push('b');
      return 'b done';
    });

    await Promise.resolve();
    release();

    await expect(slow).rejects.toThrow('a failed');
    await expect(next).resolves.toBe('b done');
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });
});

// ⚠ The version-skew guard (docs/offline-mode.md): raw IndexedDB never closes a
// connection on its own, so without the handler a newer build's open of this database
// would block behind this tab — and its auth would never resolve.
describe('a newer build upgrading the session database', () => {
  beforeEach(() => resetUpdateRequiredForTests());

  it('lets go of the connection at once, and reports update-required', async () => {
    await saveSession(await record()); // this "tab" holds an open connection

    const upgraded = await new Promise<number>((resolve, reject) => {
      const open = indexedDB.open('bracemark-session', 2);
      open.onblocked = () => reject(new Error('upgrade blocked by the old connection'));
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const { version } = open.result;
        open.result.close();
        resolve(version);
      };
    });

    expect(upgraded).toBe(2);
    expect(isUpdateRequired()).toBe(true);

    // Leave the database as the next spec file expects it.
    await new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase('bracemark-session');
      del.onsuccess = () => resolve();
      del.onerror = () => resolve();
    });
  });
});
