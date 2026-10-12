## locks

The device-local **app lock** and **list locks** — a password gate the user can
put over the whole app or over an individual list (and its subtree). This doc is
the home for the feature that was previously explained only in code comments
(the two `lock-provider.tsx` headers, `LockRecord` in each app's `db.ts`, and
`computeCoverage`); other docs reference it in passing —
[editors.md](./editors.md) (why the pickers ignore hidden lists),
[account.md](./account.md) (the E2E substrate this sits _over_).

Both client apps implement it symmetrically: the web stack in
`@stxapps/web-react` (bracemark-web, bracemark-extension) and the Expo stack in
`@stxapps/expo-react` (bracemark-expo). The shared, platform-agnostic pieces — the
coverage math and the verifier parameters — live in `@stxapps/shared` /
`@stxapps/{web,expo}-crypto` so the two can't drift.

> **A word on the word.** "Lock" in this doc always means this password-lock
> feature. Don't conflate it with the **`locks` billing entitlement** (the Plus
> lever that gates _this_ feature), nor with the unrelated **"no lock-in"** export
> principle, nor the sync engine's R2 **clock**. The persisted rows live in a table literally named `locks`; that
> table holds _only_ these password verifiers.

### what it is — and, crucially, what it is not

A lock is a **shoulder-surfing deterrent, not encryption.** The security
substrate is the account's end-to-end encryption, which is **free for everyone**
(see [account.md](./account.md)); a lock is the convenience layer _over_
already-decrypted data — the plaintext links sit in IndexedDB (web) or
expo-sqlite + expo-file-system (native) one table over from the verifier. So:

- **The threat it addresses** is a borrowed/unattended _unlocked_ device — a
  friend scrolling your phone, someone glancing at your open laptop. It hides
  content behind a quick password; it does not defend against an adversary with
  the device and technical skill, who can read the decrypted rows directly.
- **This is why charging for it isn't charging for privacy**: E2E — the actual
  privacy guarantee — stays free; only the convenience gate is a Plus lever.

Everything below follows from that framing. Because a lock guards decrypted
data, the design optimizes for _feel_ (instant unlock) and _breadth of the gate_
(cover the whole subtree, exclude from every read path) rather than for
cryptographic strength it structurally can't provide.

### the verifier — `@stxapps/{web,expo}-crypto` `lock-verifier.ts`

A lock stores a **one-way verifier pair**, never the password:

