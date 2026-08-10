// ID helpers — the Expo sibling of web-crypto's ids.ts. React Native has no
// crypto.randomUUID global, so this comes from quick-crypto's native CSPRNG;
// same UUID v4 format as every other platform's newId.
//
// THE REQUIRE IS LAZY, and this is the one file in the package where that
// matters. `newId` is all the iOS share extension needs from @stxapps/expo-crypto
// on its cold path, and a static import would put quick-crypto's ~390KB of JS —
// plus readable-stream, buffer and nitro-modules — into the init of a process
// that is re-created on every share (docs/share-sheet.md, _keep index.share.js
// lean_). Behind the call it lands on the first Save instead, where the encrypt
// that follows it needs the module anyway. Memoized because bulk import mints
// ids in a loop: after the first call this is a plain function reference, not a
// module lookup per id.
let randomUUID: (() => string) | null = null;

export function newId(): string {
  randomUUID ??= (
    require('react-native-quick-crypto') as typeof import('react-native-quick-crypto')
  ).randomUUID;
  return randomUUID();
}
