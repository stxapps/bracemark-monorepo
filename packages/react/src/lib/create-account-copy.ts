// The words create-account prints, on both platforms (docs/account.md, _creating an
// account_). Same reasoning as the copy next door (new-password-copy.ts,
// recovery-code-copy.ts): two components, so only one file can keep them saying the
// same thing. Layout and tone classes stay per-platform.
//
// ⚠ TWO OF THESE ARE LOAD-BEARING, AND NOTHING ELSE ON THE SCREEN CAN STAND IN FOR
// THEM. `signIn` and `showPassword` are what make Safari read the last step as a
// login instead of a sign-up (docs/account.md, _how safari tells a login from a
// sign-up_). It takes BOTH: a submit that says "Sign in" and a control that says
// "Forgot your password?". Reword either and Safari goes back to offering its own
// strong password on a field that has to match, with no error anywhere, on one
// browser, so `create-account-form.spec.tsx` pins the exact strings. "Show my
// password again" sounds like a harmless polish of the second one, and it was
// measured failing.
//
// The form survives that going wrong (`offeredPassword` below), so a heuristic moving
// under us costs a detour and not a wrong saved copy. It is still a detour worth
// avoiding, and it is why these two are here and not typed into each form.
export const CREATE_ACCOUNT_COPY = {
  heading: {
    setup: {
      title: 'Create account',
      description:
        'No email address, no password reset — your password unlocks the key to your links.',
    },
    check: {
      title: 'Check your saved password',
      description:
        'Sign in with the copy you saved. That proves it works and creates your account.',
    },
  },

  // The field's own words (its message, help and Regenerate) are NEW_PASSWORD_COPY's,
  // shared with Settings → change password. Only the label differs: here it is the
  // account's first password, so "New" would describe nothing.
  passwordLabel: 'Password',

  continueWithoutRecovery: 'Continue without a recovery code',

  /** ⚠ Load-bearing: see the note above. Keep "Sign in". */
  signIn: 'Sign in to finish',
  creating: 'Creating account…',
  /** ⚠ Load-bearing: see the note above. Keep "Forgot your password?". */
  showPassword: 'Forgot your password? Show it again',
  shownPasswordLabel: 'Your password',

  // Nothing entered, which is not a mismatch: "doesn't match" would send someone to
  // check a saved copy when they have not typed anything yet. The lock screens' words
  // (lockPasswordSchema); sign-in's own schema answers empty input with its length
  // rule, which would read here as a hint about the password.
  empty: 'Please enter a password',
  mismatch: 'That doesn’t match. Check what you saved and try again.',
  // The password check failed AND the browser filled that field, so a manager holds
  // something the form does not: its own strong password, or an older save of this
  // username. Nothing exists on the server yet, so the form can take the manager's
  // version, which is what makes this a detour rather than a wrong saved copy. The
  // second sentence is for whoever would rather keep the first password: only their
  // browser's Update prompt repairs what it has already saved.
  offeredPassword:
    'Your browser filled in a different password. Use it for this account, or enter the one from step 1 and click Update Password if your browser asks.',
  useOfferedPassword: 'Use this password instead',
} as const;