- `createLockVerifier(password)` → `{ salt, hash }` (both hex): random 16-byte
  salt, **PBKDF2-SHA256 at 600 000 iterations** (OWASP's current recommendation),
  32-byte output.
- `verifyLockPassword(password, verifier)` re-derives and constant-time-compares.

Two deliberate choices:

- **PBKDF2, not the account's Argon2id.** A memory-hard KDF buys no real
  protection over already-decrypted data, and unlocking should feel _instant_
  (~100–300 ms) rather than cost the sign-in's ~1–3 s. Web runs
  `crypto.subtle.deriveBits` (non-blocking, no worker); native runs
  quick-crypto's callback-form `pbkdf2` (C++ `fastpbkdf2`, off the JS thread).
- **Store a hash, not the old reversibly-encrypted password.** The recovery path
  is identical (sign out) and a one-way hash is strictly better.

The verifier is **hex**, per the `@stxapps/shared` `crypto/encoding.ts`
convention (short binary crypto material is hex; base64 is for size-sensitive
payloads like images). Verifiers are device-local and never synced, so unlike
the account pipeline there is **no cross-platform byte contract** to pin — the
two `lock-verifier.ts` files just mirror the same parameters and encoding so they
read as one.

### storage — the `locks` table

One `LockRecord` per lock, in a device-local `locks` table
(`data/lock-store.ts` in each app):

```ts
interface LockRecord {
  id: string; // 'app' (APP_LOCK_ID) for the app lock, else the locked list's id
  kind: 'app' | 'list';
  salt: string; // hex verifier pair
  hash: string;
  hideList?: boolean; // list locks only — see "hide" below
}
```

- **Keying.** The app lock is the single constant row `APP_LOCK_ID = 'app'`. List
  locks are keyed by their **list id** (stable across renames; a system-list
  constant or a random token — neither collides with `'app'`).
- **Same shape on both platforms**, deliberately, so `@stxapps/shared`'s
  `computeCoverage` sees one type. (The expo store maps drizzle's `null` ⇄
  `undefined` for `hideList` at the boundary so the in-memory shape matches web's
  optional field.)
- **Never synced; wiped on sign-out** (`clearData`) — which _is_ the
  forgot-a-password recovery path. From the app-lock pane that sign-out is taken
  with no way to sync first, so the sign-out flow syncs for it
  ([data-lifecycle.md](./data-lifecycle.md), _the press, and the wait_).
- **Native uses expo-sqlite, NOT expo-secure-store — on purpose.** A verifier is
  a one-way pair guarding already-decrypted data, so it needs a _queryable_
  device-local table, not credential storage. secure-store also fights the shape:
  no key enumeration, a ~2 KB per-entry Android cap that N list locks would
  breach, and iOS-Keychain survival across uninstall that plain app data
  correctly lacks.

`lock-store.ts` is pure read/write (no network, no React). Reactivity and the
in-memory unlocked state are the provider's job.

### coverage — `@stxapps/shared` `sync/lock-coverage.ts`

A lock on a list **covers its whole subtree.** Otherwise Show All / tag views /
search would leak the children's links and the lock would be decorative. The
coverage walk is a **pure function** (`computeCoverage`), split out of the
providers so it's unit-testable without React or a store and **shared by both
platforms** so the semantics can't drift (`lock-coverage.spec`).

Given the list tree, the lock rows, and the set of currently-unlocked ids, it
resolves per list:

- **`lockedListIds`** — every list whose links are gated (covered by a locked
  lock, **descendants included**).
- **`hiddenListIds`** — the covered lists that should also disappear from the
  sidebar and pickers (the subset whose covering lock — or a locked ancestor —
  set `hideList`).
- **`coveringLockIds`** — covered list id → the **nearest locked self-or-ancestor**
  lock row. This is the lock a password prompt for that list verifies against.

The walk carries the nearest locked ancestor's lock id down the tree: an
**ancestor lock wins** as the covering lock (you must open the outermost door
first; an inner lock takes over on the recompute _after_ that unlock). `hideList`
propagates from any locked ancestor, and a list's own locked `hideList` applies
even under a non-hiding ancestor lock.

The walk keeps its own stack rather than recursing, because the forest is as
deep as the library's `parentId` chain and this runs above every signed-in
screen ([data-lifecycle.md](./data-lifecycle.md), _import_). It walks the **same
forest the screens render** — never a flattened or depth-capped copy. Either
would be the easy way to bound the work and would detach a deep list from the
lock that covers it, showing its links; a display limit belongs in what a ROW
draws, not in the tree coverage reads — which is where the one that exists
lives (`TREE_ROW_MAX_LEVELS`: a picker row's ancestor path and guide lines).

### unlocked state is in-memory only — the load-bearing invariant

The one thing the store deliberately does **not** persist is _which locks are
currently open._ The provider holds `unlockedIds` as plain in-memory React state
(`markUnlocked` / `markLocked`). Consequences, all intended:

- **Every lock re-engages on reload (web) / relaunch (expo) by construction** —
  there is no "stay unlocked" persistence to get wrong.
- Verification reads the row **fresh from the store** (not the live-query
  snapshot) so a just-written lock is always verifiable.
- `unlockList` tries the list's **own** row first, then its **covering** lock, so
  one password opens whichever it belongs to (settings' per-row "Unlock…" matches
  the row it names; the main pane's prompt opens the outer door).

**bracemark-expo strengthens this with auto-relock (expo-only).** Web relies on
tab-close to re-engage locks — a naturally short session. A mobile process keeps
`unlockedIds` in memory across backgrounding, so an unlocked, backgrounded phone
handed to someone would stay open. So the expo `lock-provider` runs the
**"time-based + app-state" rule as one mechanism**: it stamps the time on the
`AppState` `background` transition, and on the next `active` transition drops
**every** session unlock if the app was away longer than a grace window
(`AUTO_RELOCK_AFTER_MS`, 60 s). It's keyed off the `background` transition (not
the transient iOS `inactive`) and gated on elapsed time on purpose — so Control
Center, the biometric/permission sheet, a call, or a 2-second app-switch never
force a re-unlock, while a genuinely-away device relocks. This is a **justified
platform divergence** (web has no auto-relock), and it _strengthens_ the
in-memory-unlock invariant rather than contradicting it. Natural companion, not
yet built: **biometric unlock** — aggressive auto-relock is only pleasant when
re-entry is a glance, not a password.

### the two enforcement edges

Coverage feeds exactly two places. Everything else about locks is chrome.

**1. `lockedListIds` → the link query's `lists.none` (the read edge).** In
`use-links`, the covered ids fold into the query's exclusion so **every read
path — browse, Show All, tags, search, pins — drops the covered links
uniformly.** This is _enforcement_: no query can opt out (unlike Trash, which a
`?list-any=trash` view can opt into). The grammar-level shaping lives in
`excludeLists`, which preserves the read's fast path — a positive list view (My
List, a user list) keeps its exact-count fast path because the suppressed ids
aren't in its `any`; Show All and tag/search views pay a `lists.none` clause.

On top of that, a **locked _selected_ list swaps the whole main-pane body** for
the unlock pane (`LockPane`) **before the data hook mounts** — the web
`ListLockPane` component / the inline swap in bracemark-expo's `main.tsx`, with
`UnlockedMain` kept separate precisely so `useLinks` never runs while locked. The
locked list's links are then never fetched, never in the DOM (find-in-page,
screen readers). Deep links that merely _include_ a locked list (`?list-any=…`,
tags, search) don't swap — their queries exclude the locked links instead.

