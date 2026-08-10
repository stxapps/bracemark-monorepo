// Generated-passphrase support: a high-entropy `password` the create-account
// ceremony offers as the safe default (docs/account.md — "generated password").
// The words are just a normal password string — they flow through the SAME
// password door as a typed one, so nothing in the derivation contract changes;
// only the UI offers them. See docs/account.md ("a password-derived wallet").
//
// Pure and platform-agnostic, so it lives in `shared` (the lowest layer): web
// generates today, the future Expo/native client tomorrow, and both MUST pick
// from the identical wordlist or the same click yields a different entropy space
// (a silent contract drift). The list is pinned by a hash vector in
// contract-vectors.ts so it can never change unnoticed.
//
// We reuse BIP-39's English wordlist (from the same @scure/@noble supply chain
// as the rest of the crypto layer): 2048 curated words = EXACTLY 11 bits each,
// so uniform selection is an 11-bit mask with NO modulo bias and no rejection
// sampling. We take only the list — not generateMnemonic(), which forces fixed
// 12/24-word BIP-39 sizes with a checksum; we want a plain N-word passphrase.
import { wordlist } from '@scure/bip39/wordlists/english';

// 2048 words = 2^11, so each word carries exactly this many bits of entropy.
export const PASSPHRASE_BITS_PER_WORD = 11;

// The product default (docs/account.md): 7 words = 77 bits — "good, approaches
// wallet-grade". Callers may ask for more; fewer than 4 is refused as unsafe.
export const PASSPHRASE_DEFAULT_WORDS = 7;

// Uniformly pick `words` entries from the 2048-word list with a CSPRNG and join
// them with HYPHENS. Entropy = words * 11 bits (7 → 77). Uses the standard
// `crypto.getRandomValues` global (present on web/Workers and on Hermes via the
// app's react-native-get-random-values polyfill) — never Math.random.
//
// Hyphen, not space: the string is a `password` (no trim/normalization on the
// derivation path — see derivePasswordKek), shown once and RE-TYPED at the
// confirm step and every sign-in. A space is a re-entry footgun there — a stray
// trailing space or double-space silently derives a different KEK, and mobile
// keyboards auto-capitalize / autocorrect ". " after one. A hyphen reads as a
// single token to the keyboard and has no leading/trailing/collapse ambiguity.
// The separator is NOT a derivation contract (generation is random + per-user;
// only the wordlist is pinned), so this is free to choose for UX.
//
// Each word draws 16 random bits and masks to the low 11 (& 0x7ff → 0..2047).
// 2048 divides 2^11 evenly, so every index is equiprobable: no bias, no retry.
export function generatePassphrase(words: number = PASSPHRASE_DEFAULT_WORDS): string {
  if (!Number.isInteger(words) || words < 4) {
    throw new RangeError('generatePassphrase: refuse fewer than 4 words (too little entropy)');
  }
  // Two bytes per word, read as a big-endian 16-bit value then masked to 11 bits.
  const bytes = crypto.getRandomValues(new Uint8Array(words * 2));
  const picked: string[] = [];
  for (let i = 0; i < words; i++) {
    const index = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 0x7ff;
    picked.push(wordlist[index]);
  }
  return picked.join('-');
}
