import { bytesToHex } from '@stxapps/shared';

// In-memory stand-ins for the native stores. Keyed maps/sets outside the
// factories (mock-prefixed so jest's hoisting allows the reference) so each test
// can seed/inspect them directly.
const mockSecureEntries = new Map<string, string>();
const mockFiles = new Set<string>();
const mockSharedKeychain = new Map<string, string>();

// The shared-Keychain trio backing the iOS session mirror. Mocked at the SUBPATH
// the module imports (@stxapps/expo-crypto/lib/shared-keychain, not the package
// barrel) — session-store names the file so the extension's cold path stays
// clear of the AES stack; see its import comment.
jest.mock('@stxapps/expo-crypto/lib/shared-keychain', () => ({
  setSharedKeychainItem: jest.fn(async (group: string, key: string, value: string) => {
    mockSharedKeychain.set(`${group}/${key}`, value);
  }),
  getSharedKeychainItem: jest.fn(
    async (group: string, key: string) => mockSharedKeychain.get(`${group}/${key}`) ?? null,
  ),
  deleteSharedKeychainItem: jest.fn(async (group: string, key: string) => {
    mockSharedKeychain.delete(`${group}/${key}`);
  }),
}));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async (key: string) => mockSecureEntries.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureEntries.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureEntries.delete(key);
  }),
}));

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents/' },
  File: class MockFile {
    uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join('');
    }
    get exists(): boolean {
      return mockFiles.has(this.uri);
    }
    create(): void {
      mockFiles.add(this.uri);
    }
  },
}));

const SESSION_KEY = 'bracemark-session';
const SENTINEL_URI = 'file:///documents/bracemark-install-sentinel';
const SHARED_MIRROR_KEY = 'group.com.bracemark.app/bracemark-session';
const YEAR = 365 * 24 * 60 * 60 * 1000;

type SessionStore = typeof import('./session-store');
type SessionRecord = import('./session-store').SessionRecord;
type SecureStoreMock = typeof import('expo-secure-store');

let store: SessionStore;
let secureStore: SecureStoreMock;

// Fresh module per test: `current` and the listener set are module-level state,
// and the fresh-install tests need a pristine mirror. requireActual/requireMock
// instead of dynamic import() — babel-preset-expo keeps import() native, which
// jest's VM can't execute.
beforeEach(() => {
  mockSecureEntries.clear();
  mockFiles.clear();
  mockSharedKeychain.clear();
  jest.resetModules();
  store = jest.requireActual<SessionStore>('./session-store');
  secureStore = jest.requireMock<SecureStoreMock>('expo-secure-store');
});

afterEach(() => {
  jest.restoreAllMocks();
});

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  username: 'alice',
  token: 'token-1',
  encryptionKey: new Uint8Array([1, 2, 3, 255, 0, 128]),
  state: 'active',
  generation: 'gen-1',
  ...overrides,
});

const serialized = (r: SessionRecord) =>
  JSON.stringify({
    username: r.username,
    token: r.token,
    encryptionKeyHex: bytesToHex(r.encryptionKey),
    state: r.state,
    generation: r.generation,
  });

const seedPersisted = (r = record()) => mockSecureEntries.set(SESSION_KEY, serialized(r));

test.each(['save', 'clear'] as const)(
  'keeps the prior mirror when a durable %s fails',
  async (operation) => {
    const previous = record();
    await store.saveSession(previous);
    const failure = new Error('secure store unavailable');
    if (operation === 'save') {
      jest.mocked(secureStore.setItemAsync).mockRejectedValueOnce(failure);
      await expect(store.saveSession(record({ token: 'new' }))).rejects.toThrow(failure);
    } else {
      jest.mocked(secureStore.deleteItemAsync).mockRejectedValueOnce(failure);
      await expect(store.clearSession()).rejects.toThrow(failure);
    }
    expect(store.getSession()).toEqual(previous);
    expect(await store.loadSession()).toEqual(previous);
    expect(mockSharedKeychain.get(SHARED_MIRROR_KEY)).toBe(serialized(previous));
  },
);