**2. `hiddenListIds` → sidebar/picker pruning (navigation only).** The covered
lists whose lock hides them are pruned from the sidebar tree — a pure declutter.
The link editors' list pickers deliberately **do NOT** prune these (see
[editors.md](./editors.md)): hiding a list never blocks _filing_ a link into a
list you know exists, and the pickers must stay consistent with the browser
extension, which — locks being device-local — can't know a web device's hidden
lists anyway. So: **a lock gates a list's contents; hide only tidies the sidebar;
neither touches the pickers.** (`buildShareLists` filters only Trash and never
reads locks.)

### mutations, relock, and the entitlement gate

The provider exposes:

- **Set up** — `setAppLock` / `addListLock(id, pw, { hideList })`: create a
  verifier, write the row. `setAppLock` marks the app **unlocked** for this
  session (enabling from settings must not slam the gate shut on the spot; it
  engages next load). `addListLock` marks the list **locked** — "Lock" means lock
  _now_, dropping any stale unlock for that id.
- **Remove** — `removeAppLock` / `removeListLock`: verify, then delete; `false` =
  wrong password. Remove **leaves the session unlock in place** — the row and the
  unlock are two stores that land at different times (the unlock is React state,
  the row a live read that re-runs a beat after the delete), so dropping the
  unlock there left one commit reading "lock exists, not unlocked": the app-lock
  pane blinked up over the Settings screen that had just removed the lock, and an
  unlocked list's links left every query and came back. The id left behind is
  inert — every derived value consults it only for a row that exists — and a later
  set-up overwrites it either way (`lock-provider.spec`).
