// The words the unlock surface prints — the pane both lock gates render (app lock
// full-screen, a locked list inside the main pane) and the two titles that
// distinguish them. docs/locks.md has the mechanism; this file only has the words.
//
// It is rendered on FOUR surfaces: `components/lock-pane.tsx` and its two callers,
// web and native each. The panes are separate components with no shared ancestor —
// the native one is a hand port of the web one — so every string below existed
// twice, character for character, with nothing to keep the copies together. The
// two `LockPane` implementations also stay in step by hand; keeping the words in
// one place at least stops the halves saying different things.
//
// Same reasoning as the copy next door (new-password-copy.ts, recovery-code-copy.ts):
// only the WORDS live here. Layout, tone classes and the error CARRIER stay
// per-platform — web spells the error `<p role="alert">` and native spells it
// `<ErrorText>` (docs/accessibility.md).
//
// Strings that exist on only ONE platform are deliberately NOT here. The biometric
// button is native-only, so it stays at its single call site rather than moving
// somewhere that implies a twin.

export const LOCK_COPY = {
  /** The app lock gate — the whole app, before anything else renders. */
  app: {
    title: 'Bracemark is locked',
    description: 'Enter your app lock password to continue.',
  },
  /** A locked list. Swapped in for the layout, so the links never mount. */
  list: {
    title: 'This list is locked',
    description: 'Enter the list’s password to view its links.',
  },

  /** Placeholder AND accessible name on the field — one word serves both. */
  passwordLabel: 'Password',
  unlock: 'Unlock',
  unlocking: 'Unlocking…',

  errors: {
    empty: 'Please enter a password',
    /** `onUnlock` resolving false. Everything else it may throw gets `failed`. */
    wrong: 'Password isn’t correct. Please try again.',
    failed: 'Could not unlock. Please try again.',
  },

  // The escape hatch, in three parts because a control sits INSIDE the sentence:
  // locks are device-local, so signing out (which wipes every lock) and signing
  // back in with the account password always works. The caller renders `action` as
  // its own platform's inline control and supplies the spaces either side.
  forgot: {
    before: 'Forgot the password? You can',
    action: 'sign out',
    after: 'and sign back in — signing out removes all locks on this device.',
  },
} as const;
