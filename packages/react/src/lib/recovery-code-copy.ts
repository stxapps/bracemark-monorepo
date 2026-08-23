// The words the "here is your recovery code, save it" block prints — the second
// door into an account whose only other key is a password that cannot be reset
// (docs/account.md, _the recovery door_). It is rendered on FOUR surfaces:
// create-account's third step and Settings → Account → recovery code, web and
// native each. Those are two components per platform, so nothing but this file can
// keep the four saying the same thing.
//
// It had already drifted, in the way that is hardest to see: the two moments used
// different apostrophes — a single-quoted literal in Settings took the typographic
// ’ because a straight ' would have needed escaping, and create-account's
// double-quoted one took '. Same sentence, one screen apart, in two characters.
// Only the ’ is correct (docs/brand-assets.md — _mechanics_).
//
// Same reasoning as the copy next door (new-password-copy.ts, field-messages.ts):
// only the WORDS live here. Layout, tone classes, and the regenerate control that
// create-account hangs beside the box are per-platform.

export const RECOVERY_CODE_COPY = {
  /** The heading, on all four surfaces. */
  title: 'Recovery code',
  /** On the secret box itself — it names its own contents, so the heading doesn't. */
  secretLabel: 'Your recovery code',
  /** Beside the checkbox that gates the only exit. */
  confirmLabel: 'I’ve saved my recovery code somewhere safe.',

  // Three descriptions, not one, because the moments differ in what is already
  // true — and the differences are load-bearing, so they are kept apart here
  // rather than folded into a stem with a swapped clause.
  description: {
    /**
     * create-account, step three. Says "this recovery code" because it is the
     * first time the user has seen the words, and does NOT say "it won't be shown
     * again": this step offers a regenerate control, and nothing is committed
     * until the account is created.
     */
    create:
      'Save this recovery code somewhere safe. It’s the only way back into your account if you ever lose your password.',
    /**
     * Settings, first code. "Won't be shown again" is true here and load-bearing:
     * the mint has landed, there is no back link, and Done is the only exit.
     */
    mint: 'Save this somewhere safe — it won’t be shown again. It’s your only way back into your account if you forget your password.',
    /**
     * Settings, replacing a code. The previous door is already dead server-side by
     * the time this renders, which is the fact that earns its own string: a user
     * who leaves without saving is stranded with a door they cannot open.
     */
    remint:
      'Save this somewhere safe — it won’t be shown again. Your previous code has stopped working, so this is the only one that can get you back into your account.',
  },
} as const;