- **Unlock** — `unlockApp` / `unlockList`: verify, mark unlocked; `true` opens it.
- **Relock** — `lockApp` / `lockList`: drop this session's unlock so the gate
  closes **without a reload/relaunch**. No password (relocking is free), no store
  write. These live on the `Locks` interface **beside their inverses**
  (`unlock*`), as session interaction — not on `LockMutations`, which is the
  persisted-write surface. On expo they also record that the relock was made **by
  hand** (_a hand relock does not ask to be undone_, below).

**Entitlement.** `locks` is a **Plus** lever. It's gated **at
the affordance**, before any password dialog opens, so a free user never types a
secret into a form that can't submit. **Unlock and remove stay open even for a
downgraded (ex-Plus) account**, so an existing lock is never stranded.

The password dialog distinguishes creation from verification. Settings passes
`mode="create"` only for **Set app lock** and **Lock list**: the submitted
password and hide option stay fixed until saving finishes, with editing restored
on failure.
Web keeps the password focused with `readOnly`; native disables editing for this
commitment. Unlock/remove verification stays editable to preserve retry focus.
Both the dialog and the browsing pane show an attempt's error only if the field
still holds the text that attempt submitted — compared by value, so an edit that
was undone meanwhile still gets its refusal — and retry uses the current value.
Component specs pin these cases on both clients.

### biometric unlock (expo-only)

Face ID / Touch ID as a **fast-path over the password**, on bracemark-expo only (web
has no equivalent; native biometry via `expo-local-authentication`). The design
turns on one decision:

**Biometric is a boolean gate, not a released secret.** Since a lock guards
already-decrypted data and derives no key, biometric success just flips the same
in-memory unlock a password would — **nothing is stored behind the biometry.**
The alternative (stash the password in a biometric-gated Keychain item, release
and verify it) would materialize a plaintext password at rest that the design
avoids, for zero gain: its usual advantage — the OS cryptographically gates the
secret so a hooked `authenticateAsync` on a rooted device can't bypass it — is
moot here, because an attacker who can hook LocalAuthentication on a rooted device
can already read the decrypted SQLite/files directly. So the boolean gate's trust
boundary exactly matches the feature's, with no secret at rest.

Consequences, all deliberate:

- **The password is always the root credential; biometric is opt-in on top.**
  There is no biometric-only lock — biometry is unreliable (bad read, re-enroll,
  the iOS "5 fails → passcode" lockout), and with no knowledge-factor fallback the
  only recovery would be sign-out (wiping every lock). So a lock is _always_
  created with a password; `biometric` is a per-lock opt-in flag layered over it.
- **Disabling biometric never unlocks.** It just clears the flag; the password
  lock stays and stays engaged. "Disable Face ID" (free toggle) and "Remove lock"
  (password-gated, actually unlocks + clears) are distinct — the clean split is
  only possible _because_ the password always exists.
- **`disableDeviceFallback: true`.** The fallback for a bracemark lock is the app's
  own password field, never the device passcode (a different factor — letting it
  through would let anyone with the phone PIN open every lock).

