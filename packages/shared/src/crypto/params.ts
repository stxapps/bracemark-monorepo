// Cross-platform crypto parameters: key derivation and the encrypted-blob wire
// format. EVERY platform — web, extension, and the future Expo/native client —
// MUST use these exact values: they are the contract that makes one password
// produce the same keys everywhere and one platform's blobs readable on every
// other. Changing a derivation value re-derives every user's keys and locks
// them out of existing data, so they are frozen at launch.
//
// These live in `shared` (platform-agnostic) on purpose — the implementation
// is per-platform (web uses @stxapps/web-crypto), but the numbers must be one
// source of truth shared by all of them.

// App-wide domain separator folded into every per-user salt. The actual Argon2
// salt is per-user — SHA-256(APP_SALT || canonical username) — so two users who
// pick the same password still derive different keys (the unique username is the
// per-user salt). This constant defends against precomputed tables shared across
// apps/users. The salt is deliberately deterministic and public, not a stored
// random value: the wrapped password-door blob is served pre-auth to anyone who
// names a username (docs/account.md — the offline-attack surface), so a random
// salt would ride in that same response and hide nothing; deriving it instead
// keeps salt material out of the server's Tier-0 state, lets the client start
// Argon2id concurrently with the door fetch, and leaves one less frozen value to
// pin cross-platform. Note (username, password) alone recomputes only the
// password-KEK — the account root is a random DEK that additionally needs the
// server-held wrapped door to recover.
//
// NOT a secret — it ships in every client bundle; its only job is to be a
// stable, unique, high-entropy namespace, so it must NEVER CHANGE once real
// users exist (changing it re-derives every key and locks everyone out). The
// `bracemark.app-salt.v1.` prefix is a human-readable version namespace; the
// 256-bit base64url tail is the actual entropy (crypto.randomBytes(32)). To
// rotate in a hypothetical migration, mint a `.v2.` constant — never edit this.
export const APP_SALT = 'bracemark.app-salt.v1.AS0_1XNd72q_HoSAgW1Vs1e6-W389XTsi_Iy3udOoCw';

export const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // KiB = 64 MiB
  hashLength: 32, // 256-bit master secret
} as const;

// HKDF context labels — distinct `info` strings fork the single master secret
// into independent sub-keys (auth vs. encryption). Never reuse a label for two
// purposes, or the two keys collapse into one.
export const HKDF_INFO_AUTH_SEED = 'bracemark-auth-seed';
export const HKDF_INFO_ENCRYPTION_KEY = 'bracemark-encryption-key';

// The RECOVERY door's KEK label. Unlike the password door (Argon2id over a
// low-entropy secret), the recovery code is already ≥256-bit CSPRNG entropy, so
// its KEK is a cheap HKDF over the normalized code — this is the `info` that
// forks it from every other HKDF use. Frozen like the labels above: change it and
// every existing recovery code stops unwrapping the DEK. See docs/account.md.
export const HKDF_INFO_RECOVERY_KEK = 'bracemark-recovery-kek';

// --- encrypted-blob wire format ---------------------------------------------
//
// Every synced R2 blob is framed `[version(1) || iv(AES_GCM_IV_BYTES) ||
// ciphertext+tag]` (see docs/local-first-sync.md "crypto boundary"). Like the
// derivation parameters above, this is a cross-platform contract: a blob packed
// on one platform must unpack on every other, forever — so the numbers live
// here, not in any platform package. A format change (new cipher, different IV
// size, compression) mints a NEW version constant and a new decoder branch;
// never repurpose an existing value.

// 96-bit IV — the recommended AES-GCM size (other lengths are legal but take a
// weaker GHASH path). web-crypto's encrypt() mints exactly this many random
// bytes per call; the blob frame slices exactly this many back off on read.
export const AES_GCM_IV_BYTES = 12;

// First byte of every packed blob. Readers reject unknown versions loudly
// (a wrong slice would otherwise feed garbage to GCM and fail as "tampered").
export const BLOB_FORMAT_V1 = 0x01;

// Canonical form of a username, used BOTH as the per-user Argon2 salt input
// (see APP_SALT above) and for the server's case-insensitive UNIQUE handle.
// This is part of the frozen derivation contract: every platform must
// canonicalize identically and forever, or a user's keys won't reproduce and
// they're locked out of their data. NFKC collapses visually-identical Unicode
// forms; trim + lowercase mirror how the server stores the handle.
export const canonicalizeUsername = (username: string): string =>
  username.trim().normalize('NFKC').toLowerCase();

// Canonical form of a PASSWORD, folded in before the Argon2id KEK derivation
// (web-crypto/expo-crypto `derivePasswordKek`). Part of the frozen derivation
// contract: every platform must apply this identically and forever, or the same
// password derives a different KEK on another device and locks the user out —
// and there is NO password reset (docs/account.md), so that lockout is permanent.
//
// Deliberately DIFFERENT from canonicalizeUsername, because a password is a
// secret, not an identifier:
//   - trim() — kills the unrecoverable "invisible trailing space at signup"
//     footgun (the input isn't otherwise trimmed on the derivation path).
//   - normalize('NFC') — canonical composition only, so the SAME-looking password
//     typed as precomposed 'é' (U+00E9) or decomposed 'e'+U+0301 derives one KEK
//     across platforms/keyboards. NFC is entropy-preserving.
//   - NOT NFKC, and NOT toLowerCase — those are for the username handle, where you
//     WANT aggressive folding so confusables collide. On a password they'd shrink
//     the password space (NFKC folds ligatures/width/etc.) and destroy case, which
//     a password must keep. This mirrors RFC 8265's OpaqueString profile.
// On a plain-ASCII password (e.g. the generated hyphen-joined passphrase) this is
// a no-op, so it doesn't disturb the ASCII contract vectors.
export const canonicalizePassword = (password: string): string => password.trim().normalize('NFC');
