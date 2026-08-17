import { generatePassphrase, PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';

import { loadPasswordScorer } from './password-strength';

// The native half of the gate-dictionary pin. The full rationale — what silently
// regresses when `@zxcvbn-ts/language-en` goes missing, and why every phrase below
// USED to pass — is on the twin,
// packages/web-ui/src/components/auth/password-strength.spec.ts.
//
// This file exists rather than trusting that one because the gate is policy: a
// password the user can create on web must be creatable on native and vice versa
// (docs/account.md, _password — rules and entropy_ — the same reason the message
// ladders live in `@stxapps/react`). A pack dropped from ONE platform's manifest
// would leave the twin green while the two gates disagreed, which is precisely the
// drift that already bit `NewPasswordField` once, when Settings scored with no
// penalty terms and create-account scored with the username.
describe('the create-account entropy gate dictionary', () => {
  let score: (password: string, userInputs: string[]) => number;

  beforeAll(() => {
    score = loadPasswordScorer();
  }, 30_000);

  const passes = (password: string, userInputs: string[] = []) =>
    score(password, userInputs) >= PASSWORD_MIN_GUESSES_LOG10;

  // Same corpus as the twin — these are the assertions that must agree across
  // platforms, so they are deliberately the identical strings.
  it.each([['thequickbrownfoxjumps'], ['ilovemydogsomuchyess'], ['correcthorsebatterystaple']])(
    'rejects the English phrase %s',
    (password) => {
      expect(passes(password)).toBe(false);
    },
  );

  it('still admits the generated passphrase', () => {
    for (let i = 0; i < 5; i++) expect(passes(generatePassphrase())).toBe(true);
  });

  it('still admits a long random password', () => {
    expect(passes('Qx7-vT2m_pR9wLd4Zk1B-nH6')).toBe(true);
  });

  it('still penalises a username-derived password', () => {
    const password = 'witwitchayakarn_wit1';
    expect(passes(password)).toBe(false);
    expect(score(password, ['witwitchayakarn'])).toBeLessThan(score(password, []));
  });
});
