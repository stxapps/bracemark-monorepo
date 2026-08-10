import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

// Keychain items under an EXPLICIT access group — the one Keychain capability
// expo-secure-store doesn't expose (it hardcodes its query and offers no
// access-group option), so it gets its own BracemarkSharedKeychain native module in
// the BracemarkCrypto pod. This backs the share sheet's upload
// (docs/share-sheet.md): the main app mirrors the session into a group both
// processes can read, so the iOS share extension can encrypt + PUT without
// opening the app's sqlite or Keychain.
//
// `group` is an App Group id (e.g. `group.com.bracemark.app`): iOS accepts App Group
// ids as keychain access groups, so the App Group entitlement the app and the
// extension already share (expo-share-extension's plugin writes it into both
// targets) covers this — no keychain-sharing entitlement, no team-id prefix.
// Items are stored AFTER_FIRST_UNLOCK, matching the session-store entry they
// mirror.
//
// iOS-ONLY BY NATURE: Android's share surface runs in the app's own process and
// reads the real session store, so nothing needs a cross-process keychain — the
// module is registered under `apple.modules` only, with no Kotlin counterpart.
// Rather than making every caller platform-fork, the wrappers degrade to the
// "item absent" semantics off iOS: get resolves null, set/delete resolve as
// no-ops. The Platform check must stay AHEAD of getNative() — on Android there
// is no such module to resolve, so requireNativeModule would throw.

interface NativeSharedKeychain {
  setSharedKeychainItem(group: string, key: string, value: string): Promise<void>;
  getSharedKeychainItem(group: string, key: string): Promise<string | null>;
  deleteSharedKeychainItem(group: string, key: string): Promise<void>;
}

// Resolved lazily so merely importing this package never touches the native
// runtime (same rule as file-crypto.ts).
let native: NativeSharedKeychain | undefined;
function getNative(): NativeSharedKeychain {
  return (native ??= requireNativeModule<NativeSharedKeychain>('BracemarkSharedKeychain'));
}

export async function setSharedKeychainItem(
  group: string,
  key: string,
  value: string,
): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await getNative().setSharedKeychainItem(group, key, value);
}

export async function getSharedKeychainItem(group: string, key: string): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  return await getNative().getSharedKeychainItem(group, key);
}

export async function deleteSharedKeychainItem(group: string, key: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await getNative().deleteSharedKeychainItem(group, key);
}
