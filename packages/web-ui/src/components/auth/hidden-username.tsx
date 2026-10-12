// WHOSE PASSWORD THIS IS, for a password manager — on a form that takes the
// account's password and shows no username field. Four do: create-account's
// confirm step, and Settings → change password, recovery code and delete account.
// A manager reads a login as a PAIR, and a password field with no username beside
// it leaves it guessing: it offers to save an entry with the name blank (Chrome
// did, at the end of create-account), it cannot say which saved login an update
// belongs to, and with two accounts saved for this origin it cannot tell which
// one to fill.
//
// Three things about it are load-bearing, and nothing reports any of them — no
// lint error, no type error, and the evidence is a nameless entry in one person's
// browser:
//   - a TEXT input hidden with the `hidden` attribute, which takes it out of the
//     layout, the tab order and the accessibility tree at once — NOT
//     `type="hidden"`, which a manager skips;
//   - it states its own `autoComplete`, because it is a raw `<input>` and gets
//     neither of `ui/input.tsx`'s two answers (docs/accessibility.md, _what a
//     field tells the browser_);
//   - it goes BEFORE the password field in the document, inside the same
//     `<form>` where there is one — a username is looked for ahead of the
//     password it names.
//
// Only for the ACCOUNT's password. A lock password is a secret that is not this
// site's login (lock-pane.tsx, lock-password-dialog.tsx), and naming the account
// beside it would file it as one.
export function HiddenUsername({ username }: { username: string | null }) {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={username ?? ''}
      readOnly
      hidden
    />
  );
}
