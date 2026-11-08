## password managers

What browsers' and phones' password managers do with the forms that take the
account's password: what they offer to suggest, save, update and fill, on which
surface, and what was measured. The forms' designs and the reasons for them are in
[account.md](./account.md) (_creating an account_, _the welcome_, _changing a
password_, _a recovery code in Settings_). The `autocomplete` rule every field obeys
is in [accessibility.md](./accessibility.md) (_what a field tells the browser_). How
to run the measurements is in [e2e.md](./e2e.md) (_measuring the password manager_),
and how to drive real Safari and the simulators is in
[app-drivers.md](./app-drivers.md).

### why every rule here is a tripwire

**The password has no reset** ([account.md](./account.md), _the model_). It derives
the key that unwraps the account's data, so a saved copy that is wrong is worse
than none. Someone who trusted it signs out, and finds the only way back in no
longer opens. The same goes for a lock password filed as the login, and for a
deleted account's password saved as if it were live.

**Nothing in the repo can see any of it.** A manager's offer is browser chrome or
system UI, outside the page and the app's tree. A field that tells a manager the
wrong thing type-checks, lints and passes every flow. The evidence is an entry in
one person's password manager. So every finding below is a measurement, dated and
tied to its browser and OS version, and each says what pins the code that produced
it.

**Managers decide on heuristics, and different managers use different ones.**
Chrome reads `autocomplete` tokens and form shape. Safari decides between a sign-up
and a login from the words on the page (_how Safari tells a login from a sign-up_,
below). iOS AutoFill in an app reads `textContentType`, and skips a disabled field.
Android hands its autofill service a structure of the screen, and the service
decides. A change that is right for one can be wrong for another. Re-measure on
every platform a form ships on.

### what a manager reads

- **A login is a pair.** A password field with no username beside it leaves the
  manager guessing: which saved login to fill, which one an update belongs to, and
  what to call an entry it offers to save. The username goes **ahead of** the
  password in the form, where managers look for it.
- **A form going away is a submission.** A manager offers to save or update when the
  filled fields leave the page or the screen after a submit. So the moment the form
  goes away is the moment a save is offered, and it must be a moment the password is
  real. The three-step create-account form broke this (_the iOS app_, below).
- **The field's token says what it is**: `username`, `current-password`,
  `new-password`, and `one-time-code` for a secret that is not the login.
  [accessibility.md](./accessibility.md), _what a field tells the browser_, has the
  rule and the defaults.

### the surfaces

| surface                                          | fields a manager reads                                                                                | the username comes from                               | a manager should                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| sign in                                          | `username`, `current-password`                                                                        | the typed username                                    | fill a saved login; save one after a sign-in                                      |
| create account                                   | `username` (`username-new` on Android), `new-password` holding the generated words                    | the typed username                                    | suggest a strong password (welcome here); save once, after the account exists     |
| the welcome's check                              | read-only `username`, `current-password`                                                              | the read-only field                                   | fill the copy it saved; never suggest a new one                                   |
| Settings → change password                       | `current-password` (or the recovery code), `new-password`                                             | web: `HiddenUsername`; native: `AccountUsernameField` | fill the current password; update the saved login after the change                |
| Settings → recovery code                         | web: a password field marked `one-time-code`; native: `current-password`                              | ⚠ none, on purpose                                    | fill the current password; **never** offer to save, since the password is not new |
| Settings → delete account                        | web: a password field marked `one-time-code`; native: `current-password`                              | ⚠ none, on purpose                                    | fill the current password; **never** offer to save, since the account is gone     |
| lock surfaces (`LockPasswordDialog`, `LockPane`) | a password field marked `one-time-code` (web), `textContentType="oneTimeCode"` (iOS), `off` (Android) | none, on purpose                                      | nothing: a lock password is not this app's login                                  |

`HiddenUsername` is `web-ui/components/auth/hidden-username.tsx`: a `hidden` text
input with `autocomplete="username"` and the account's name. A **text** input,
because a manager skips `type="hidden"`. `AccountUsernameField` is
`bracemark-expo/src/features/settings/account-username-field.tsx`: a **visible**,
read-only field, because native has no hidden input a manager still reads (_the
Android app_, _the iOS app_, below). Recovery code and delete account have neither
(_a password that only proves who you are_, below).