test('saveSession then loadSession round-trips the record — key bytes, state and generation', async () => {
  const r = record({ state: 'expired', generation: 'gen-7' });
  await store.saveSession(r);

  const loaded = await store.loadSession();
  expect(loaded).toEqual(r);
  expect(loaded?.encryptionKey).toBeInstanceOf(Uint8Array);
});

test('saveSession writes with AFTER_FIRST_UNLOCK and marks the install sentinel', async () => {
  await store.saveSession(record());

  expect(secureStore.setItemAsync).toHaveBeenCalledWith(SESSION_KEY, expect.any(String), {
    keychainAccessible: 'afterFirstUnlock',
  });
  expect(mockFiles.has(SENTINEL_URI)).toBe(true);
});

test('fresh install (no sentinel) wipes a Keychain leftover and reads signed-out', async () => {
  seedPersisted();

  expect(await store.loadSession()).toBeNull();
  expect(store.getSession()).toBeNull();
  expect(mockSecureEntries.has(SESSION_KEY)).toBe(false);
  expect(mockFiles.has(SENTINEL_URI)).toBe(true);
});

test('with the sentinel present, loadSession hydrates the persisted session', async () => {
  const r = record();
  seedPersisted(r);
  mockFiles.add(SENTINEL_URI);

  expect(await store.loadSession()).toEqual(r);
  expect(store.getSession()).toEqual(r);
});

// THE RULE (docs/sessions.md): no local clock decides anything. The store this
// replaced withheld the token after a local `expiresAt` — one step from the timed
// wipe of every library.
test('getSession serves the token however much time has passed', async () => {
  await store.saveSession(record());
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * YEAR);

  expect(store.getSession()?.token).toBe('token-1');
});

// Expired keeps the token (the probe needs it) and the key (the library opens).
test('an expired session keeps its token and key', async () => {
  const r = record({ state: 'expired' });
  await store.saveSession(r);

  expect(store.getSession()?.token).toBe('token-1');
  expect(store.getSession()?.encryptionKey).toEqual(r.encryptionKey);
});

// A dev device from before the redesign: an old `expiresAt`, no state, no
// generation. parse() used to REQUIRE `expiresAt`; now a record without state is
// active — with an empty generation the lifecycle owner assigns — never corrupt.
test('a pre-redesign record reads as active, whatever its old expiry said', async () => {
  mockFiles.add(SENTINEL_URI);
  mockSecureEntries.set(
    SESSION_KEY,
    JSON.stringify({
      username: 'alice',
      token: 'token-old',
      expiresAt: Date.now() - YEAR,
      encryptionKeyHex: bytesToHex(new Uint8Array([9])),
    }),
  );

  const loaded = await store.loadSession();

  expect(loaded).toMatchObject({ username: 'alice', state: 'active', generation: '' });
  expect(loaded).not.toHaveProperty('expiresAt');
  expect(mockSecureEntries.has(SESSION_KEY)).toBe(true);
});

test('a record carries no expiry when written', async () => {
  await store.saveSession(record());

  expect(JSON.parse(mockSecureEntries.get(SESSION_KEY) ?? '{}')).not.toHaveProperty('expiresAt');
});

test('clearSession drops both the mirror and the persisted entry', async () => {
  await store.saveSession(record());
  await store.clearSession();

  expect(store.getSession()).toBeNull();
  expect(mockSecureEntries.has(SESSION_KEY)).toBe(false);
  expect(await store.loadSession()).toBeNull();
});

test('a corrupt persisted entry reads as signed-out and is deleted', async () => {
  mockFiles.add(SENTINEL_URI);
  mockSecureEntries.set(SESSION_KEY, 'not-json{');
  // A mirror that outlived the app's own entry — the divergent case: it must not
  // leave the extension signed in against an app that reads signed-out.
  mockSharedKeychain.set(SHARED_MIRROR_KEY, 'stale-mirror');

  expect(await store.loadSession()).toBeNull();
  expect(mockSecureEntries.has(SESSION_KEY)).toBe(false);
  expect(mockSharedKeychain.has(SHARED_MIRROR_KEY)).toBe(false);
});

