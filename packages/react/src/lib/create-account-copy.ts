// The words create-account and the welcome after it print, on both platforms
// (docs/account.md, _creating an account_ and _the welcome_). Same reasoning as the
// copy next door (new-password-copy.ts, recovery-code-copy.ts): two components per
// platform, so only one file can keep them saying the same thing. Layout and tone
// classes stay per-platform.

export const CREATE_ACCOUNT_COPY = {
  title: 'Create account',
  // A disclosure rather than a caption: both halves name a field this form will never
  // show, because the account has neither (docs/account.md — the secret IS the
  // account).
  description: 'No email address, no password reset — your password unlocks the key to your links.',

  // The field's own words (its message, help and Regenerate) are NEW_PASSWORD_COPY's,
  // shared with Settings → change password. Only the label differs: here it is the
  // account's first password, so "New" would describe nothing.
  passwordLabel: 'Password',
  shownPasswordLabel: 'Your password',

  // ONE STEP: this button creates the account and signs in, which is the moment a
  // password manager offers to save — after the account exists, from the form it was
  // typed or suggested into.
  submit: 'Create account',
  creating: 'Creating account…',
  // Under the button, after a submit. The other failure is generic and says to try
  // again, which here would only fail again: the server's daily per-network cap
  // (bracemark-api services/signup-cap.ts) clears tomorrow, not in a moment. Shared
  // wifi and mobile carriers put many people behind one address, so it names the
  // network rather than the person.
  submitFailed: 'Could not create account. Please try again.',
  signupLimited:
    'Too many accounts have been created from this network today. Please try again tomorrow.',
} as const;

// The welcome: three steps after the account exists, each skippable. The order is
// the design. The recovery code comes first because copying it replaces the
// clipboard, so the check after it cannot be passed by pasting back a password copied
// on the create form, which proves nothing about the saved copy.
export const WELCOME_COPY = {
  heading: {
    recovery: {
      title: 'Your account is ready',
      description:
        'Set up a recovery code: a second way into your account if you ever lose your password.',
    },
    check: {
      title: 'Check your saved password',
      description:
        'Sign in with the copy you saved, the way you will next time. It checks that it works.',
    },
    start: {
      title: 'You’re all set',
      description: 'Bring in the bookmarks you already have, or start with an empty library.',
    },
  },

  // Step 1. The code is made when asked for, not before: an account whose code nobody
  // saw would read as "has a recovery code" and silence Settings' nudge.
  createRecovery: 'Create recovery code',
  creatingRecovery: 'Creating…',
  skipRecovery: 'Skip for now',
  // After it is made: it is live already, so the line says so (RECOVERY_CODE_COPY's
  // Settings wording is for a screen with its own back link).
  recoveryReady: 'Your recovery code is set up. Save it somewhere safe, apart from your password.',
  recoveryFailed: 'Could not create a recovery code. Try again, or set one up later in Settings.',
  // The save went out and no answer came back (UnconfirmedSaveError), so a code may
  // be live that nobody saw. No "later in Settings" here: Settings would then read
  // the account as having a code and drop its nudge, so the time is now.
  recoveryUnconfirmed:
    'We didn’t get an answer, so a code you haven’t seen may already be set up. Create one again now to get one you can save.',

  // Step 2, the check. ⚠ TWO OF THESE ARE LOAD-BEARING. `signIn` and `showPassword` are
  // what make Safari read this step as a login rather than a sign-up
  // (docs/password-manager.md, _how Safari tells a login from a sign-up_). It takes BOTH: a
  // submit that says "Sign in" and a control that says "Forgot your password?".
  // Reworded, Safari offers its own strong password on a field that has to match the
  // account, and accepting it saves that password over the real one. "Show my password
  // again" was measured failing. The spec pins both.
  /** ⚠ Load-bearing: keep "Sign in". */
  signIn: 'Sign in to check',
  /** ⚠ Load-bearing: keep "Forgot your password?". */
  showPassword: 'Forgot your password? Show it again',
  // Nothing entered is not a mismatch: the lock screens' words (lockPasswordSchema).
  empty: 'Please enter a password',
  mismatch: 'That doesn’t match. Check what you saved and try again.',
  passed: 'Your saved password works.',
  // The check failed AND the browser filled the field: a manager holds a password the
  // account does not, most likely Safari's own strong password, which it saved the
  // moment it was accepted. Switching the account to it is a real password change now
  // (the account exists), and it makes the saved copy and the account agree.
  offeredPassword:
    'Your browser filled in a different password, and has probably saved it. Use it for this account so the two match.',
  useOfferedPassword: 'Use this password instead',
  switchingPassword: 'Switching…',
  switchFailed: 'Could not switch your password. Please try again.',
  skipCheck: 'Skip',

  // Step 3.
  importBookmarks: 'Import bookmarks',
  startEmpty: 'Start using Bracemark',

  continue: 'Continue',
} as const;