### Chrome — measured by script

`npm run measure:password-manager` reads `chrome://password-manager-internals` for
each flow ([e2e.md](./e2e.md), _measuring the password manager_). On Chrome 156,
2026-11-03 and again 2026-11-04, every flow did what the table above says:

- **Create account:** one submission, the create itself, with
  `signup-new-password` as the new password, after the account exists.
- **The welcome's check:** the refused check is no submission. The passed one is a
  login with the same pair. In a fresh profile, where nobody pressed Save at the
  create, Chrome offers to save it again. In a profile that saved it, it has nothing
  to offer. The recovery code is never in it.
- **Change password:** one update offer with `cp-new-password` as the new password,
  the generated words included, on all three paths.
- **Recovery code** and **delete account:** no submission (_a password that only
  proves who you are_, below). Recovery code was an offer to save the current
  password, named by `HiddenUsername`, until 2026-11-04.
- **Lock surfaces:** no submission (_the lock password is not a login_, below).

⚠ **The new password must be a visible `new-password` input.** The generated words
once sat in an `<output>`, which no manager reads, so change password's only
password field was the current one, and Chrome's save prompt carried the **old**
password. A `hidden` input set by script patched that for Chrome 155, and went when
the words moved into the field. `WEB-ACCOUNT-006` pins the input.

Chrome on Android, measured by hand on the three-step form (Chrome 155): **Save
password?** after the account existed, and that copy signed in.

What the script cannot see: every profile is fresh, so the offer is always to
_save_. What Chrome does against a login it already holds, and the prompt it stops
showing after being dismissed for a site a few times, are a real profile's to show.

### Safari and iOS AutoFill — checked by hand

Safari is checked by hand ([app-drivers.md](./app-drivers.md), _driving real Safari
on macOS_, _driving Safari in the iOS Simulator_). What follows comes from a real
iPhone with AutoFill on, Safari 26.5.2 for macOS and the iOS 26.5 Simulator, on
2026-11-02. Not every point was run on all three.

- **Safari's strong password on a new-password field.** Focusing one offers a strong
  password from the keyboard, or as a full sheet in the Simulator, even when the field
  already holds a value. Accepting it and then editing the field left the **edited**
  password in the Passwords app, and AutoFill signed in with it after a sign-out.
- ⚠ **No token stops that offer.** On Safari 26.5.2 for macOS it survived
  `current-password`, `new-password`, `off` and `one-time-code`, a renamed id, a real
  `<form>`, a visible username, a changed URL, sign-up wording removed from the page,
  and a `hidden`, visually hidden or visible `new-password` input holding the password.
  One arrangement lost it: a visible `type="text"` input or a `<textarea>`, with
  "password" gone from its label, id, heading and description and no username beside it.
  A text field gives a manager nothing to save from, and is the shape rejected for the
  lock password (below).
- **What decides it is whether Safari reads the form as a sign-up or a login**, and the
  URL does not: the real sign-in form mounted inside `/create-account` got the login
  treatment (_how Safari tells a login from a sign-up_, next).
- ⚠ **`:autofill` tells a filled value from a typed one.** After an accepted offer it
  matched on macOS, through blur and through a failed submit, and one real keystroke
  cleared it. Typed by hand it never matched. Safari's own
  `:-webkit-autofill-strong-password-viewable` matched too, only while focused, so
  `:autofill` is the one to read. It is the safety net under the labels. On iOS a check
  in the event that reports the fill, or on the next frame, did not see it yet.
- **Safari's save prompt depends on how the value got there.** On macOS, Continue
  raises "Save Password?" for a password typed by hand, before the account exists,
  and not for a value set by script.
- ⚠ **iOS re-offers over a prefilled field.** Tapping the password field raises "Use
  Strong Password?" although it holds a value, and accepting is fine. But with the
  focus still in the field the sheet came straight back, with Save & Fill under the
  same thumb, and a second accept mints a second password. An empty field does not do
  this, so it is the prefill's cost. `new-password-field.tsx` leaves the field once a
  manager has filled it, which stopped the repeat. It is on a timer because iOS has
  not set `:autofill` yet in the event that reports the fill, nor on the next frame: a
  `requestAnimationFrame` version never fired. Measured on the three-step form; the
  field is the same one.