**Storage & API.** An expo-only `biometric?: boolean` on the `locks` row (beside
`hideList`; the shared `CoverageLock` slice ignores it, so `computeCoverage` is
untouched). The provider probes the device once (`getBiometricCapability` →
`biometricAvailable` + a `biometricLabel` like "Face ID"), and exposes
`unlockAppWithBiometric` / `unlockListWithBiometric` (OS prompt → the same
`markUnlocked` path; the list variant resolves the covering lock like
`unlockList`) plus `setAppBiometric` / `setListBiometric` (enabling runs one OS
confirm first, so a lock never promises biometry the device can't deliver). The
thin `expo-local-authentication` wrapper is `expo-react` `lib/biometric.ts`.

**The label names a sensor only when there is one to name.** iOS has exactly one
biometry per device, so it reads "Face ID" or "Touch ID". Android reports the
sensors the _hardware_ has — not which is enrolled — and `BiometricPrompt` chooses
the modality itself, so a phone with both a face camera and a fingerprint reader
reads "Biometrics"; a lone sensor reads "Fingerprint" or "Face Unlock". Preferring
face there labelled the toggle "Face Unlock" for a user who had enrolled only a
finger.

**Where it surfaces.** The `LockPane` (app gate + locked-list pane)
**auto-prompts once on mount** when the gating lock has opted in — unless the
lock was re-engaged by hand a moment ago (next section) — with a "Unlock
with {label}" button and the password field as the ever-present fallback; a
cancel drops to the password, never loops. Enable/disable lives in Settings — a
Switch in Misc (app lock) and an "Enable/Disable {label}" item in the Lists row
kebab (per list). Toggling it needs no entitlement (creating the lock was the
paywalled step). This is what makes the 60 s auto-relock pleasant — re-entry is a
glance, not a password. Native module → `expo prebuild` + a real device with
enrolled biometry to exercise; jest/Metro can't drive the prompt.

### a hand relock does not ask to be undone (expo-only)

A `LockPane` does two things unasked as it goes up: it autofocuses the password
field, which on native raises the keyboard, or — when the lock has opted in — it
runs the biometric prompt. Both are the pane **asking for the unlock**, and both
assume the person in front of it wants in. That holds for every way a pane goes
up except one: the user pressing "Lock now" or "Lock app".

The specimen is the drawer's "Lock now" on the list being shown (or on an
ancestor whose lock covers it). `Main` swaps to the pane underneath the drawer,
which stays open — the press deliberately neither selects the row nor closes the
rail — so the autofocus raised a keyboard over the drawer, typing into a field
nobody could see. With biometric enabled the same mount ran the OS prompt
instead: the lock asked to be reopened in the same second it was closed, and
Face ID needs no further act from the user to say yes. "Lock app" in the topbar
overflow reaches the same pane through `AppLockGate` and had both halves.

**The fix is not to close the drawer** — locking a list you are not viewing
changes nothing on screen, locking several in a row is the affordance, and the
row's badge already confirms the press — **and not to drop the autofocus**, which
is right on arrival ([soft-keyboard.md](./soft-keyboard.md), _arrival_). It is to
know why the pane is up:

- **The provider keeps the fact.** `expo-react`'s lock-provider holds a second
  in-memory set beside the unlocked one: the locks re-engaged **by hand**.
  `lockApp` / `lockList` are its only writers. An id leaves when its lock is
  opened; the auto-relock empties the set (past the grace window every engaged
  lock is the auto-relock's, whoever closed it first); a fresh `addListLock`
  drops any mark an earlier lock on that list left. It surfaces as
  `appLock.lockedByHand` and `isListLockedByHand(listId)`, the latter resolving
  the **covering** lock like `biometricForList` — "Lock now" sits on the row that
  owns the lock, while the pane is asked about the list being shown.
- **The host decides.** `LockPane` takes `solicit` (default `true`), which gates
  the autofocus and the auto-prompt together and nothing else — the field and the
  biometric button are still there, one tap away. `AppLockGate` passes
  `!appLock.lockedByHand`. `Main` needs a second fact only it has: whether the
  pane went up **in place**, over a list it was already showing open. It takes
  both to stay quiet:

  | the pane went up…                            | in place | by hand | asks? |
  | -------------------------------------------- | -------- | ------- | ----- |
  | "Lock now" on the list being shown           | yes      | yes     | no    |
  | the background auto-relock                   | yes      | no      | yes   |
  | a list locked from the drawer, visited later | no       | yes     | yes   |
  | a row press, a deep link, back, the landing  | no       | no      | yes   |

  The second row is why "in place" alone is not the test — the prompt on return
  is what makes the auto-relock bearable — and the third is why "by hand" alone
  is not: the mark stays on the lock until it is opened, and must not follow the
  user into an arrival. Leaving a list locked in place and coming back is an
  arrival too.

- **The answer is read once, on the way up.** `LockPane` latches `solicit` at
  mount. The host's answer can change under a pane that is still up (the
  auto-relock clears the mark), and a pane that started quiet must not summon a
  keyboard or a Face ID sheet later, unprompted.

