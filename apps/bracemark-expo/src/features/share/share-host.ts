// The one control the share screen needs from its native host: dismiss the
// sheet. Both hosts answer to the same module, `BracemarkShare`
// (modules/bracemark-share) — Android's finishes the ShareActivity, iOS's
// completes the share extension's request through its controller — so this is
// one call on both platforms.
//
// The require is LAZY (inside the call) so that importing this file binds no
// native module: jest and the main app's bundle import the share tree without
// ever closing a sheet.

export function closeShareSheet(): void {
  const { requireNativeModule } = require('expo-modules-core') as {
    requireNativeModule: (name: string) => { close: () => void };
  };
  requireNativeModule('BracemarkShare').close();
}