**Measured again 2026-11-04**, Safari 26.5.2 for macOS on staging, in two sessions, on the one-step
create account and the welcome, typing with real keystrokes and submitting with a
real Return ([app-drivers.md](./app-drivers.md), _driving real Safari on macOS_):

- **Create account, generated words untouched:** **Save Password?** once the welcome
  was up, so after the account existed. Unlike the three-step form's Continue, which
  Safari skipped for a value set by script.
- **Change password, current password typed, new words untouched:** "Do you want to
  update the password saved for ⟨username⟩ on app.dryrunbase.com?", naming the
  account through `HiddenUsername`. Accepted, the saved copy held the new words, filled
  sign-in, and signed in. ⚠ A submit by a scripted `click()` drew no offer at all, so a
  silence after one says nothing about the form.
- **The welcome's check, with the login saved at create:** no offer. It offers only
  when nothing matching is saved, as Chrome does, so it is the net under a declined or
  missed save at create, not a second prompt.
- **Recovery code and delete account:** an offer only when the login was not saved,
  and then whatever the markup (_a password that only proves who you are_, below).

#### ⚠ how Safari tells a login from a sign-up

No attribute controls Safari's strong-password offer (above). The decision comes
from **words on the page**, so there are two independent layers, and only the second
is a safety property. They guard the welcome's check ([account.md](./account.md),
_the welcome_), which is where a login-shaped form for a brand-new password still
lives. The measurements were taken on the three-step form's check, whose words the
welcome kept but one.

**Layer 1, the labels: avoiding the offer.** ⚠ Safari gives a login's treatment only
with **both** a submit that says "Sign in" and a control that says "Forgot your
password?". Either alone brought the blue offer back. "Sign in to finish" and "Forgot
your password? Show it again" held, the heading was free to change, and "Show my
password again" without the word "Forgot" failed. Measured on the shipped DOM,
2026-11-02:

| check step                         | Safari 26.5.2, macOS (DOM on a real HTTPS origin) | iOS 26.5 Simulator (real build)                   |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| as built                           | small "Suggest New Password" item, no blue offer  | ordinary keyboard, or **Sign In → Fill Password** |
| button says "Finish up"            | blue **Use Strong Password**                      | **Use Strong Password?** sheet                    |
| link says "Show my password again" | blue **Use Strong Password**                      | not run                                           |

So these two strings are load-bearing, and a copy edit can undo them silently, on one
browser, with everything else green. `welcome-gate.spec.tsx` pins both on purpose;
change either and re-measure.

**"Sign in to check" is not refuted, and could not be confirmed.** On 2026-11-04 the
welcome's check got the login treatment: with a login saved for the username,
Safari offered it first; with none saved, a small menu with "Suggest New Password"
as a row and no blue offer. But the known-bad controls drew no blue offer either:
"Finish up", and then "Show my password again" as well. That profile held a saved
login and recently generated passwords for the site, and in that state Safari made
no blue offer on this form whatever its words. A clean profile, or a site with
nothing generated, is what the table above needs to be re-run.

They are also honest, and that is the better reason to trust them: this step **is** a
login, and those are the words a login has. Safari cannot stop reading them that way
without breaking its treatment of sign-in pages generally.

**Layer 2, the switch: surviving the offer.** Accepting Safari's offer saves its
password at once, under the account's username, before the page has checked anything,
so this must not depend on a heuristic someone else owns. The page can tell: after an
accepted offer, `:autofill` matches the field and does not match a value typed by
hand. The welcome's **Use this password instead** ([account.md](./account.md), _the
welcome_) acts on that. What it does not cover: someone who clears the field by hand
and enters the real password has left `:autofill` behind and passes the check, with
Safari's copy stale. Safari then asks to update it, and **Not Now** keeps the wrong
one, which the marketing site's _Where to keep your password_ warns about.

Safari's own passwords pass the strength gate: one real one scored 19.59, and 2,996
of 3,000 samples imitating their format cleared `PASSWORD_MIN_GUESSES_LOG10`. The
rest get the normal message and a reader can take another.

