import { canonicalizePassword } from './params';

// canonicalizePassword is part of the FROZEN derivation contract (it runs before
// the Argon2id KEK on every platform), so its behavior is pinned here. The
// cross-platform round-trip — that equivalent encodings actually open one door —
// lives in web-crypto's contract-vectors.spec.ts; this pins the pure function.
// Non-ASCII is written as \u escapes so the test bytes are unambiguous (a
// precomposed vs decomposed literal looks identical in an editor).
describe('canonicalizePassword', () => {
  it('trims surrounding whitespace (kills the trailing-space lockout footgun)', () => {
    expect(canonicalizePassword('  hunter2-correct  ')).toBe('hunter2-correct');
  });

  it('NFC-normalizes so equivalent encodings converge', () => {
    const decomposed = 'café'; // 'e' + combining acute (U+0301), length 5
    const precomposed = 'café'; // precomposed 'e-acute' (U+00E9), length 4
    expect(decomposed.length).toBe(5); // guard: input really is decomposed
    expect(canonicalizePassword(decomposed)).toBe(precomposed);
    expect(canonicalizePassword(decomposed).length).toBe(4); // …NFC composed it
  });

  it('preserves case — passwords are case-sensitive (not a lowercased handle)', () => {
    expect(canonicalizePassword('AbCdEfGh')).toBe('AbCdEfGh');
  });

  it('does NOT compatibility-fold like NFKC (entropy-preserving)', () => {
    // NFKC would fold the ligature U+FB00 (ff) and circled U+2461 (2); NFC leaves
    // both intact, so the password space isn't silently shrunk.
    expect(canonicalizePassword('ﬀ')).toBe('ﬀ');
    expect(canonicalizePassword('②')).toBe('②');
  });

  it('is a no-op on a plain-ASCII password (e.g. the generated passphrase)', () => {
    expect(canonicalizePassword('correct-horse-battery-staple')).toBe(
      'correct-horse-battery-staple',
    );
  });
});
