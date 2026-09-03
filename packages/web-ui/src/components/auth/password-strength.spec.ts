import { generatePassphrase, PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';

import { loadPasswordScorer } from './password-strength';

// Pins WHICH dictionaries the create-account entropy gate is scored against —
// the one property of this gate that can regress in total silence. Drop
// `@zxcvbn-ts/language-en` from the loader (or from a manifest, or let a
// `lint --fix` prune it as "unused") and nothing here fails to compile, nothing
// fails to lint, no type changes: the gate simply starts admitting ordinary
// English phrases, because zxcvbn falls back to modelling anything it can't
// match as 10^length and the 20-char floor then carries them past 10^18 on
// length alone. That is not a hypothetical — every phrase in NOW_REJECTED below
// PASSED the real gate before `language-en` was wired in.
//
// This drives the actual exported loader, not a local re-composition of the
// packs, so it is testing the shipped policy. The native twin
// (apps/bracemark-expo/src/features/auth/password-strength.spec.ts) asserts the
// same phrases against its own loader — the two platforms must admit and reject
// identically, or the same password is creatable on one and refused on the
// other (docs/account.md, _password — rules and entropy_).
//
// The module's OTHER half — what the user is shown about the result, and the one
// rule joining the two (the meter may never read "Strong" while submit is
// blocked) — is `password-strength-meter.spec.tsx` beside this. Two files for one
// source module is unique in this workspace and deliberate rather than untidy:
// this one is the native twin's SAME-NAMED pair and stays pure policy, no jsdom
// and no render, so a rename to `.tsx` would break the pairing that makes the two
// platforms' gate specs findable from each other; the meter's is
// testing-library over presentation, and has no native counterpart at all.
describe('the create-account entropy gate dictionary', () => {
  let score: (password: string, userInputs: string[]) => number;

  beforeAll(async () => {
    score = await loadPasswordScorer();
  }, 30_000);

  const passes = (password: string, userInputs: string[] = []) =>
    score(password, userInputs) >= PASSWORD_MIN_GUESSES_LOG10;

  // Long enough to clear NEW_PASSWORD_MIN_LENGTH (20), so the length floor is not
  // what rejects them — the dictionaries are. Each scored above the gate on
  // `language-common` alone; the number in the comment is that old passing score.
  const NOW_REJECTED = [
    ['thequickbrownfoxjumps', 19.1],
    ['ilovemydogsomuchyess', 18.1],
    ['correcthorsebatterystaple', 21.8],
  ] as const;

  it.each(NOW_REJECTED)('rejects the English phrase %s', (password) => {
    expect(passes(password)).toBe(false);
  });

  // The other direction matters just as much: a pack that somehow matched
  // everything would "pass" the block above while making the app unusable. These
  // are the two secrets the product actually issues, and both must stay
  // creatable.
  it('still admits the generated passphrase', () => {
    // Not a fixed string — the point is that ANY draw clears the gate, and a
    // pinned example would stop covering the generator the moment it changed.
    for (let i = 0; i < 5; i++) expect(passes(generatePassphrase())).toBe(true);
  });

  it('still admits a long random password', () => {
    expect(passes('Qx7-vT2m_pR9wLd4Zk1B-nH6')).toBe(true);
  });

  // The username is fed to zxcvbn as a penalty term by all four call sites
  // (`useNewPassword`), and that has to survive the dictionary change too.
  it('still penalises a username-derived password', () => {
    const password = 'witwitchayakarn_wit1';
    expect(passes(password)).toBe(false);
    expect(score(password, ['witwitchayakarn'])).toBeLessThan(score(password, []));
  });
});