`Main` also keys the pane by list id. Going from one locked list straight to
another used to reuse the one instance: the second list inherited the password
typed for the first and got no focus and no prompt of its own.

**Web has the same press and a different problem, so it takes a different fix.**
It has no biometric prompt, and in the two-pane layout the autofocus is right
even after "Lock list": the button that was pressed unmounts with the press, and
the password field is a better place for focus than `<body>`. Below `md` the
rail is a sheet (`sidebar-drawer.tsx`), and there the same autofocus pulled focus
out of the open sheet's trap and into the page the sheet had marked
`aria-hidden` — a focused field no screen reader can reach, and on a phone a
keyboard for an input behind the scrim. The trap does not pull it back: the
element it would return to is the "Lock list" button, which that commit removed.
So web's `LockPane` asks one question native has no way to ask — is a modal open
over me? — and focuses from an effect only when none is, instead of carrying the
`autoFocus` attribute. No by-hand set, no `solicit`: "Lock app" keeps its focus
on every viewport, which on a touch device may still raise the keyboard. The
effect is passive because "Lock app" is chosen from a menu that is modal too and
unmounts in the same commit; its `aria-hidden` comes off in that commit's effect
cleanups, which run first. Web's `Main` keys `ListLockPane` by list id for the
reason expo's does — the carried-over password was measured there.

Pinned by `expo-react`'s `contexts/lock-provider.spec.tsx` (the set's writers and
erasers), `features/links/main.spec.tsx` (the table above) and
`components/lock-pane.spec.tsx` / `app-lock-gate.spec.tsx`; web's guard by
`bracemark-web`'s `components/lock-pane.spec.tsx`. The browser case
`LOCK-FOCUS-WEB-001` checks direct navigation between locked lists (empty, masked
entry on the second) and a narrow-viewport relock under the open drawer, including
transient focus into the hidden pane. `LOCK-APP-001` checks password focus after
a cold load and after the overflow menu closes. Native `LOCK-APP-002` measures the
keyboard between flow parts: up on cold start, down on manual relock, with
explicit password entry still reopening the app.

**Driven on both native platforms** — the Pixel 8 AVD (Android 16) and the
iPhone 17 Pro simulator (iOS 26.5), dev build, reading the keyboard's state
rather than a screenshot:

| the pane went up by…                             | Android               | iOS                  |
| ------------------------------------------------ | --------------------- | -------------------- |
| a row press on a locked list (arrival)           | keyboard up, focused  | keyboard up          |
| "Lock list" on the list being shown, drawer open | no keyboard, no focus | no keyboard          |
| …then the drawer closed                          | pane up, no keyboard  | pane up, no keyboard |
| leaving that list and coming back                | keyboard up, focused  | —                    |
| "Lock app"                                       | no keyboard, no focus | no keyboard          |
| a cold start behind the app lock                 | keyboard up, focused  | —                    |

A refused password keeps the keyboard up with the error showing — on the lock
dialog on both platforms, and by the pane's Unlock button on Android's list pane
and iOS's app gate (iOS's list pane puts that button under the keys). Not driven:
the biometric half, which needs enrolled biometry neither device has, and the
background auto-relock. The web half was driven in headless Chrome at 390 and
1280 wide, reading `document.activeElement` before and after the change; a soft
keyboard itself, and Safari — which does not focus a button on tap, so its trap
may behave differently — were not.

### UI surfaces

