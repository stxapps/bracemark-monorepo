// The words the new-password field prints: ONE real field, already holding generated
// words, which the user may edit into their own (docs/account.md, _generated
// password_). It renders on create-account and on Settings → change
// password, web and native, so four places print these and only this file keeps them
// saying the same thing. The prose had already drifted once (Settings dropped "there
// is no way to reset it if it's lost" from the typed paragraph, and nothing recorded
// whether that was a decision).
//
// Same reasoning as the message ladders next door (field-messages.ts): only the
// WORDS live here. Layout and tone classes are per-platform.
//
// The help paragraphs wrap on purpose and sit in a slot whose height doesn't cycle with
// keystrokes, so the ~33-character budget that file keeps for one-line messages
// doesn't reach them.

export type NewPasswordCopy = {
  // Settings' label. Create-account labels the same field "Password"
  // (CREATE_ACCOUNT_COPY.passwordLabel): it is the account's first.
  label: string;
  // The message line while the field holds the generated words, untouched. The ladder
  // has nothing to say about them: they are ~77 bits by construction.
  generated: string;
  // Under it, what to do about them.
  generatedHelp: string;
  // Under an edited value instead.
  ownHelp: string;
  regenerate: string;
  // Settings → change password, once the change has landed. A manager offers its
  // update only after the submit, so this is where saving is asked for, not a
  // checkbox before it.
  afterChange: string;
  // The control that shows the new password again on that screen, and the label of
  // the box it opens.
  showNew: string;
  shownLabel: string;
};

export const NEW_PASSWORD_COPY: NewPasswordCopy = {
  label: 'New password',
  generated: 'Generated for you.',
  generatedHelp:
    'Save it in a password manager, or anywhere you’ll still have it later — there is no way to reset it if it’s lost.',
  ownHelp:
    'A password of random words is stronger than most passwords you’d type. If you use your own, make it long and unique — there is no way to reset it if it’s lost.',
  regenerate: 'Regenerate',
  afterChange:
    'If your browser or password manager offers to update your saved password, accept it. Your old password no longer works.',
  showNew: 'Show my new password',
  shownLabel: 'Your new password',
};
