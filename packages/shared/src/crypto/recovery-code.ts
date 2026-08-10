// The recovery code: a high-entropy CSPRNG secret that backs the RECOVERY door
// (docs/account.md — "the doors"). Unlike the password (low-entropy, user-chosen,
// Argon2id-hardened), the recovery code is generated with ≥256 bits of entropy,
// so its KEK is a cheap HKDF (deriveRecoveryKek, in the platform crypto package),
// not Argon2id. "Security floor = the weakest door", so we GENERATE it and never
// let users type their own — this module is the generator + the input normalizer.
//
// Pure and platform-agnostic → lives in `shared`: web and the future Expo/native
// client must produce/parse the identical form or a code minted on one platform
// won't unwrap the DEK on another. The KEK derivation (frozen contract) runs over
// the NORMALIZED string bytes (utf8), so the canonical form defined here — not
// the grouped display form — is what both platforms hash.
//
// Encoding is Crockford base32 (@scure/base): uppercase, and its alphabet already
// excludes the visually ambiguous I L O U, so a code is read/typed back with far
// fewer transcription errors than raw hex or RFC-4648 base32.
import { base32crockford } from '@scure/base';

// 256 bits of entropy — the wallet reference point (docs/account.md). 32 CSPRNG
// bytes; Crockford base32 encodes them to 52 chars.
export const RECOVERY_CODE_BYTES = 32;

// Display grouping: 52 chars split into blocks of this size, hyphen-joined, so
// the shown code reads like "A1B2C-D3E4F-…". Purely cosmetic — normalize() strips
// the hyphens before the code is ever used as key material.
const GROUP_SIZE = 5;

// Generate a fresh recovery code: 32 CSPRNG bytes → Crockford base32 → grouped
// for display. Uses the standard `crypto.getRandomValues` global (never
// Math.random). The returned string is what we SHOW; feed it (or user input)
// through normalizeRecoveryCode before deriving the KEK.
export function generateRecoveryCode(): string {
  const raw = base32crockford.encode(crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES)));
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP_SIZE) groups.push(raw.slice(i, i + GROUP_SIZE));
  return groups.join('-');
}

// Canonicalize a recovery code (generated or user-entered) into the exact string
// whose utf8 bytes deriveRecoveryKek hashes. This is part of the FROZEN contract:
// every platform must normalize identically or a valid code fails to unwrap.
//
//   - uppercase, drop hyphens/whitespace (the display grouping is not entropy);
//   - map the Crockford confusables a reader might type — O→0, I/L→1 — back to
//     the canonical digits (the alphabet never emits I L O, so this only ever
//     REPAIRS human input; a generated code is unchanged by it).
//
// Anything still outside the alphabet is left as-is: a wrong character yields a
// wrong KEK and the GCM tag fails (correctly, "invalid recovery code"), rather
// than being silently swallowed here.
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
}