| Surface                                                | Web                                                                | Expo                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------- |
| Set/remove **app lock**                                | Settings → Misc                                                    | Settings → Misc                       |
| Lock/unlock/remove **list lock** (+ `hideList` opt-in) | Settings → Lists (row kebab)                                       | Settings → Lists (row kebab)          |
| **Relock a list** ("Lock now")                         | Sidebar row — hover/focus-revealed, and always on a coarse pointer | Sidebar row — always shown (no hover) |
| **Relock the app** ("Lock app")                        | Topbar overflow menu                                               | Topbar overflow menu                  |
| **Unlock a browsed list**                              | Main-pane `LockPane` swap                                          | Main-pane `LockPane` swap             |
| **App lock screen**                                    | `AppLockGate` (content swap)                                       | `AppLockGate` (content swap)          |
| **Biometric unlock** (Face ID / Touch ID)              | —                                                                  | `LockPane` auto-prompt + button       |
| **Enable/disable biometric**                           | —                                                                  | Misc (Switch) / Lists row kebab       |

The relock affordances split by scope on purpose: a list relock is contextual, so
it lives on the row; the app lock isn't a list, so its relock lives in the
app-global overflow menu, not the rail. The password dialog behind every _edit_
is one shared `LockPasswordDialog`; the _unlock_ surfaces users hit while
browsing are the in-place `LockPane`, not that dialog.

Both take the password through **`PasswordInput`**, the same show/hide field the
auth forms use, on both platforms — a lock password has no recovery beyond signing
out (which wipes every lock), so a typo at set-time is as expensive here as it is
in the account ceremony. The reveal is default-off per mount and must stay that
way: the onlooker in the threat model above is the person who'd be reading it.
See `docs/account.md`, _every field that takes a secret reveals it_.

`AppLockGate` is a **content swap, not a redirect**, mounted above
`InitialSyncGate` so the lock screen is the first thing shown and the first sync
proceeds behind it. Its `'checking'` phase (the first locks read) renders
**nothing** — the same no-flash guarantee as the sync gate: a device with no app
lock must never flash a lock screen, and a locked one must never flash the app.

**On bracemark-expo a relock hides the app; it does not unmount it.** The gate
sits inside the `(app)` route with that group's `Stack` as its child, and "Lock
app" and the background auto-relock both engage it while that navigator is live.
Swapping it out there and back in on unlock left a navigator with no screen — a
blank app on iOS and Android, found by `LOCK-APP-002` — so once the app has been
shown, the gate keeps its subtree mounted inside a `display: none` wrapper while
the pane is up. That is not painted and is dropped from the accessibility tree on
both platforms, which is the absence the swap gave; the links stay in memory,
which the threat model above already concedes. A cold start is unchanged — the
app is not mounted before the first unlock — and `app-lock-gate.spec.tsx` pins
both halves. Web keeps the plain swap, and its menu relock followed by an unlock
lands back on the page it left (`LOCK-APP-001`).

#### overlays over a relock

**`display: none` hides the subtree, not what the subtree opened.** An overlay
open when the relock lands — the usual case is the auto-relock, since the user
backgrounded the app with it up — is drawn wherever its channel draws, and three
channels were measured on the iOS simulator and the Android emulator by opening
each, backgrounding past the grace window, and foregrounding:

| channel                                             | iOS                    | Android                |
| --------------------------------------------------- | ---------------------- | ---------------------- |
| the kit's Dialog / AlertDialog / DropdownMenu       | **over the pane**      | **over the pane**      |
| react-native `Modal` (the advanced-search sheet)    | hidden                 | **over the pane**      |
| router modal (`edit-link`, `presentation: 'modal'`) | hidden — and dismissed | hidden, back on unlock |

The kit's overlays portal to the root `PortalHost`, outside the gate — on iOS
inside a `FullWindowOverlay`, where the leaked menu also hid the pane from the
accessibility tree (Maestro could not find `app-lock-pane` behind it). An Android
`Modal` is its own dialog window. Both stayed painted and tappable over "Bracemark
is locked", which the swap had never allowed.

