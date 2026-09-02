import { sha256 } from '@noble/hashes/sha2';
import { wordlist } from '@scure/bip39/wordlists/english';

import { CRYPTO_CONTRACT_VECTOR } from './contract-vectors';
import { bytesToHex } from './encoding';
import {
  generatePassphrase,
  PASSPHRASE_BITS_PER_WORD,
  PASSPHRASE_DEFAULT_WORDS,
} from './passphrase';

describe('generatePassphrase', () => {
  it('defaults to 7 hyphen-separated words, all from the list', () => {
    const words = generatePassphrase().split('-');
    expect(words).toHaveLength(PASSPHRASE_DEFAULT_WORDS);
    for (const w of words) expect(wordlist).toContain(w);
  });

  it('honours a custom word count', () => {
    expect(generatePassphrase(8).split('-')).toHaveLength(8);
  });

  it('joins with hyphens and contains no spaces', () => {
    expect(generatePassphrase()).not.toContain(' ');
    expect(generatePassphrase()).toContain('-');
  });

  it('refuses too-low entropy (< 4 words) but allows the floor itself', () => {
    expect(() => generatePassphrase(3)).toThrow(RangeError);
    expect(generatePassphrase(4).split('-')).toHaveLength(4);
  });

  it('refuses a word count that is not a whole number', () => {
    // `words * 2` bytes and `bytes[i * 2 + 1]` would read past the buffer on a
    // fraction, picking `wordlist[undefined & 0x7ff]` — index 0, silently, for
    // the last word. The guard is what keeps that from being a biased passphrase.
    for (const words of [7.5, NaN, Infinity]) {
      expect(() => generatePassphrase(words)).toThrow(RangeError);
    }
  });

  it('does not repeat itself across calls (CSPRNG, not constant)', () => {
    const a = generatePassphrase();
    const b = generatePassphrase();
    expect(a).not.toEqual(b);
  });
});

// The wordlist is not a derivation input, but a change would silently shift the
// entropy space. Pin it so any drift fails CI rather than shipping quietly.
describe('generated-passphrase wordlist (frozen contract)', () => {
  it('is exactly 2^bits long, which is what makes the 11-bit mask unbiased', () => {
    // The picker masks 16 random bits down to 11 and indexes directly — no
    // rejection sampling, no modulo. That is only uniform because 2048 is exactly
    // 2^11. A list of any other size makes every generated password subtly biased,
    // with nothing to show for it: the hash vector below would fail, but it would
    // not say why this number matters.
    expect(wordlist).toHaveLength(2 ** PASSPHRASE_BITS_PER_WORD);
  });

  it('contains no word with a hyphen, so the separator stays unambiguous', () => {
    // The passphrase is hyphen-JOINED and re-typed at every sign-in; a hyphenated
    // entry would make one passphrase ambiguous to read back (and would quietly
    // invalidate every `split('-')` assertion above).
    for (const word of wordlist) expect(word).toMatch(/^[a-z]+$/);
  });

  it('matches the pinned length and hash', () => {
    expect(wordlist).toHaveLength(CRYPTO_CONTRACT_VECTOR.wordlist.length);
    expect(bytesToHex(sha256(wordlist.join('\n')))).toBe(CRYPTO_CONTRACT_VECTOR.wordlist.sha256Hex);
  });
});
