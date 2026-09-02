import { sha256 } from '@noble/hashes/sha2';

import { CRYPTO_CONTRACT_VECTOR } from './contract-vectors';
import { bytesToHex, utf8 } from './encoding';
import { APP_SALT, canonicalizeUsername } from './params';
import { deriveUserSalt } from './salt';

// `deriveUserSalt` is FROZEN: it feeds the Argon2id KEK, so a salt that shifts by
// one byte re-derives every key and locks every user out of their own data
// permanently (there is no password reset — docs/account.md). Two kinds of test
// follow, and both are needed.
//
// The GOLDEN VECTOR pins the bytes. `@stxapps/web-crypto` and `@stxapps/expo-crypto`
// already assert this same `saltHex`, which is what proves the two platforms agree
// — but the function LIVES here, and neither of those suites runs when someone
// changes this package. `npx nx test @stxapps/shared` now catches the drift at the
// source rather than in a package that merely imports it.
//
// The EQUIVALENCE CLASS is the half no contract-vector spec reaches: they each pin
// one username, so nothing anywhere pinned that a user who types their handle
// differently than they did at signup still derives the same salt. That is the
// difference between signing in and being locked out, and it rests entirely on
// `canonicalizeUsername` being applied here.

const V = CRYPTO_CONTRACT_VECTOR;

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

describe('deriveUserSalt', () => {
  it('reproduces the frozen contract vector', () => {
    expect(bytesToHex(deriveUserSalt(V.username))).toBe(V.saltHex);
  });

  it('returns a fixed 32 bytes, well clear of Argon2’s 8-byte minimum', () => {
    // Fixed-width whatever the username is — the SHA-256 also hides the raw
    // handle's length, which a bare `utf8(username)` salt would leak.
    for (const username of ['abc', 'a'.repeat(32), V.username]) {
      expect(deriveUserSalt(username)).toHaveLength(32);
    }
  });

  it('is deterministic — no randomness, nothing stored server-side', () => {
    expect(deriveUserSalt(V.username)).toEqual(deriveUserSalt(V.username));
  });

  // Every spelling the same account can be typed as must land on ONE salt. The
  // server stores the canonical handle, so these are all the same account; if any
  // of them derived a different salt, that user's password would stop opening
  // their door depending on how they typed their name.
  it.each([
    ['as stored', 'Alice_01'],
    ['lowercased', 'alice_01'],
    ['shouted', 'ALICE_01'],
    ['padded', '  Alice_01  '],
    ['padded and lowercased', '\talice_01\n'],
    ['fullwidth (NFKC folds it)', 'Ａｌｉｃｅ＿０１'],
  ])('derives the vector’s salt from the same handle typed %s', (_label, username) => {
    expect(bytesToHex(deriveUserSalt(username))).toBe(V.saltHex);
  });

  it('gives different users different salts — the point of folding the handle in', () => {
    // Two users who choose the SAME password must not share a KEK; the username
    // is the only per-user input, since nothing salt-related is stored.
    const salts = ['alice_01', 'alice_02', 'bob', 'alice'].map((u) =>
      bytesToHex(deriveUserSalt(u)),
    );
    expect(new Set(salts).size).toBe(salts.length);
  });

  it('folds APP_SALT in, so the salt is namespaced to this app', () => {
    // Dropping the domain separator would still produce a plausible 32-byte salt
    // and a working sign-in on a fresh account — it only stops defending against
    // tables precomputed for the bare username. The vector above catches it too;
    // this says WHAT broke when it fails.
    const withoutAppSalt = sha256(utf8(canonicalizeUsername(V.username)));
    expect(bytesToHex(deriveUserSalt(V.username))).not.toBe(bytesToHex(withoutAppSalt));
  });

  it('is byte-identical to hashing the two UTF-8 pieces separately', () => {
    // The implementation concatenates the STRINGS before encoding, and the source
    // comment claims that is equivalent to concatenating their utf8 bytes (true
    // because UTF-8 encodes each code point independently). A future port —
    // native, or a streaming hasher — is free to take the byte-concatenation
    // route; this pins that the two spellings cannot diverge.
    const byBytes = sha256(concat(utf8(APP_SALT), utf8(canonicalizeUsername(V.username))));
    expect(bytesToHex(deriveUserSalt(V.username))).toBe(bytesToHex(byBytes));
  });
});