The fix is per channel, not per call site, so a new dialog cannot miss it. The
gate provides `useAppCovered()` (`contexts/app-cover.tsx`) to its
subtree, and the three kit content components render `null` while it is set; the
caller still owns the open state, so the overlay comes back on unlock (a field
typed into inside it does not — the content remounted). The one `Modal` gates `visible` on
the same flag, keeping its draft in the component that owns the sheet. What makes
it hold for the next overlay is lint: the app's ESLint config forbids
`@rn-primitives/*` outside `src/components/ui` and a bare `Modal` from
`react-native`, so an overlay has to come through the kit or say why not. Lint
only routes it there; `components/ui/overlays-under-relock.spec.tsx` checks that
the kit then honours the flag — one row per portaled surface, covered → gone and
uncovered → back, so a new kit overlay joins by reading the flag and adding its
row.

The flag outlasts the pane by one thing: **the pane's keyboard.** A password
unlock uncovers the app in the same commit the keyboard starts to hide, and the
advanced-search sheet, re-presented into that commit, seeded its `StickyFooter`
lift from the keyboard that was up, missed the hide, and left Clear/Search
stranded a keyboard's height up an empty screen (Android, measured). So the gate
holds `covered` until keyboard-controller reports the keyboard hidden; a
biometric unlock, with no keyboard, releases at once. `app-lock-gate.spec.tsx`
pins the hold.

The router modal needs nothing, but iOS **dismisses** it rather than hiding it:
an unsaved edit in the link editor is lost to an auto-relock there, while Android
brings the editor back as it was. The navigator is consistent afterwards — the
editor reopens and closes normally. Web has none of this: its swap unmounts the
app, and a portaled Radix dialog with it.

### web / expo parity

The providers are mirrored; the shared coverage math and verifier parameters keep
them honest. The divergences are all platform-shaped:

|                       | web (`web-react`)                       | expo (`expo-react`)                       |
| --------------------- | --------------------------------------- | ----------------------------------------- |
| Store                 | Dexie `locks` table                     | expo-sqlite + drizzle                     |
| Reactivity            | `useLiveQuery`                          | drizzle `useLiveQuery` (change listener)  |
| Verifier crypto       | Web Crypto `subtle`                     | `react-native-quick-crypto`               |
| Locked-list pane      | `ListLockPane` component                | inlined in `main.tsx`                     |
| "Lock now" affordance | hover-revealed                          | always shown                              |
| Auto-relock           | — (tab-close relocks)                   | background-elapsed (`AppState`)           |
| A relock by hand      | pane takes no focus under an open modal | `handLockedIds` → a pane that doesn't ask |
| Biometric unlock      | —                                       | `expo-local-authentication`               |

One shared subtlety in both: an **orphan sweep.** List deletion _syncs_ from
other devices while locks are device-local, so a lock can outlive its list. Both
providers sweep orphaned list-lock rows — guarded to a ready store with a
resolved, non-empty tree (an empty tree means "still loading", and sweeping then
would wrongly drop every list lock).

### where the code lives

- **Shared:** `@stxapps/shared` `sync/lock-coverage.ts` (`computeCoverage`).
- **Verifier:** `@stxapps/web-crypto` and `@stxapps/expo-crypto`
  `lib/lock-verifier.ts`.
- **Provider + store:** `contexts/lock-provider.tsx`, `data/lock-store.ts`, and
  the `LockRecord`/`locks` table in `data/db.ts` — in both `web-react` and
  `expo-react`.
- **Read-edge fold:** each app's `use-links` (`lockedListIds` → `excludeLists`).
- **UI:** the settings Misc/Lists sections, the links sidebar + overflow menu,
  `app-lock-gate.tsx`, `lock-password-dialog.tsx`, `lock-pane.tsx`, and (web)
  `list-lock-pane.tsx`.
- **Copy:** `@stxapps/react` `lib/lock-copy.ts` — every word the pane and its two
  gates print, in one place because the two `LockPane` implementations are hand
  ports of each other with no shared ancestor. Edit the words there, not at the
  call site; the biometric button stays inline, being native-only.
- **Biometric (expo-only):** `expo-react` `lib/biometric.ts` +
  `expo-local-authentication` (config plugin in `app.config.ts`); the `biometric`
  column in expo's `data/db.ts` / `lock-store.ts`.