**Rejected.** A warning alone leaves the trap in place. A plain text check field did
lose the offer, but only unmasked, with no "password" wording and no username beside
it: it shows the password on screen and gives a manager nothing to save from.

#### where the password was saved, by path

On the three-step form (measured on the real build unless noted). The one-step form
saves from the create itself, which is the ordinary sign-up every row below already
handled at its end. Only Chrome has been re-measured on it (_Chrome_, above).

| browser                | default path                                                                        | offer accepted on step 1                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| iOS Safari (Simulator) | **Save Password?** after the account exists; that copy signed in                    | one sheet; check offers **Fill Password**; first press created the account                         |
| Chrome 156, macOS      | one submission at the end, username + current password (`measure:password-manager`) | not run                                                                                            |
| Chrome 155, Android    | **Save password?** after the account exists; that copy signed in                    | not run                                                                                            |
| Safari 26.5.2, macOS   | not run on this build: see below                                                    | measured before the build, on staging's form: no mismatch, no prompt, and the saved copy signed in |

macOS Safari reaches a local build only through a certificate warning, and clicking
through changes trust on a real profile, so the shipped DOM was placed into staging's
origin instead. That covers Safari's classification, which reads the DOM, and not a
whole run.

### the iOS app

What iOS AutoFill does inside bracemark-expo, where there is no DOM, no `:autofill`
and no Safari heuristics: it reads each field's `textContentType`, and treats a
filled secure field leaving the screen as a submission. Measured on the iPhone 17 Pro
simulator, iOS 26.5, through Maestro, with the sheets and the Passwords app read from
the accessibility tree ([app-drivers.md](./app-drivers.md)). The 2026-11-04 rows ran
on a throwaway simulator, so the e2e iPhone's Passwords stayed empty. That matters:
a saved login changes the sheets `subflows/sign-in.yaml` meets.

- **Sign-in raises Save Password?** on success, in a sheet over the app, before or
  after the links screen paints. The Passwords app files it under **Bracemark** with
  the right username. The e2e subflows dismiss it ([e2e.md](./e2e.md)).
- ⚠ **A filled secure field leaving the screen is a submission, whatever caused it**,
  but only one with a username iOS can read beside it is offered for saving. The
  three-step create-account form's step 1 went away before the account existed, and
  iOS raised **Save Password?** over the recovery step, for an account not yet made.
  That is what `NATIVE-ACCOUNT-003` first caught, and part of why the form is one
  step now ([account.md](./account.md), _creating an account_). A reveal that swapped
  the field for a `multiline` one did the same on the eye press, so a reveal must not
  change which native view the field is ([account.md](./account.md), _every field
  that takes a secret reveals it_).
- ⚠ **iOS skips a disabled field, and React Native's `editable={false}` is one.** A
  read-only username made with it is, to AutoFill, no username at all. That is
  `LockedUsernameInput`'s reason (_naming the account on native_, below).
- **The keyboard offers only the generic Passwords key** on sign-in and the Account
  views, with no account suggested, even with two logins saved. Tapping it lists the
  saved logins to pick from.

#### ⚠ saving a new account's password

**Create account is never offered for saving in the app.** No sheet came with the
generated words kept, with a password typed over them, with the username and the
password field both kept editable while the account was being made, nor on a build
linked to the website (_the apps and the website are not linked_, below). The cause
was not found. Safari skips a value set by script, but a typed password went unsaved
too.

**So the welcome's check is where the save happens.** It is a login: the account's
name, the password typed or filled, and the field gone once it passes. With the
check's username made by `editable={false}`, iOS skipped it and offered nothing there
either, so **an account made in the iOS app had its password offered for saving
nowhere**, until its first sign-in on some device. With the username enabled (and
locked, `LockedUsernameInput`), passing the check raised **Save Password?**; saved, it
was filed under the right username, and that entry filled sign-in and signed in.
Measured 2026-11-04, on the build as shipped and on a linked one. It is the one save
the one-step form exists to give, at the moment it gives it: after the account
exists, with the password that opens it. `create-account.yaml` answers the sheet
(Not Now), and `welcome-gate.spec.tsx` pins the field. ⚠ Someone who skips the check
gets no offer at all, which the welcome's copy does not yet say.

