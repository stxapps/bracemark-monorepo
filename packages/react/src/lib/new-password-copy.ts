// The words the "choose your new password" block prints — the block that offers a
// generated passphrase by default with a typed-your-own escape hatch (docs/account.md,
// _generated password_). It is rendered on FOUR surfaces: create-account and
// Settings → change password, web and native each. Those are two components per
// platform, so nothing but this file can keep the four saying the same thing; the
// prose had already drifted once (Settings dropped "there is no way to reset it if
// it's lost" from the typed-path paragraph, and nothing recorded whether that was
// a decision).
//
// Same reasoning as the message ladders next door (field-messages.ts): only the
// WORDS live here. Layout, tone classes and the link/button an `ownHelp` sentence
// ends with are per-platform.
//
// These are full paragraphs, not the one-line messages that file budgets to ~33
// characters — they wrap on purpose and sit in a slot whose height doesn't cycle
// with keystrokes, so the no-reflow rule that governs those doesn't reach here.

export type NewPasswordCopy = {
  // The field label, in BOTH modes. Generated mode's label names the block rather
  // than a control (the secret box carries its own `secretLabel`), which is why one
  // string serves both — Settings already worked this way, and create-account's
  // generated step said "Your password" over a box announcing the same three words.
  label: string;
  // Screen-reader label on the secret box itself.
  secretLabel: string;
  // Beside the "I've saved it" checkbox that gates whatever comes next.
  confirmLabel: string;
  generatedHelp: string;
  // Ends with the sentence the "generate one instead" control follows; the caller
  // renders that control as the platform's own link/button and appends it.
  ownHelp: string;
  chooseOwn: string;
  generateInstead: string;
  regenerate: string;
};

// Everything that doesn't depend on whether this is a first password or a
// replacement. The two help paragraphs both close on the same clause because it
// stays true in both places: a rotated password has no reset either.
const COMMON = {
  generatedHelp:
    'We generated a strong password for you. Save it in a password manager, or anywhere you’ll still have it later — there is no way to reset it if it’s lost.',
  ownHelp:
    'A password of random words is stronger than most passwords you’d type. If you use your own, make it long and unique — there is no way to reset it if it’s lost.',
  chooseOwn: 'Choose my own',
  generateInstead: 'Generate one instead',
  regenerate: 'Regenerate',
};

// Keyed by which ceremony the block sits in rather than by the noun it prints, so a
// call site reads as what it is ("this is the change-password one") and the strings
// stay literal instead of being assembled from a stem.
export const NEW_PASSWORD_COPY: Record<'create' | 'change', NewPasswordCopy> = {
  create: {
    ...COMMON,
    label: 'Password',
    secretLabel: 'Your password',
    confirmLabel: 'I’ve saved my password somewhere safe.',
  },
  change: {
    ...COMMON,
    label: 'New password',
    secretLabel: 'Your new password',
    confirmLabel: 'I’ve saved my new password somewhere safe.',
  },
};
