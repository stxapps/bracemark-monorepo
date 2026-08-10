# @stxapps/expo-crypto

The Expo/native sibling of `@stxapps/web-crypto` (`type:crypto`,
`platform:expo`): the same account derivation pipeline and AES-256-GCM
primitives, implemented on React Native.

- **Heavy compute runs native.** Argon2id, HKDF, and AES-GCM go through
  `react-native-quick-crypto` (C++ JSI/Nitro). Ed25519 stays on
  `@noble/ed25519` — the exact library web uses — because signing is
  microseconds and sharing the implementation makes credential drift
  structurally impossible.
- **File-level encryption never enters JS.** The bundled `BracemarkFileCrypto`
  Expo native module (`ios/`, `android/`) encrypts/decrypts whole files
  path-to-path in the native layer, producing the frozen v1 blob frame
  `[0x01 || iv(12) || ciphertext+tag]` — byte-compatible with the blobs the
  web client packs/unpacks in JS.
- **Shared-Keychain access the way expo-secure-store can't.** The iOS-only
  `BracemarkSharedKeychain` module reads/writes generic-password items under an
  explicit access group (an App Group id), which is what lets the share
  extension — a separate process — see the session the app mirrors there.
  See `lib/shared-keychain.ts` and docs/share-sheet.md. Both modules ship in
  one pod, `BracemarkCrypto`.
- **The frozen contract lives in `@stxapps/shared`** (`crypto/params.ts`,
  `salt.ts`, `doors.ts`): APP_SALT, ARGON2_PARAMS, HKDF labels, the blob
  frame constants. This package only implements them; specs assert the
  golden vectors from `@stxapps/shared` so web and native can never diverge.

Requires a dev client / `expo prebuild` (native code — not Expo Go).
