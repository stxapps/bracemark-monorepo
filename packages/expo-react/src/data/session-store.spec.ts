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

type SessionStore = typeof import('./session-store');
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

const record = (overrides: Partial<import('./session-store').SessionRecord> = {}) => ({
  username: 'alice',
  token: 'token-1',
  expiresAt: Date.now() + 60_000,
  encryptionKey: new Uint8Array([1, 2, 3, 255, 0, 128]),
  ...overrides,
});

const seedPersisted = (r = record()) => {
  mockSecureEntries.set(
    SESSION_KEY,
    JSON.stringify({
      username: r.username,
      token: r.token,
      expiresAt: r.expiresAt,
      encryptionKeyHex: bytesToHex(r.encryptionKey),
    }),
  );
};

test('saveSession then loadSession round-trips the record, key bytes intact', async () => {
  const r = record();
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

test('getToken returns the token while valid and withholds it once expired', async () => {
  await store.saveSession(record({ expiresAt: Date.now() + 60_000 }));
  expect(store.getToken()).toBe('token-1');

  await store.saveSession(record({ expiresAt: Date.now() - 1 }));
  expect(store.getToken()).toBeNull();
});

test('getSession is not expiry-gated (key still decrypts offline)', async () => {
  const r = record({ expiresAt: Date.now() - 1 });
  await store.saveSession(r);

  expect(store.getSession()).toEqual(r);
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

const SHARED_MIRROR_KEY = 'group.com.bracemark.app/bracemark-session';

test('saveSession mirrors the serialized session into the shared Keychain', async () => {
  await store.saveSession(record());

  expect(mockSharedKeychain.get(SHARED_MIRROR_KEY)).toBe(mockSecureEntries.get(SESSION_KEY));
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
  const r = record();
  mockSharedKeychain.set(
    SHARED_MIRROR_KEY,
    JSON.stringify({
      username: r.username,
      token: r.token,
      expiresAt: r.expiresAt,
      encryptionKeyHex: bytesToHex(r.encryptionKey),
    }),
  );

  expect(await store.loadSharedSession()).toEqual(r);
  // The api client's synchronous readers see it — the extension runs no
  // AuthProvider to hydrate them otherwise.
  expect(store.getSession()).toEqual(r);
  expect(store.getToken()).toBe(r.token);
});

test('loadSharedSession is null (not a throw) on a missing or corrupt mirror', async () => {
  expect(await store.loadSharedSession()).toBeNull();

  mockSharedKeychain.set(SHARED_MIRROR_KEY, 'not-json{');
  expect(await store.loadSharedSession()).toBeNull();
  // Never deletes: the main app owns the entry's lifecycle.
  expect(mockSharedKeychain.has(SHARED_MIRROR_KEY)).toBe(true);
});

test('onSessionInvalid fans out to subscribers; unsubscribe stops delivery', () => {
  const a = jest.fn();
  const b = jest.fn();
  const offA = store.onSessionInvalid(a);
  store.onSessionInvalid(b);

  store.notifySessionInvalid();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);

  offA();
  store.notifySessionInvalid();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);
});