#### ⚠ naming the account on native

bracemark-expo's change password and the welcome's check carry a username above the
password: `LockedUsernameInput`
(`src/components/locked-username-input.tsx`, inside `AccountUsernameField` on the
Account views), with `autoComplete="username"` and `textContentType="username"`. It
is **enabled, and locked by other means**: no touches reach it, no keyboard or caret
if it takes focus, no edit menu, `aria-disabled` for a screen reader, and a remount
with the account's name if something edits it anyway. Recovery code and delete
account have no username (_a password that only proves who you are_, below). jest pins the shape (`locked-username-input.spec.tsx`,
`account-username-field.spec.tsx`, `welcome-gate.spec.tsx`), and `NATIVE-ACCOUNT-003`
asserts it shows the signed-in account. On Android it is what
names the account (_the Android app_, below). On iOS, measured 2026-11-04:

- **`editable={false}` changed nothing.** iOS skipped the disabled field: recovery code
  and the welcome's check raised no sheet with it or without it.
- **Enabled, iOS reads it as the username.** The welcome's check then raised **Save
  Password?** (above). So did recovery code, for the current password, which is why
  it has no username now (below).
- **iOS offers no update on native change password at all.** No sheet came in any
  arm: no field, read-only, or editable; a saved login or none; a new password typed
  or the generated words kept; none after Settings closed; and none on a linked build.
  So on iOS the done screen's **Show my new password** is the only way the new
  password reaches a manager. Recovery code's form going away _does_ count as a
  submission, so the swap itself is not what blocks it.

### the Android app

