import { sha256 } from '@noble/hashes/sha256';
import { wordlist } from '@scure/bip39/wordlists/english';

import { CRYPTO_CONTRACT_VECTOR } from './contract-vectors';
import { bytesToHex } from './encoding';
import { generatePassphrase, PASSPHRASE_DEFAULT_WORDS } from './passphrase';

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

  it('refuses too-low entropy (< 4 words)', () => {
    expect(() => generatePassphrase(3)).toThrow(RangeError);
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
  it('matches the pinned length and hash', () => {
    expect(wordlist).toHaveLength(CRYPTO_CONTRACT_VECTOR.wordlist.length);
    expect(bytesToHex(sha256(wordlist.join('\n')))).toBe(CRYPTO_CONTRACT_VECTOR.wordlist.sha256Hex);
  });
});
