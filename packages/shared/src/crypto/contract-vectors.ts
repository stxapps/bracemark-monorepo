// Golden test vectors for the FROZEN cross-platform crypto contract (see
// params.ts / salt.ts / doors.ts and docs/account.md). Every platform
// implementation — @stxapps/web-crypto (web/extension) and @stxapps/expo-crypto
// (Expo/native) — asserts these same values in its specs, so "web and native
// derive identical keys" is a test, not a review promise.
//
// FIVE suites assert this table, and they are not interchangeable — each one
// reaches a runtime the others cannot:
//   - `@stxapps/web-crypto` and `@stxapps/expo-crypto` (jest). The two JS
//     implementations. Note that expo's runs against a SHIM:
//     react-native-quick-crypto is mapped onto Node and hash-wasm
//     (expo-crypto src/testing/quick-crypto-node-shim.ts), so what it proves is
//     our param mapping, derivation order and framing — not the C++ that ships.
//   - `@stxapps/shared` (jest). contract-vectors.spec.ts, which pins the
//     generated JSON twin below against this file.
//   - The NATIVE framers, against `blob` — Swift via `swift test` in
//     packages/expo-crypto, Kotlin via `gradlew :stxapps-expo-crypto:test`. Both
//     read the JSON, neither needs a device.
//   - ON DEVICE, through `e2e/mobile/contract/vectors.yaml` — the dev-only
//     /contract-vectors screen in bracemark-expo, which is the only place
//     quick-crypto's real Argon2id/HKDF/AES-GCM ever meets these bytes.
//
// The device leg is also the only one that can catch a drift the web⇄mobile
// contract runs cannot: those prove the two platforms agree with EACH OTHER, so
// params changed on both in one release round-trip perfectly and still lock
// every existing user out of their data.
//
// ONE LIMIT remains — NOTHING RUNS ANY OF THEM AUTOMATICALLY. They gate only
// what someone runs locally. What runs on its own, if anything, is
// docs/testing.md's record to keep, not this file's.
//
// TEST FIXTURE ONLY — nothing here is a secret and nothing here is used at
// runtime. The values were produced by the real web-crypto pipeline
// (hash-wasm Argon2id + Web Crypto HKDF/AES-GCM + @noble/ed25519), with the
// account proven end-to-end through unlockAccount. The DEK and IVs are FIXED so
// the derived values are reproducible; real accounts mint them from a CSPRNG.
//
// Like the parameters they pin, these values can never change: a differing
// output on any platform means that platform locks users out of their data.

