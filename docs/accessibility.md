## accessibility

How the apps name, announce, and scale things for assistive technology. This doc
is the home for a set of rules that were previously spread across component
headers (`field.tsx`, `error-text.tsx`, `font-scale.ts`) with no index — which is
how the announcement rule below came to be honoured at 4 of bracemark-expo's 17
error sites and missed at the other 13, with the web side about as even.

The scope is the **cross-cutting** conventions: what announces, what must not,
what carries an accessible name, and the font-scale ceiling. Per-surface
accessibility that only makes sense in context stays with its own doc —
[share-sheet.md](./share-sheet.md) (`ShareRow`'s label/value announcement),
[editors.md](./editors.md), [locks.md](./locks.md), [theme.md](./theme.md)
(contrast and the `data-[selected=true]` variant trap).

> **A note on ARIA-shaped props in Expo.** React Native accepts `role`,
> `aria-label`, `aria-live`, `aria-invalid` and friends, and it is tempting to
> read them as the web attributes. They are not. RN maps them onto
> `accessibilityRole` / `accessibilityLabel` / … , which are then mapped again
> onto each platform's native accessibility API — and that second mapping is
> lossy in both directions. Where it matters, this doc says so.
>
> **An unsupported `aria-*` prop is silent, not an error.** RN declares exactly
> fourteen: `aria-busy`, `aria-checked`, `aria-disabled`, `aria-expanded`,
> `aria-hidden`, `aria-label`, `aria-labelledby`, `aria-live`, `aria-modal`,
> `aria-selected`, and the four `aria-value*`. Anything else — `aria-current`,
> `aria-describedby`, `aria-controls` — type-checks, renders, and does nothing.
> Porting a web surface by copying its attributes across is how you get a prop
> that looks right in the diff and announces nothing; both sidebars carried an
> inert `aria-current` that way. When in doubt, reach for `accessibilityState`,
> whose shape (`{disabled, selected, checked, busy, expanded}`) is the honest
> list of what native actually models.

### the one rule: an error that appears must announce

**Any message that MOUNTS as the result of a user action carries
`role="alert"`.** The failure it prevents is specific: a user presses Save, the
button finishes and re-enables, one line of red text appears somewhere on screen,
and a screen-reader user gets no indication that anything happened at all. The
button just silently becomes pressable again. Colour is not an announcement, and
neither is position.

This is the rule most likely to be missed, because **nothing catches it**: there
is no lint rule for it, no type error, no failing test. It is a
[tripwire](../CLAUDE.md) in the same sense as the others — the diff looks fine.
So the rule is enforced by making the correct spelling the _only convenient_ one,
per platform:

| where                     | carrier                         | notes                                                                                                              |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| web, inside the Field kit | `<FieldError>`                  | `ui/field.tsx` — renders `role="alert"`; returns `null` on empty content, so no ternary is needed at the call site |
| web, settings sections    | `<SettingsNotice tone="error">` | `settings/_components/settings-kit.tsx` — the role rides `tone === 'error'` only                                   |
| web, anywhere else        | `<p role="alert">`              | the lock surfaces, `link-add-surface`                                                                              |
| expo, anywhere else       | `<ErrorText>`                   | `components/error-text.tsx` — the single carrier                                                                   |
| expo, settings sections   | `<SettingsNotice tone="error">` | `features/settings/settings-kit.tsx` — only where the web twin uses one too (see below)                            |
| bracemark-extension       | `<div role="alert">`            | two sites; the popup and options page are too small to earn a component                                            |

Web has three carriers rather than one because `FieldError` is a member of the
vendored shadcn **Field kit**, and the Field kit is deliberately not used
everywhere — the settings sections and the link editors use a plain
`Label` + `Input` column on purpose (`ui/field.tsx` explains why). Migrating them
to `Field` just to reach `FieldError` would buy machinery they don't need. The
bare `<p role="alert">` is the honest fallback, not a lapse.

Expo has no Field kit at all, so there was nothing to compose with and no reason
for more than one spelling — `ErrorText` is the carrier, and the settings
`SettingsNotice` is the single exception.

**Which of the two, on expo, is decided by the web twin**, not by which folder the
file sits in: a site whose web counterpart is `<SettingsNotice tone="error">` gets
one here too, and a site whose counterpart is a bare `<p role="alert">` gets
`ErrorText`. Both announce, so this is never an accessibility bug — it's weight.
`SettingsNotice` is a filled `bg-destructive/10` block and `ErrorText` is a line of
red text, and the same failure wearing a different weight on each platform is the
kind of drift that has no symptom until you put the two screens side by side.
`account-section.tsx` was where it had happened — three views carrying a filled
block against web's plain line, in a file whose other four error sites already
used `ErrorText`.

`ErrorText` is **not** named `FieldError`. Most of the sites it serves pair with a
bare `<p>` on web, so the name would promise a twin that isn't there — and this
repo leans hard on twin comments, so a false lead costs real time.

### the corollary: a `disabled` button says nothing either

The rule above is about the message that appears. Its mirror image is the message
that never gets a chance to: a submit that sits `disabled` because a required
field is empty tells a screen-reader user nothing at all — `disabled` drops it
from the tab order, `disabled:pointer-events-none` kills hover, and there is no
state change to announce. It is the same failure as an unannounced error, one step
earlier. So a submit is only allowed to be disabled when something adjacent and
permanent already states the blocker (a message line, a labelled checkbox, a
notice), or while its own request is in flight — and then the pending state rides
in the **label**, not in the dimming. The full rule, and the audit of the credential
surfaces it came from, is in [account.md](./account.md), _when a submit is allowed
to be `disabled`_.

### what must NOT announce

`role="alert"` is assertive: it interrupts. Applying it to text that changes
often, or that was already on screen, turns a screen reader into a stutter. Four
categories are deliberately silent:

- **Live verdicts that re-word as the user types.** The password-strength message
  (`create-account-form`, both platforms) changes on every keystroke; the
  keystroke itself is the user's feedback, and an announcement per character
  fights the typing echo. It is a plain `FieldDescription` / `Text` tinted by
  `MESSAGE_TONE`.
  - The **username availability** verdict next to it _does_ get
    `aria-live="polite"` — not because it is an error, but because it arrives
    asynchronously, without the user having typed anything, and a polite live
    region announces at the next pause instead of interrupting. The distinction
    is **who caused the change**, not how bad the news is.
- **Standing prose.** "This action cannot be undone." is red, permanent, and part
  of the page. It was on screen before the user did anything.
- **Persistent status.** The sync card's detail line (`data-section.tsx`) is red
  when sync is blocked, but it is a state the card always reports, not an event.
  If it ever needs announcing, `aria-live` on the card is the tool — not `alert`.
- **Colour that is only colour.** The "payment issue" label, destructive
  dropdown items, `CircleAlert` tints, `variant="destructive"` buttons. Red is
  not a role.

The tone-guard in both `SettingsNotice`s encodes exactly this: `error` announces,
`info` and `pending` do not. The first category has one extreme case — a value
that re-words ten times a second — which gets its own section below,
_the first-sync counter_.

### the iOS asterisk — `role="alert"` is not portable

On the web, `role="alert"` is an implicit `aria-live="assertive"` region and
works everywhere.

On React Native, `role="alert"` compiles to `accessibilityRole="alert"`, which
**TalkBack announces and VoiceOver ignores** — iOS has no equivalent trait. So on
iOS the role is documentation of intent, not behaviour.

This is the single most important reason `ErrorText` is a component rather than a
prop typed at each call site. If iOS needs to actually speak these messages, the
fix is `AccessibilityInfo.announceForAccessibility` in an effect keyed on the
message text, and `components/error-text.tsx` is the one place to add it —
one effect instead of seventeen. **That work has not been done**; iOS behaviour
today is the same as it was before the component existed. The component is what
makes it a one-file change when someone decides to.

Don't "fix" this by putting `role="alert"` on a wrapping `View` instead: an
un-`accessible` View contributes nothing to announce, and marking it `accessible`
collapses its children into a single node, which breaks any interactive content
inside. The role belongs on the `Text` that holds the message. `ErrorText` does
this, and `SettingsNotice` puts it on the message `Text` for string children —
a **non-string** child there has to carry its own.

### the first-sync counter — a value that must not speak

The decrypting screen (`initial-sync-gate.tsx`, both platforms) is the one place
in the app that renders a number changing ten times a second, and it is the
clearest case of the two rules above pulling in opposite directions on one screen.

The **count** is `role="progressbar"` carrying `aria-valuemin` / `aria-valuemax` /
`aria-valuenow` / `aria-valuetext`, and it is **not** a live region. Putting
`aria-live` on it would be the password-strength mistake — a verdict that re-words
continuously — multiplied by however many blobs the library holds; a screen-reader
user would get a solid wall of numbers instead of a usable screen. A progressbar
is read when the user reaches it, which is the behaviour that was wanted. Note
that this is one of the few places the ARIA-shaped props survive the trip into
native intact: `role="progressbar"` and all four `aria-value*` are on RN's
supported list (see the note at the top), so `aria-valuetext` really does reach
VoiceOver and TalkBack rather than type-checking and doing nothing.

The visible counter line beside it is `aria-hidden`, because the progressbar
already announces that exact string as its value and a screen reader would
otherwise read the count twice — and on expo that prop **has to ride a wrapping
`View`**. `aria-hidden` is on RN's list of fourteen, but only `View.js` implements
it (mapping it to `accessibilityElementsHidden` plus
`importantForAccessibility="no-hide-descendants"`); `Text.js` destructures exactly
six — `aria-busy`, `aria-checked`, `aria-disabled`, `aria-expanded`, `aria-label`,
`aria-selected` — and `aria-hidden` is not among them, so spelling it on a `Text`
type-checks, renders, and leaves the node in the accessibility tree. It is the
inert-`aria-*` trap from the note at the top of this doc with a twist: **the list
of fourteen is per-component, and nothing tells you which component implements
which**. Reading it as a flat list of "props RN supports" is what makes this one
invisible. Two lessons for checking it on a device: `uiautomator dump` prints the
raw view hierarchy, so a hidden node still appears there and the plain dump proves
nothing either way — `--compressed` is the accessibility-filtered tree and the one
to read. The reassurance under the headline ("Your links
are encrypted…") is **standing prose** — on screen from the first paint, so it
belongs to the silent category with "This action cannot be undone."

The **error** state on the same screen is the opposite: it mounts as the result of
the user signing in, so it announces — a `role="alert"` wrapper on web (the
wrapper rather than the first line, so the "nothing was lost" sentence is
announced with the failure it qualifies) and `ErrorText` on expo. Which is to say
one small screen carries an announcing error, a silent value, a silent duplicate
and silent prose, and only the first of the four is a `role="alert"`.

### `Pressable` inherits no role (expo)

The sharpest web/native asymmetry in the repo, and the reason the two platforms
need different discipline for the same-looking code.

On the web, a bare `<button>` is a complete control: implicit ARIA role, keyboard
activation, focus, `disabled` semantics. Reaching past `ui/button.tsx` for one
costs you styling — the cva chrome, the focus ring, the `data-icon` edge-padding
rule — and **nothing semantic**. That is why the auth forms use bare `<button>`s
for their inline affordances (Regenerate, Choose my own, Forgot your password) and
why that is not a lapse. The only web-specific catch is `type`: inside a `<form>`
a button defaults to `submit`, and neither the bare element nor `<Button>` defaults
it for you.

On native there is no such floor. `Pressable` is a `View` with handlers: it
defaults to `accessible` (`accessible: accessible !== false`, RN's `Pressable.js`)
so it **is** a focus stop, but `accessibilityRole` stays undefined — so it is
announced as its label with no indication that it can be activated, or as nothing
at all when it has no label. `ui/button.tsx` sets `role="button"`; for a long time
it was the only thing in the app that set any role, while 56 hand-rolled
Pressables set none.

So: **use `Pressable` freely when `Button`'s chrome is wrong** — inline text
links, whole tappable rows, chips, icon taps — and then **declare the role
yourself**:

| the pressable is              | declare                                |
| ----------------------------- | -------------------------------------- |
| an ordinary control           | `role="button"`                        |
| a row wrapping a `Checkbox`   | `role="checkbox"` + `aria-checked`     |
| one of N exclusive options    | `role="radio"` + `aria-checked`        |
| a row in a menu / picker list | `role="menuitem"`                      |
| a field that opens a picker   | `role="combobox"` + `aria-expanded`    |
| a nav row with an active one  | `role="button"` + `accessibilityState` |
| something that leaves the app | `role="link"`                          |
| a full-bleed backdrop         | `accessible={false}` — see below       |

Three traps in that table:

- **A row that wraps a `Checkbox` or `RadioGroupItem` must re-declare the role and
  the state.** `accessible` collapses the row into a single node, which swallows
  the inner control's own semantics — so without `role` + `aria-checked` on the
  Pressable, a confirmation row announces as untyped text with no checked state.
  The delete-account and delete-data confirmations both work this way.
- **A backdrop is not a button.** `share-kit.tsx`'s dismiss layer covers the whole
  screen; as a focus stop it announces as one enormous unlabelled control sitting
  over the sheet. It takes `accessible={false}`, and the sheet's real close
  control is the announced way out.
- **If the press has two meanings, the role has two values.** `link-row.tsx` and
  `link-card.tsx` open the URL in the browser normally and toggle selection in
  bulk-edit, so they carry
  `role={selectMode ? 'checkbox' : 'link'}` with a matching conditional
  `aria-checked`. A single `role="button"` would be wrong in both directions —
  it under-describes the browser hand-off and hides the selection state.

Lint covers **half** of this: `jsx-a11y/role-supports-aria-props` runs on this app
and rejects a role/state mismatch — it caught `aria-selected` on a `role="button"`
in the search bar's match toggle, which was really a `radio`. Nothing catches a
role that is simply **absent**, which is how all 56 got there.

### naming things that have no visible label

A control with no accessible name is announced as its type and nothing else
("button", "text field"). Three patterns, in order of preference:

- **Keep the real label and hide it visually.** `sr-only`, not deletion. The
  confirm step of `create-account-form` is the reference case: the visible label
  for the input is the step's own title, up in the header — but **a heading is
  not a label**, so the `<label htmlFor>` stays and goes `sr-only`. It is
  `position: absolute`, so it costs nothing in the layout. Same reasoning in
  `SheetTitle` (`ui/sheet.tsx`): Radix needs a Title for the dialog's accessible
  name, and when the sheet's own chrome already says what it is, the Title is
  wrapped in `sr-only` rather than dropped — _a nameless dialog is announced as
  nothing_.
- **`aria-label` where there is genuinely no text to keep** — icon-only controls,
  and the lock surfaces' password field, whose placeholder is not a label.
  This is the bulk of expo's usage.
- **Say what the row IS, not just its value.** `ShareRow` takes a `label` plus a
  `value` and announces "List: Reading" rather than "Reading". Dropping a word of
  chrome from a 520pt sheet is a visual decision and does not extend to dropping
  the semantics — see [share-sheet.md](./share-sheet.md).

**A visible label is not automatically an accessible name.** `<label htmlFor>`
reaches only the **labelable** elements — button, input, select, textarea, meter,
output, progress. Pointed at anything else it contributes no name _and_ its click
does nothing, and neither half is caught by anything: `jsx-a11y` checks that a
label has a control, not that the control can be one, so the field looks correct,
sits between two that work, and is dead. Web's `TagsField` is the case that
proves it — its trigger is a `div role="combobox"`, a div because each chosen tag
carries its own ✕ button and a button inside a button is invalid HTML — so it
carries its own `aria-label`, and `ui/label.tsx` forwards the label's click to any
non-labelable `htmlFor` target by hand (focus + click, which is what the browser
does for the labelable set). Any future picker built on a div inherits both
halves; a picker built on a `Button` (`ListSelect`) needs neither.

Expo's `ui/text.tsx` maps its heading variants to `role="heading"` with the
matching `aria-level`, so `<Text variant="h2">` is a real heading to TalkBack /
VoiceOver rather than styled text. Use the variant instead of hand-styling a
font size when the thing is structurally a heading.

### invalid state

Two attributes, and they do different jobs — set both:

- **`aria-invalid` on the control itself** is what assistive tech reads. Every
  input primitive in both apps styles its own invalid ring off it
  (`ui/input.tsx`, `checkbox`, `radio-group`, `select`, `textarea`, `button`).
- **`data-invalid` on the wrapping `Field`** (web only) is the _visual_ cascade:
  `fieldVariants` carries `data-[invalid=true]:text-destructive`, so one
  attribute on the wrapper colours the label and description together.

Expo has no Field kit, so the visual half is done per-site with
`className={cn(errors.x && 'border-destructive')}` on the control. The
`aria-invalid` half is identical across platforms and is the half that matters
for announcement.

Neither attribute announces anything by itself — it is read when the user reaches
the field. That is why an invalid field ALSO needs its `FieldError` / `ErrorText`
when the failure arrives from a submit.

### font scaling is an accessibility policy, not a layout detail (expo)

`lib/font-scale.ts` caps the OS font-scale multiplier at **1.3**, applied at two
chokepoints — `components/ui/text.tsx` and `components/ui/input.tsx` — which
between them cover every rendered `Text` and `TextInput` in the app. The share
tree is included: it reaches for those two components by direct path rather than
through a barrel (its bundle budget, [share-sheet.md](./share-sheet.md)), which is
an import-style difference, not an exemption from the cap.

**So: never render a bare `Text` or `TextInput` from `react-native`.** The cap is
only one of four things the wrapper adds, and the other three break louder:

- `font-sans`, which is what makes Inter the app-wide default — RN has no CSS
  cascade, so a bare `Text` silently renders in the system font;
- `TextClassContext`, the channel `Button`, `DropdownMenu` and `SettingsNotice`
  use to style their own child text — a bare `Text` inside a `<Button>` never
  picks up `buttonTextVariants` and renders dark-on-primary;
- the heading `role` / `aria-level` map described above.

Nothing lints this: expo's only `no-restricted-imports` block guards the share
bundle. Two bare `Text` renders survive in vendored registry copies, both benign —
`ui/dialog.tsx`'s `sr-only` close label (invisible text can neither overflow a box
nor need a font) and `ui/dropdown-menu.tsx`'s `DropdownMenuShortcut`, which nothing
imports.

The reasoning is worth restating because the alternative looks tidier: RN's
default is unbounded scaling (iOS Dynamic Type reaches ~310%) while every
Tailwind box dimension is dp and does **not** scale, so past a point text simply
overflows its chrome. The tempting fix — `allowFontScaling={false}` — keeps the
layout pristine by making the app unreadable for exactly the users who changed
the setting. That is an accessibility regression aimed at the people the setting
exists for. So: cap, don't disable. 1.3 keeps the common small bumps working and
bounds the overflow to what the surrounding chrome absorbs.

Both chokepoints spread `{...props}` _after_ the default, so a call site can
still opt out or choose its own ceiling. For the rare place that must do
ARITHMETIC on scaling text, `useCappedFontScale()` returns the device scale
clamped to the same `[1, 1.3]` the text itself is capped at — the tag strip
(`link-tag-chips.tsx`) is the one caller, and it estimates chip widths rather than
sizing a box. Nothing sizes a fixed box around scaling text any more: both link
items are intrinsic-height and simply grow (`link-card.tsx` was the last one, and
its height budget is gone).

The web has no equivalent policy: browser text zoom reflows, and
`use-root-font-scale.ts` handles the root-size case.

### web / expo parity

The two platforms do **not** share component shapes here — web composes the Field
kit, expo hand-rolls its field columns — but the **announced behaviour must
match**, and that is the thing to check when porting a surface. The auth forms are
the reference pair: web's `sign-in-form.tsx` gets its three announcements free
from `FieldError`, and expo's twin had none of them for exactly as long as nobody
compared the two by hand.

When you add an error message to one side, the twin comment in the other file is
the place to say what the role came from. Both `create-account-form`s carry one.

### where the code lives

|                                                                          |                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `packages/web-ui/src/components/ui/field.tsx`                            | `FieldError`, the `data-invalid` cascade, and why the Field kit is not universal |
| `apps/bracemark-expo/src/components/error-text.tsx`                      | expo's single error carrier; the iOS caveat and the one place to fix it          |
| `apps/bracemark-web/src/app/(app)/settings/_components/settings-kit.tsx` | web `SettingsNotice`, tone-guarded role                                          |
| `apps/bracemark-expo/src/features/settings/settings-kit.tsx`             | expo `SettingsNotice`, ditto                                                     |
| `apps/bracemark-expo/src/lib/font-scale.ts`                              | the 1.3 ceiling and `useCappedFontScale`                                         |
| `apps/bracemark-expo/src/components/ui/text.tsx`                         | heading roles + `aria-level`; one of the two font-scale chokepoints              |
| `packages/web-ui/src/components/auth/create-account-form.tsx`            | the live-verdict vs. error distinction, worked through in comments               |