test('a well-formed entry with missing fields reads as signed-out', async () => {
  mockFiles.add(SENTINEL_URI);
  mockSecureEntries.set(SESSION_KEY, JSON.stringify({ username: 'alice' }));

  expect(await store.loadSession()).toBeNull();
});

// The iOS share extension reads the mirror — and its STATE, instead of a clock.
test('saveSession mirrors the serialized session, state included, into the shared Keychain', async () => {
  await store.saveSession(record({ state: 'expired' }));

  expect(mockSharedKeychain.get(SHARED_MIRROR_KEY)).toBe(mockSecureEntries.get(SESSION_KEY));
  expect(JSON.parse(mockSharedKeychain.get(SHARED_MIRROR_KEY) ?? '{}')).toMatchObject({
    state: 'expired',
  });
});

test('clearSession and the fresh-install wipe both drop the shared mirror', async () => {
  await store.saveSession(record());
  await store.clearSession();
  expect(mockSharedKeychain.has(SHARED_MIRROR_KEY)).toBe(false);

  // Fresh install: seed a leftover mirror alongside the Keychain leftover.
  mockFiles.clear();
  seedPersisted();
  mockSharedKeychain.set(SHARED_MIRROR_KEY, 'stale-mirror');
  expect(await store.loadSession()).toBeNull();
  expect(mockSharedKeychain.has(SHARED_MIRROR_KEY)).toBe(false);
});

test('loadSharedSession reads the mirror and hydrates the in-memory session', async () => {
  const r = record({ state: 'expired' });
  mockSharedKeychain.set(SHARED_MIRROR_KEY, serialized(r));

  expect(await store.loadSharedSession()).toEqual(r);
  // The api client's synchronous reader sees it — the extension runs no
  // AuthProvider to hydrate it otherwise.
  expect(store.getSession()).toEqual(r);
});

test('loadSharedSession is null (not a throw) on a missing or corrupt mirror', async () => {
  expect(await store.loadSharedSession()).toBeNull();

  mockSharedKeychain.set(SHARED_MIRROR_KEY, 'not-json{');
  expect(await store.loadSharedSession()).toBeNull();
  // Never deletes: the main app owns the entry's lifecycle.
  expect(mockSharedKeychain.has(SHARED_MIRROR_KEY)).toBe(true);
});

test('onSessionVerdict fans out to subscribers without deduping; unsubscribe stops delivery', () => {
  const a = jest.fn();
  const b = jest.fn();
  const offA = store.onSessionVerdict(a);
  store.onSessionVerdict(b);
  const event = { verdict: 'revoked' as const, generation: 'gen-1' };

  store.notifySessionVerdict(event);
  store.notifySessionVerdict(event);
  expect(a).toHaveBeenCalledTimes(2);
  expect(a).toHaveBeenCalledWith(event);

  offA();
  store.notifySessionVerdict(event);
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(3);
});

test('withSessionLock runs transitions one at a time, in order, past a failure', async () => {
  const order: string[] = [];
  let release!: () => void;
  const first = store.withSessionLock(async () => {
    order.push('a:start');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push('a:end');
    throw new Error('a failed');
  });
  const second = store.withSessionLock(async () => {
    order.push('b');
  });

  await Promise.resolve();
  release();
  await expect(first).rejects.toThrow('a failed');
  await second;

  expect(order).toEqual(['a:start', 'a:end', 'b']);
});

test('activeRecord mints an active record with a fresh generation', () => {
  const credentials = { username: 'alice', token: 't', encryptionKey: new Uint8Array([1]) };

  const a = store.activeRecord(credentials);
  const b = store.activeRecord(credentials);

  expect(a.state).toBe('active');
  expect(a.generation).not.toBe('');
  expect(a.generation).not.toBe(b.generation);
});