export const CRYPTO_CONTRACT_VECTOR = {
  username: 'Alice_01',
  password: 'correct horse battery staple',

  // deriveUserSalt(username) = SHA-256(APP_SALT ‖ canonical username)
  saltHex: '98e95dc7304a736ba531b62f6edb29669177b241eb41c0f2731009a78a292504',

  // password-KEK = Argon2id(password, salt) under ARGON2_PARAMS
  kekHex: 'fc99df8a9f7a8af7e27d1b39ac6c3acb6cf3cf536166bbb670aa51ad09043491',

  // The fixed account root for this vector (real DEKs are random).
  dekHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',

  // HKDF(DEK, info=HKDF_INFO_AUTH_SEED / HKDF_INFO_ENCRYPTION_KEY), empty salt.
  authSeedHex: 'ab08a88b64b1e0ddbfe8258859ca18f9027aa8465ac68be85933544743057df4',
  encryptionKeyHex: 'fd85a72937230f58aa2a0d1ca1de765e4e3be7033197a6a5a003d80a0208cdae',

  // Ed25519 public key derived from authSeed — what the server stores as the
  // credential — and a deterministic signature over signPayload.
  publicKeyHex: '8e7819544a5f3a4b2f8917760b84f4b98b3ece1be024e20246ba8b1595c8fd5f',
  signPayload: 'bracemark-contract-test-payload',
  signatureHex:
    'b7d383767d0d90fa9cd06090f840ef5155f366cbb21009b1b0fcc950b11ea2b4' +
    '70601d4fde3d76faa1dff3041a8f2c2b3b883e0c5edd922fb6edcf0ab0629a0f',

  // The password door: AES-256-GCM(KEK, DEK, aad = dekWrapAad('password')) with
  // this fixed IV — an `account_keys` row. wrappedDek includes the 16-byte tag.
  passwordDoor: {
    ivHex: 'a0a1a2a3a4a5a6a7a8a9aaab',
    wrappedDekHex:
      '24106632c4ca3a31b4a752f93e8319d55bd73618b39b6b6abac97e580351da24' +
      '657548c5af7a0d27da7e16b836c2670b',
  },

  // The RECOVERY door: a fixed recovery code (already in normalized/canonical
  // form — Crockford base32, uppercase, no separators), its HKDF-derived KEK, and
  // the DEK wrapped under it. recovery-KEK = HKDF-SHA256(utf8(code), salt=∅,
  // info=HKDF_INFO_RECOVERY_KEK, 32B); recoveryDoor =
  // AES-256-GCM(recovery-KEK, DEK, aad = dekWrapAad('recovery')) with this fixed
  // IV. Wraps the SAME fixed DEK as passwordDoor — both doors open one root.
  recovery: {
    code: '40GJ48S44MK2EA1958NJRB9E5WR32CHK6GTKCDSR74X3PF1X7RZG',
    kekHex: 'b4048426b46c824368479b47e4347f88e523efd4a1172ed1a564c128fc7051ae',
    ivHex: 'c0c1c2c3c4c5c6c7c8c9caca',
    wrappedDekHex:
      'c48b882d891fa2eb7c2727ddc7bb94ebaf9640cf45fde1589fe18f2b2e57178c' +
      '70b6d2ae4aa82f43a00ce4ac0fe9238d',
  },

  // Pins the generated-passphrase wordlist (generatePassphrase). It is NOT a
  // derivation input, but if the list ever changed, the same click would map to
  // different words — a silent entropy-space drift across platforms/releases.
  // sha256 over the newline-joined 2048-word @scure/bip39 English list.
  wordlist: {
    length: 2048,
    sha256Hex: '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae',
  },

  // A packed v1 sync blob `[BLOB_FORMAT_V1 || iv || ciphertext+tag]` of
  // `plaintext` under encryptionKeyHex, sealed with AAD = blobAad(path) =
  // `aadHex` (crypto/blob-aad.ts) — exactly what a client uploads to R2 and
  // what the native file module must produce/consume. It opens under `path` and
  // under no other. Asserted by both JS framers (web-crypto/expo-crypto
  // blob.ts) AND both native ones (packages/expo-crypto ios/BlobFrame.swift,
  // android BlobFrame.kt, which read the JSON twin, on the host under
  // `swift test` and the JVM) — four implementations of one frame, one vector —
  // and on device through quick-crypto's AES-GCM by the `/contract-vectors`
  // screen.
  blob: {
    path: 'links/contract-vector.enc',
    ivHex: 'b0b1b2b3b4b5b6b7b8b9babb',
    plaintext: 'Hello, bracemark! contract vector v1',
    aadHex: '016c696e6b732f636f6e74726163742d766563746f722e656e63',
    packedHex:
      '01b0b1b2b3b4b5b6b7b8b9babbc39e5fb1cd31df39f560ba2ccb91c0b9f19a22d' +
      'dbb4f3055fa4466d0a5e74eb1544ded59902334afcf82c4ee221797e551790684',
  },

  // canonicalizePassword (params.ts: trim + NFC) on inputs where engines could
  // differ — composition, Hangul, exclusions, astral code points, and what
  // `trim` does and does not strip. Each input is given as code points (hex)
  // so the source bytes are unambiguous; the output is the UTF-8 the KDF eats.
  // Produced by Node's ICU. An engine that disagrees on any row derives a
  // different key from the same password typed on another device, with no way
  // back: the on-device screen holds Hermes (iOS and Android, whose
  // `normalize` goes through different libraries) to these rows.
  passwordCanonical: [
    { input: '0063 0061 0066 00e9', utf8Hex: '636166c3a9' },
    { input: '0063 0061 0066 0065 0301', utf8Hex: '636166c3a9' },
    { input: 'ac00', utf8Hex: 'eab080' },
    { input: '1100 1161', utf8Hex: 'eab080' },
    { input: '00c5', utf8Hex: 'c385' },
    { input: '0041 030a', utf8Hex: 'c385' },
    { input: '212b', utf8Hex: 'c385' },
    { input: 'fb01 006c 0069 0067', utf8Hex: 'efac816c6967' },
    { input: 'ff21 0066 0077', utf8Hex: 'efbca16677' },
    { input: '0065 0323 0301', utf8Hex: 'e1bab9cc81' },
    { input: '017f 0323 0307', utf8Hex: 'e1ba9bcca3' },
    { input: '005a 0323 0307', utf8Hex: 'e1ba92cc87' },
    { input: '0928 093c', utf8Hex: 'e0a4a9' },
    { input: '0958', utf8Hex: 'e0a495e0a4bc' },
    { input: '1f600 0065', utf8Hex: 'f09f988065' },
    { input: '00a0 006e 0062 00a0', utf8Hex: '6e62' },
    { input: '3000 0069 3000', utf8Hex: '69' },
    { input: '200b 007a', utf8Hex: 'e2808b7a' },
    { input: 'feff 0062', utf8Hex: '62' },
    { input: '0070 0020 0077', utf8Hex: '702077' },
    { input: '0009 0054 000a', utf8Hex: '54' },
    { input: '2028 006c', utf8Hex: '6c' },
    { input: '180e 006d', utf8Hex: 'e1a08e6d' },
  ],
} as const;

// A passwordCanonical row's input as a string.
export function codePointsToString(codePoints: string): string {
  return String.fromCodePoint(...codePoints.split(' ').map((hex) => parseInt(hex, 16)));
}
