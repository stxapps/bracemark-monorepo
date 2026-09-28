// The words of the session lifecycle a user meets (docs/sessions.md): the EXPIRED
// state — sync paused, library kept, "Sign in to resume" — and the line a device
// shows after the server told it to forget.
//
// Rendered on both apps (bracemark-web and bracemark-expo) and, in part, in the
// browser extension's popup — separate components with no shared ancestor, the
// native ones hand ports of the web ones. Only the WORDS live here, the same rule
// as the copy next door (lock-copy.ts, recovery-code-copy.ts): layout, roles and
// the platform verb stay per surface.
//
// What the copy may promise is what the machine does. An expired session erases
// nothing and keeps queueing edits, so "everything is still here" is true; a
// sign-out from this state DOES erase this device's copy, pending edits included,
// so the switch-account warning says so — with the count, because those edits
// exist nowhere else.

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

export const SESSION_COPY = {
  /** The persistent notice while the session is expired. A status, not an error. */
  paused: {
    title: 'Sync is paused',
    description:
      'Sign in again to keep this device syncing. Everything on it is still here — you can read, edit, and export as usual, and what you change now syncs once you sign in.',
    resume: 'Sign in to resume',
    switchAccount: 'Use a different account',
    /** The gate's line when the pause caught this device's FIRST sync mid-way. */
    beforeFirstSync: 'Signing in again will finish setting up this device.',
  },

  /** The resume form: a normal sign-in, username locked to the stored one. */
  resume: {
    title: 'Sign in to resume',
    description: (username: string) =>
      `Sign in as ${username} to resume syncing. Nothing on this device is erased.`,
  },

  /** "Use a different account" is a sign-out, and it warns before erasing. */
  switchAccount: {
    title: 'Use a different account?',
    description: (pending: number) =>
      pending > 0
        ? `This signs you out and erases this device’s copy, including ${changes(pending)} that haven’t synced and exist nowhere else. To keep them, sign in to resume instead.`
        : 'This signs you out and erases this device’s copy.',
    confirm: 'Sign out',
    cancel: 'Cancel',
  },

  /**
   * Settings → Account → Change password, once it succeeds. A password change
   * EXPIRES the other sessions — it doesn't revoke them — so the other devices
   * are cut off but erase nothing (docs/sessions.md). The marketing site's FAQ
   * and _Sign out_ help page say the same.
   */
  passwordChanged:
    'Your password has been changed. You’re still signed in on this device. Your other devices keep their copy and any changes not yet synced, and ask you to sign in again with the new password.',

  /** On the sign-in screen, after a `session_revoked` verdict wiped this device. */
  revoked: 'This device was signed out from another device, and its local copy was erased.',
} as const;
