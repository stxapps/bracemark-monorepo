import { CRYPTO_CONTRACT_VECTOR } from './contract-vectors';
import { canonicalizePassword, canonicalizeUsername } from './params';

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

// The OTHER half of the frozen derivation contract, and it had no spec at all.
// canonicalizeUsername is both the per-user salt input (crypto/salt.ts) and the
// form the server stores as its UNIQUE handle, so the two must agree forever: if
// this folds two spellings together the server keeps apart, one user's password
// derives another's salt.
describe('canonicalizeUsername', () => {
  it('trims, NFKC-folds and lowercases', () => {
    expect(canonicalizeUsername('  Alice_01  ')).toBe('alice_01');
    expect(canonicalizeUsername('ALICE_01')).toBe('alice_01');
    // NFKC collapses the visually-identical fullwidth forms onto ASCII, which is
    // what stops a lookalike handle deriving a different salt for one account.
    expect(canonicalizeUsername('Ａｌｉｃｅ＿０１')).toBe('alice_01');
  });

  it('produces the contract vector’s canonical handle', () => {
    expect(canonicalizeUsername(CRYPTO_CONTRACT_VECTOR.username)).toBe('alice_01');
  });

  it('is idempotent — re-canonicalizing a stored handle is a no-op', () => {
    // Both the client and the server canonicalize defensively on their own paths
    // (use-sign-in.ts, use-create-account.ts), so this runs twice on one value.
    const once = canonicalizeUsername('  Alice_01  ');
    expect(canonicalizeUsername(once)).toBe(once);
  });
});

// Two canonicalizations, deliberately different — an identifier wants aggressive
// folding so confusables collide, a secret must not be folded at all. Unifying
// them is the tempting cleanup, and it breaks in whichever direction it is done:
// lowercasing passwords destroys case and NFKC-folding them shrinks the password
// space, while dropping the folds from the username lets two spellings of one
// handle derive two different salts. Nothing but this pins them apart.
describe('the two canonicalizations diverge on purpose', () => {
  it('only the username lowercases', () => {
    expect(canonicalizeUsername('AbC_01')).toBe('abc_01');
    expect(canonicalizePassword('AbCdEfGh')).toBe('AbCdEfGh');
  });

  it('only the username compatibility-folds (NFKC vs NFC)', () => {
    // U+FB00 (the 'ff' ligature): NFKC expands it, NFC leaves it alone.
    expect(canonicalizeUsername('ﬀoo')).toBe('ffoo');
    expect(canonicalizePassword('ﬀoo')).toBe('ﬀoo');
  });

  it('both trim, for the same trailing-space lockout reason', () => {
    expect(canonicalizeUsername(' alice ')).toBe('alice');
    expect(canonicalizePassword(' hunter2-correct ')).toBe('hunter2-correct');
  });
});