Android asks its autofill service to fill when a field takes focus, and hands it a
structure of the screen: every field, its hints, and a redacted value. The service
decides what to suggest and whether to offer a save. React Native maps
`autoComplete` to the hints (`username-new` is Android's own; `off` is "not
important for autofill").

**`AccountUsernameField` is what names the account.** On change password the
structure holds an `EditText` hinted `[username]`, with the account's name as its
value, ahead of the `[password]` field. Without the field the password stands alone,
as it does on recovery code and delete account by design. `npm run
measure:autofill:android` reads this off `dumpsys autofill` ([e2e.md](./e2e.md),
_measuring the password manager_), and needs no account on the emulator.

**Google Password Manager, measured 2026-11-04** on the Pixel 8 AVD (Android 16,
Google Play services 26.37) with a Google account signed in, through Maestro and the
Password Manager's own screens. Without an account the service answers every
request with nothing: no suggestions and no save info.

| surface                                     | with `AccountUsernameField`                                                                          | without it       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| sign in                                     | **Save password to Google Password Manager?**, naming the account                                    | (same form)      |
| change password, typed new password         | the same sheet, naming the account; accepted, **that** login held the new password, and it signed in | no offer         |
| change password, generated words kept       | the same, and the stored words signed in                                                             | not run          |
| recovery code, a login not saved            | offers to save the current password, under the right name                                            | no offer         |
| delete account, a login not saved           | ⚠ offers to save the **deleted** account's password, twice                                           | no offer         |
| a proof field takes focus, two logins saved | both logins as keyboard chips; the field does not narrow them                                        | both, in a sheet |

So the field is what lets Google update the right login after a change, which on
iOS nothing does (_the iOS app_, above), and it is why recovery code and delete
account have none.
The sheet's title says _save_ even when it replaces a saved login's password.

- **It files the app's logins under `app.bracemark.com`**, the web app's domain, with
  no Digital Asset Links file published (_the apps and the website are not linked_,
  below).
- **After one "Not now", the next sheet offers "Never" in its place.** "Never" turns
  saving off for the app. A flow that dismisses the sheet presses Back instead.
- **It needs a screen lock** to show a saved password, and asks for it each time.
- ⚠ **With a Google account on the AVD, every e2e sign-in stops behind the sheet**,
  so the account and the PIN live on `bracemark-fold`, and the e2e preflight refuses
  a device with either ([app-drivers.md](./app-drivers.md), _the AVDs_, _the fold
  AVD_). Measure there.

### ⚠ a password that only proves who you are

Recovery code and delete account each ask for the current password, to prove who you
are, and nothing about it changes. A manager should **fill** it, and must **never
offer to save** it as the form goes away:

- **On delete account** the account is gone by then, so a save keeps a login for
  nothing. That is harmless only until someone trusts it.
- **On recovery code** there is nothing new to save. The offer comes as the form
  gives way to the code, so it reads as saving the code, which it is not: Chrome
  named the current-password field, and Google's sheet held a value the password's
  length, not the code's.

Every manager measured read these forms as a submission when it could tell whose
password it was. Every one but Safari stopped when it couldn't, and Safari stopped
when the login was already saved:

| manager, 2026-11-04                     | with the account's name beside the password                                                 | without it                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome 156 (`measure:password-manager`) | `ASK` on both, named by `HiddenUsername`                                                    | delete account: `ASK`, with no username                                                                                                                             |
| Google Password Manager, Android app    | **Save password?** on both; on delete account for the deleted account, twice                | nothing on either; the saved logins still suggested on focus                                                                                                        |
| iOS AutoFill, the app                   | **Save Password?** on both (an enabled username), on delete account for the deleted account | nothing on either; the Passwords key still lists them                                                                                                               |
| Safari 26.5.2, macOS (by hand)          | login saved: nothing on either; not saved: **Save Password?** on both                       | the same: nothing with the login saved; not saved, **Save Password?** with `one-time-code`, `autocomplete="off"` on field and form, or the field cleared on success |

So each platform does what its manager needs:

- **Web: `one-time-code` and no `HiddenUsername`.** Removing the name alone left
  Chrome asking, now with no username. `one-time-code` makes its parse
  fallback-only, as on the lock fields: no automatic prompt, and a click on the field
  still lists the saved logins to fill (_the lock password is not a login_, below).
  `measure:password-manager`'s `recovery-view` and `delete-account` flows expect no
  submission. **Safari is covered for whoever saved the login**, which is the case
  that matters: with the login saved, recovery code and delete account raised
  nothing, on the old markup and the new, and the `one-time-code` field still filled
  from the saved login. ⚠ With the login **not** saved, it offered **Save Password?**
  after both, with every markup tried, delete account included, for the account it
  had just deleted. It reads the typed password at the submit itself, so clearing the
  field once the request answers is too late. On recovery code that offer saves the
  right password; on delete account, a login for nothing. Left as it is: a masked text
  field would end the offer and also the fill, put the password in form history and
  the keyboard's learned words, and have a screen reader speak it (_the lock password
  is not a login_, below). A form-less proof (no `<form>`, Return handled in code) is
  untried; a scripted `click()` drew no offer, so it might.
- **Native: `current-password` and no `AccountUsernameField`.** Fill stays: Google
  suggests the saved logins on focus, and iOS lists them under the keyboard's
  Passwords key. `account-username-field.spec.tsx` pins the absence,
  `measure:autofill:android` reads it, and `NATIVE-ACCOUNT-004` would stop behind an
  iOS sheet if one came back.

What nothing here can do is remove a deleted account's login from a manager that
already holds it. That is the person's to do.

### ⚠ the lock password is not a login

A lock password (`LockPasswordDialog`, `LockPane`, [locks.md](./locks.md)) is a
secret, but not this app's login. A manager that saves it as the login overwrites
the saved copy of a password with no reset, and one that fills the login into a lock
field teaches the wrong habit.

