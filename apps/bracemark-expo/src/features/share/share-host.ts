// The one platform-split control the share screen needs from its native host:
// dismiss the sheet. Both requires are LAZY (inside the call) on purpose —
// expo-share-extension's JS binds an iOS-only native module at import time,
// and BracemarkShare (modules/bracemark-share) is Android-only; a static import of
// either would throw on the other platform's bundle.

import { Platform } from 'react-native';

export function closeShareSheet(): void {
  if (Platform.OS === 'ios') {
    const { close } = require('expo-share-extension') as { close: () => void };
    close();
    return;
  }

  const { requireNativeModule } = require('expo-modules-core') as {
    requireNativeModule: (name: string) => { close: () => void };
  };
  requireNativeModule('BracemarkShare').close();
}
