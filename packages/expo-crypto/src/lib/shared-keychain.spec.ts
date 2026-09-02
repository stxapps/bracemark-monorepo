// Keychain items under an explicit App Group — the cross-process channel the iOS
// share extension reads the session from (docs/share-sheet.md).
//
// The module is registered under `apple.modules` ONLY: there is no Kotlin
// counterpart, because Android's share surface runs in the app's own process and
// reads the real session store. Rather than make every caller platform-fork, the
// wrappers degrade to "item absent" off iOS — and that only works if the
// `Platform.OS` check stays AHEAD of `getNative()`. Reorder those two lines and
// Android doesn't return null: `requireNativeModule` THROWS on a module that was
// never registered, so a session mirror that is meant to be a no-op takes down
// whatever called it. Nothing types or lints that ordering, and no Android build
// is involved in `npm run test`, so this spec is the only thing between the two
// lines and a shipped crash.
const mockNative = {
  setSharedKeychainItem: jest.fn(async () => undefined),
  getSharedKeychainItem: jest.fn(async () => null as string | null),
  deleteSharedKeychainItem: jest.fn(async () => undefined),
};

// Stands in for the real thing on both counts: it hands back the module on iOS,
// and it THROWS the way expo-modules-core does for a module the platform never
// registered — so a wrapper that resolved before checking fails here loudly.
const mockRequireNativeModule = jest.fn((name: string) => {
  if (mockPlatform.OS !== 'ios') throw new Error(`Cannot find native module '${name}'`);
  return mockNative;
});
const mockPlatform = { OS: 'ios' };

jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) => mockRequireNativeModule(name),
}));

const GROUP = 'group.com.bracemark.app';

// Fresh registry per test: the resolved module handle is memoized at module
// scope, so a leftover one from an iOS test would mask an off-iOS resolution.
const freshKeychain = async (os: string) => {
  jest.resetModules();
  jest.clearAllMocks();
  mockPlatform.OS = os;
  return import('./shared-keychain');
};

describe('on iOS', () => {
  it('writes an item under the given App Group', async () => {
    const { setSharedKeychainItem } = await freshKeychain('ios');

    await setSharedKeychainItem(GROUP, 'session', '{"userId":"u1"}');

    expect(mockNative.setSharedKeychainItem).toHaveBeenCalledWith(
      GROUP,
      'session',
      '{"userId":"u1"}',
    );
  });

  it('returns the stored value, and null when there is nothing stored', async () => {
    const { getSharedKeychainItem } = await freshKeychain('ios');

    mockNative.getSharedKeychainItem.mockResolvedValueOnce('{"userId":"u1"}');
    await expect(getSharedKeychainItem(GROUP, 'session')).resolves.toBe('{"userId":"u1"}');

    mockNative.getSharedKeychainItem.mockResolvedValueOnce(null);
    await expect(getSharedKeychainItem(GROUP, 'session')).resolves.toBeNull();
    expect(mockNative.getSharedKeychainItem).toHaveBeenLastCalledWith(GROUP, 'session');
  });

  it('deletes an item — the sign-out half of the mirror', async () => {
    const { deleteSharedKeychainItem } = await freshKeychain('ios');

    await deleteSharedKeychainItem(GROUP, 'session');

    expect(mockNative.deleteSharedKeychainItem).toHaveBeenCalledWith(GROUP, 'session');
  });

  it('resolves the native module once, on first use, not at import', async () => {
    const { getSharedKeychainItem, setSharedKeychainItem } = await freshKeychain('ios');
    expect(mockRequireNativeModule).not.toHaveBeenCalled();

    await setSharedKeychainItem(GROUP, 'session', 'v');
    await getSharedKeychainItem(GROUP, 'session');

    expect(mockRequireNativeModule).toHaveBeenCalledTimes(1);
    expect(mockRequireNativeModule).toHaveBeenCalledWith('BracemarkSharedKeychain');
  });
});

describe('off iOS', () => {
  // There is no such native module on Android, so these must not merely return
  // the right value — they must never REACH the resolution.
  it('reads as "item absent" without resolving a module that does not exist', async () => {
    const { getSharedKeychainItem } = await freshKeychain('android');

    await expect(getSharedKeychainItem(GROUP, 'session')).resolves.toBeNull();
    expect(mockRequireNativeModule).not.toHaveBeenCalled();
  });

  it('writes as a no-op without resolving a module that does not exist', async () => {
    const { setSharedKeychainItem } = await freshKeychain('android');

    await expect(setSharedKeychainItem(GROUP, 'session', 'v')).resolves.toBeUndefined();
    expect(mockRequireNativeModule).not.toHaveBeenCalled();
    expect(mockNative.setSharedKeychainItem).not.toHaveBeenCalled();
  });

  it('deletes as a no-op without resolving a module that does not exist', async () => {
    const { deleteSharedKeychainItem } = await freshKeychain('android');

    await expect(deleteSharedKeychainItem(GROUP, 'session')).resolves.toBeUndefined();
    expect(mockRequireNativeModule).not.toHaveBeenCalled();
    expect(mockNative.deleteSharedKeychainItem).not.toHaveBeenCalled();
  });
});
