import { sha256 } from '@noble/hashes/sha256';

import { APP_SALT, canonicalizeUsername } from './params';

// Per-user Argon2 salt: SHA-256(APP_SALT ‖ canonical username). Folding the
// unique username in means two users who pick the same password still derive
// different keys, without storing anything server-side — any client recomputes
// it from (username, password) alone. SHA-256 gives a fixed 32-byte salt
// (Argon2 needs ≥8) and hides the raw username length/bytes. The username is a
// public, deterministic salt — it de-duplicates identical passwords, but the
// real cost against a targeted attacker is Argon2id's memory-hardness.
//
// This lives in `shared` (platform-agnostic), not in `@stxapps/web-crypto`,
// because the salt is part of the FROZEN cross-platform contract (see
// params.ts): web, extension, and the future Expo/native client must all
// produce byte-identical salts or a user is locked out of their data on a
// different device. Implemented with @noble/hashes (pure JS, no Web Crypto /
// native runtime needed) so the single function runs unchanged everywhere —
// drift is structurally impossible rather than a promise to keep in sync.
// Concatenating the strings before encoding is byte-identical to
// utf8(APP_SALT) ‖ utf8(username), since UTF-8 encodes each char independently.
export function deriveUserSalt(username: string): Uint8Array {
  return sha256(APP_SALT + canonicalizeUsername(username));
}
