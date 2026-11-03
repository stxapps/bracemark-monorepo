// The words the "here is your recovery code, save it" block prints — the second
// door into an account whose only other key is a password that cannot be reset
// (docs/account.md, _the recovery door_). It is rendered on FOUR surfaces:
// create-account's recovery step and Settings → Account → recovery code, web and
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
  /** Beside create-account's checkbox, which gates its Continue. Settings has none. */
  confirmLabel: 'I’ve saved my recovery code somewhere safe.',

  /**
   * create-account, step two, under the heading. Says "this recovery code" because it
   * is the first time the user has seen the words, and does NOT say "it won't be
   * shown again": this step offers a regenerate control, and nothing is committed
   * until the account is created.
   */
  description: {
    create:
      'Save this recovery code somewhere safe. It’s the only way back into your account if you ever lose your password.',
  },

  /**
   * Settings, once the mint has landed: the ✓ line every done screen in Account opens
   * with (change password's, sign out other devices'). It states what is ALREADY true,
   * because a screen that asked for a tick before "Done" read as one where the code
   * would not count until it got one. Two strings, because replacing a code retires
   * the previous one server-side, and that is the fact that earns its own sentence.
   */
  minted: {
    first: 'Your recovery code is set up.',
    replaced: 'Your new recovery code is active, and your previous one has stopped working.',
  },
  /** Settings, under the ✓ line: what to do with the code below it. */
  saveIt: 'Save it somewhere safe, apart from your password.',
  /**
   * Settings, under the code. Leaving without saving it is a chore, not a loss: anyone
   * who can still sign in can mint another here, which is why this screen no longer
   * gates its way out. "If you lose it" rather than "if you didn't save it": it looks
   * forward, so it covers leaving unsaved and losing it months later alike, and the
   * code is still on screen as this is read. The condition is what keeps it true:
   * minting needs the current password, and the code is for the day that is gone.
   */
  shownOnce:
    'This is the only time it’s shown. If you lose it, generate a new one here while you still have your password.',
} as const;
