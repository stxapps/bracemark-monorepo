import { pbkdf2, randomBytes } from 'react-native-quick-crypto';

import { bytesToHex, hexToBytes, utf8 } from '@stxapps/shared';

// Password VERIFIER for the device-local app/list locks — the Expo sibling of
// web-crypto's lock-verifier.ts: store salt+hash, check by re-deriving — the
// password itself is never persisted. Verifiers are device-local (wiped on
// sign-out, never synced), so unlike the account pipeline there's no
// cross-platform byte contract to pin; the KDF parameters and the hex encoding
// just mirror web's, so the two files read as one.
//
// Deliberately PBKDF2, not the account's Argon2id: a lock gates ALREADY-DECRYPTED
// data sitting on the device, so it's a shoulder-surfing deterrent, not
// encryption — a memory-hard KDF buys no real protection there, and unlocking a
// list should feel instant, not cost the sign-in's ~1–3s. The callback form of
// quick-crypto's pbkdf2 runs the C++ fastpbkdf2 off the JS thread (the native
// counterpart of web's non-blocking crypto.subtle.deriveBits).

export interface LockVerifier {
  // hex; random per verifier, so equal passwords produce unequal hashes.
  salt: string;
  // hex PBKDF2-SHA256 output.
  hash: string;
}

// OWASP's current PBKDF2-SHA256 recommendation.
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function pbkdf2Async(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    pbkdf2(utf8(password), salt, PBKDF2_ITERATIONS, HASH_BYTES, 'sha256', (err, derived) => {
      if (err || derived === undefined) reject(err ?? new Error('pbkdf2 returned no key'));
      else resolve(new Uint8Array(derived.buffer, derived.byteOffset, derived.length));
    });
  });
}

export async function createLockVerifier(password: string): Promise<LockVerifier> {
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const hash = await pbkdf2Async(password, salt);
  return { salt: bytesToHex(salt), hash: bytesToHex(hash) };
}

export async function verifyLockPassword(
  password: string,
  verifier: LockVerifier,
): Promise<boolean> {
  const hash = await pbkdf2Async(password, hexToBytes(verifier.salt));
  const expected = hexToBytes(verifier.hash);
  if (hash.length !== expected.length) return false;
  // Constant-time compare — cheap to do properly even though a local-only
  // verifier has no realistic timing adversary.
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}