- **Web says `one-time-code`.** ⚠ `off` does not cover it: Chrome ignores
  `autocomplete="off"` on a password field. Both surfaces were `off`. In a profile
  with the account's login saved, setting the app lock and leaving Settings made
  Chrome offer to **update** that login with the lock password, and the unlock field
  was offered the sign-in password. Chrome 155's parser counts a password field
  marked `one-time-code` as not-a-password. It still falls back to the field when the
  form has no other, but marks that parse fallback-only. A fallback-only form gets no
  automatic save prompt; Chrome shows only the omnibox key icon, which the user has to
  click. It is also not a login to fill, so nothing is filled or suggested when the
  field takes focus. That part was read from Chromium's source, not measured, because
  the measurement's fresh profile holds no saved login. **What it cannot stop:** a
  click on the field still lists the saved logins, because Chrome offers its saved
  logins on every `type="password"` field. The only way out of that is a field that
  was never a password field, and every way of building one is worse: a `type="text"`
  field with `-webkit-text-security` masking lands in Chrome's form history and in the
  keyboard's learned words, and a screen reader echoes it as it is typed. The field
  stays `type="password"`. Not `new-password` on the set dialog either: that token
  asks Chrome to **generate** a password and offer to save it, which is the bug.
  `measure:password-manager` has a flow for each lock kind, expecting no submission.
  The lock specs pin the token.
- **iOS says `textContentType="oneTimeCode"`.** ⚠ `off` does not cover it there
  either: React Native turns `off` into `textContentType="none"`, which states no
  purpose, so iOS Password AutoFill infers a password from `secureTextEntry`. With the
  account's login saved in Passwords, setting a lock and unlocking one each had iOS
  offer to **update** that login with the lock password. `oneTimeCode` names a purpose
  that is not a password, and the field is no longer saved from. It is set as
  `textContentType`, not as `autoComplete="one-time-code"`: an explicit
  `textContentType` wins over the mapped one on iOS, and `autoComplete` stays `off` for
  Android, where it means "not important for autofill" and `one-time-code` would
  become an SMS-code hint. The cost is that the QuickType bar may offer a code from
  Messages in the field. The two lock specs pin the type.
- **No username goes beside a lock field**, on either platform: naming the account
  there would file the lock password as its login.

### the apps and the website are not linked

Neither platform links bracemark-expo to the website's credentials: there is no
`webcredentials:` associated domain and no `apple-app-site-association`, and no
Digital Asset Links `assetlinks.json` ([hosting.md](./hosting.md)).

**Android does not need it for Google Password Manager**, which already files the
app's logins under `app.bracemark.com` (_the Android app_, above).

**iOS keeps them apart**: the Passwords app files the app's logins under **Bracemark**,
and Safari's under the site. The Safari entry can still be chosen by hand to fill
sign-in in the app.

**A linked build was measured, and it is not worth shipping as it stands.** Built
2026-11-04 with `webcredentials:app.localtest.me?mode=developer`, the association file
served from a throwaway HTTPS origin the simulator alone trusted (the recipe in
[app-drivers.md](./app-drivers.md), _driving Safari in the iOS Simulator_), and
approved by the simulator's association daemon:

- The app's login was filed under the site's domain, so Safari and the app share it.
  That is the whole gain.
- The keyboard still offered only the generic Passwords key, on sign-in and the
  Account views. Change password still raised no update.
- On the prefilled create-account field, no offer. ⚠ **On an empty one, iOS offered
  "Use Strong Password?"**, saying the password "will be saved in Passwords". Accepted,
  it filled the field, the account was made with it, and **nothing was saved**: the
  account's password was one the person never saw and nobody kept. Only the
  welcome's "Show it again" and its check stood between them and a lost account.
- Delete account, with no username, raised nothing.

So linking waits on the save at create account working in the app (_saving a new
account's password_, above). Shipping it would also need the association file on the
real domain, which [hosting.md](./hosting.md) notes the CloudFront function must pass
through by exact path.

### open

- **Safari offers to save on recovery code and delete account when the login is not
  saved**, whatever the markup (_a password that only proves who you are_, above). A
  form-less proof is untried. What Safari files such an entry under was not looked at,
  since it would land in a real profile.
- **Create account in the iOS app is never offered for saving**, cause unknown
  (_saving a new account's password_, above). The check covers it for whoever takes
  it. A later iOS may change this; re-measure on each major version.
- **iOS change password offers no update**, linked or not.
- **Safari's Layer 1 on "Sign in to check"**: not refuted, not confirmed; needs a
  profile with nothing saved or generated for the site (_how Safari tells a login
  from a sign-up_, above).
- **The expired-session sign-in's locked username** is still `editable={false}`
  (`sign-in-form.tsx`), so iOS skips it there too. Unmeasured.
- **A real iPhone**; everything native above is the simulator.
