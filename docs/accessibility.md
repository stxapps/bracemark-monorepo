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
>
> **A supported `aria-*` prop is only supported on RN's own components.** The
> translation into `accessibility*` happens in RN's JS components, not in native,
> so a third-party host component skips it. A lucide `Icon` is
> react-native-svg's `Svg`, which passes its props straight to the native view:
> `aria-label` on an `Icon` is dropped on both platforms, and
> `accessibilityLabel` is the prop that lands. That is how the link row's pinned
> and note badges stayed out of the row's composite name while looking labelled in
> the diff — A/B on the iPhone 17 Pro simulator and the Pixel 8 AVD, one prop
> apart: "…, journal.example.net, Pinned" against "…, journal.example.net"
> (`features/links/shared.tsx`). `aria-hidden` on a `Text`, below, is the same
> trap on a built-in.
>
> **Where the labelled icon sits decides what else it needs.** Inside a press
> target (the link row's badges, the sidebar's own-lock badge) the label alone is
> right: the `Pressable` is the one accessible node and folds the icon's label into
> its name ("My List, Locked"), and marking the icon `accessible` too would split
> it off as a node of its own. Standing alone (the lock chrome in Settings → Lists)
> it needs `accessible` as well — without it Android happens to expose the label,
> but on iOS the view is not an accessibility element and VoiceOver never lands on
> it. Checked on both: the standalone icon becomes one focusable node in
> `uiautomator dump --compressed`, and on iOS its svg + path nodes collapse into
> one.

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

The same 18 `jsx-a11y` rules now run on `bracemark-web`, `bracemark-site` and the
**browser extension** too. They had not: those three took nx's
`flat/react-typescript` preset, which carries no plugins at all, while the
packages and `bracemark-expo` take `flat/react` — so `jsx-a11y` (and
`react-hooks`) were silently off across the whole web app for as long as it has
existed. Switching them on cost nothing, which is its own finding: the web
surfaces were already clean against every rule the packages had been held to.

### naming things that have no visible label

A control with no accessible name is announced as its type and nothing else
("button", "text field"). Three patterns, in order of preference:

- **Keep the real label and hide it visually.** `sr-only`, not deletion. The
  confirm step of `create-account-form` is the reference case: the visible label
  for the input is the step's own title, up in the header — but **a heading is
  not a label**, so the `<label htmlFor>` stays and goes `sr-only`. It is
  `position: absolute`, so it costs nothing in the layout **it sits in** — but
  see the overflow caveat below. Same reasoning in
  `SheetTitle` (`ui/sheet.tsx`): Radix needs a Title for the dialog's accessible
  name, and when the sheet's own chrome already says what it is, the Title is
  wrapped in `sr-only` rather than dropped — _a nameless dialog is announced as
  nothing_.
- **`aria-label` where there is genuinely no text to keep** — icon-only controls,
  and the lock surfaces' password field, whose placeholder is not a label.
  This is the bulk of expo's usage. RN also has no `<label for>`, so on expo a
  field under a visible `<Text>` label repeats that label as its `aria-label`:
  the advanced-search sheet's six word fields sat under their labels announced as
  bare text fields until `WordField` passed its `label` through
  (`features/links/search-bar.tsx`), while web's `FieldLabel htmlFor` had always
  named them.
- **Say what the row IS, not just its value.** `ShareRow` takes a `label` plus a
  `value` and announces "List: Reading" rather than "Reading". Dropping a word of
  chrome from a 520pt sheet is a visual decision and does not extend to dropping
  the semantics — see [share-sheet.md](./share-sheet.md).

**`sr-only` is not free inside a horizontal scroller.** Tailwind's `sr-only` is
`position: absolute` with no positioned ancestor of its own, so it resolves
against the **initial containing block** — and inside an `overflow-x-auto`
wrapper that drags the _document's_ `scrollWidth` out with it. The symptom is a
phantom horizontal-overflow bug: the page reports a scrollWidth wider than the
viewport at narrow widths, with no visible element to blame, because the culprit
is invisible by construction. Caught in bracemark-site's pricing table (the
`min-w-120` table at 390px, [safe-area.md](./safe-area.md)); the fix is
`relative` on the scroll wrapper, which gives the absolute label a containing
block to resolve against. Nothing lints this — measure narrow layouts the way
the `verify` skill describes rather than eyeballing a screenshot, since a
cropped render hides it.

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

**Native avoids that nested-control trap.** bracemark-expo's `TagsField` is one
fixed-height `Button` combobox: its first two visible names may truncate
independently and `+N` counts the remainder, while its accessible name carries
every chosen tag ("Tags: reading, work"). Its sibling `ListSelect` says the same
kind of thing — "List: Work / Reading", the whole path. It used to be named a bare
"List", and because an `aria-label` replaces the children's text rather than
joining it, the list a link was filed in was never announced at all; the
`ShareRow` rule above is the one it had missed. Selection and removal happen in
`TagPickerRows`, where each full-width 44pt row is one checkbox with a real
checked state. There are no nested chip-removal Pressables, so VoiceOver does not
need custom removal actions and activation cannot land on the wrong child. The
in-app picker and the snapshot-fed share picker share those rows even though
their data and commit lifecycles stay separate.

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
between them cover every rendered `Text` and `TextInput` in the app, including
the ones a third-party primitive would otherwise render for us (the paragraph
below). The share
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
bundle. One bare `Text` render survives in a vendored registry copy and is
benign — `ui/dialog.tsx`'s `sr-only` close label, since invisible text can
neither overflow a box nor need a font. (`ui/dropdown-menu.tsx`'s
`DropdownMenuShortcut` is the second, kept bare only because nothing imports it
and a keyboard-shortcut hint has no place on a phone; anything that starts using
it should switch it first.)

**And the rule reaches one step further than a grep does: a component can render
a bare `Text` on your behalf.** `@rn-primitives`' `Title`, `Description` and
`Label` are each `Component = asChild ? Slot : Text` — react-native's `Text`,
inside `node_modules`, whenever `asChild` is absent. So the registry copies of
`ui/alert-dialog.tsx`, `ui/dialog.tsx` and `ui/dropdown-menu.tsx` shipped every
dialog title and description in the app in the **system face, uncapped**, across
12 call sites, while a search of this repo for `<Text` came back clean and this
section claimed full coverage. It is the quietest form the failure takes: the
`className` we pass still resolves, so the colour and weight are right and only
the typeface is wrong, and the accessibility tree is perfect. `AlertDialogTitle`
carries the derivation.

`ui/alert-dialog.tsx` and `ui/dropdown-menu.tsx` fix it by composing `asChild`
with `ui/text.tsx`'s `Text`, which also gets the primitive's `role='heading'`
onto a Text the heading map can see. **`ui/dialog.tsx` cannot**, and that is the
second layer of the same trap: `@rn-primitives/dialog`'s _native_ build never
destructures `asChild` — its Title is `({ ref, ...props }) => <Text
role='heading' {...props} />`, and only the `.web` build has the `Slot` branch —
so the identical spelling slots nothing and renders the bare `Text` _around_ ours
rather than in place of it. The types don't distinguish the two builds
(`TitleProps = SlottableTextProps` names `asChild` for both), and the nesting is
almost invisible at runtime, because RN merges a child fragment's text attributes
over its parent's, so Inter and the cap survive it. `DialogTitle` and
`DialogDescription` therefore render `ui/text.tsx`'s `Text` directly on native,
carrying the `role='heading'` themselves, and keep the primitive only on web,
where the Slot works and Radix needs the element to wire `aria-labelledby` /
`aria-describedby` to it.

When adopting anything else from the registry, read what its primitive renders
**on the platform you ship**, rather than what the wrapper looks like — the types
accepting `asChild` says nothing about whether the native build reads it.

The reasoning is worth restating because the alternative looks tidier: RN's
default is unbounded scaling (iOS Dynamic Type reaches ~310%) while every
Tailwind box dimension is dp and does **not** scale, so past a point text simply
overflows its chrome. The tempting fix — `allowFontScaling={false}` — keeps the
layout pristine by making the app unreadable for exactly the users who changed
the setting. That is an accessibility regression aimed at the people the setting
exists for. So: cap, don't disable. 1.3 keeps the common small bumps working and
bounds the overflow to what the surrounding chrome absorbs.

**"What the chrome absorbs" is checked, because it is the half that silently
fails.** A box that pins a height (`h-*`, `size-*`) has that height minus its
vertical padding and borders for its text, and at the cap a `text-sm` line needs
26, `text-base` 31.2, `text-xs` 20.8. Three boxes left exactly one 1× line and
clipped for anyone with the setting raised — Button's `py-2`, the tab strip, the
advanced-search filter box ([theme.md](./theme.md), _extending_) — and each hid
the sum across two components. `components/ui/line-budget.spec.tsx` does the sum
on the classes that reach the host nodes: the kit at every size, every call site
of a kit control rendered through the real component with its own literal props,
and every `View`/`Pressable` that pins a height against the Text written inside
it. It fails with the file, line, and both numbers. It is a necessary condition,
not layout — wrapping, a runtime class, a component between the box and its text
are the large-text visual checkpoints' ([e2e.md](./e2e.md), _visual
checkpoints_). The fix for a hit is `min-h-*` where nothing needs the box fixed,
or dropping the padding where something does (the height already sizes it).

**A text size changed while the app runs is a different failure, and not ours to
fix yet.** On Android every Text measured before the change keeps its old height
at the new size until a cold start — React Native 0.81's measure cache, fixed by
a flag RN 0.82 turns on. [dependency-upgrades.md](./dependency-upgrades.md),
_the target window_, carries the cause, why it was not forced on 0.81, and the
check to run after the bump.

**The one exemption is a repair, not a policy: the iOS share-extension process.**
RN computes its scale factor from `UIApplication.sharedApplication`, which does
not exist in an app extension, so the multiplier there is **0** — and
`fminf(1.3, 0)` is 0, which means the cap above cannot rescue it. Every `Text`
and `TextInput` in that process lays out at zero point: invisible, with the
right strings still in the accessibility tree and every check green. The only
lever RN offers is `allowFontScaling={false}`, so both chokepoints ask
`allowsFontScaling()` and `index.share.js` — the extension bundle's entry, and
the only file that IS that process — answers no. `lib/font-scale.ts` carries the
derivation; [share-sheet.md](./share-sheet.md) carries the symptom.

State the cost plainly rather than filing it as a detail: **Dynamic Type does
not reach the iOS share sheet.** That is a real loss for the users this whole
section exists for, and it is not one we can buy back — the alternative is text
that renders at zero size for everybody, and the multiplier cannot be corrected
from JS (`ParagraphShadowNode` overwrites a hand-passed one). It is scoped as
tightly as it goes: one process, one surface, a few seconds, and the same link
is fully scalable in the app the sheet saves into. Android's share sheet runs in
the app's own process and keeps the 1.3 cap like every other screen. If RN ever
falls back to `UIFont.preferredFont(forTextStyle:)` — which does work in an
extension — this exemption should go.

Both chokepoints spread `{...props}` _after_ the default, so a call site can
still opt out or choose its own ceiling. For the rare place that must do
ARITHMETIC on scaling text, `useCappedFontScale()` returns the device scale
clamped to the same `[1, 1.3]` the text itself is capped at — the tag strip
(`link-tag-chips.tsx`) is the one caller: it measures its own container, then
estimates chip widths at that font scale rather than sizing a fixed box. Nothing
sizes a fixed box around scaling text any more: both link items are
intrinsic-height and simply grow (`link-card.tsx` was the last one, and its
height budget is gone).

The inverse case — a FIXED glyph that has to sit on the first line of scaling
text — takes no arithmetic either. The settings radio rows put their radio mark
and their icon in `FirstLineSlot` (`features/settings/settings-kit.tsx`), whose
zero-width `Text` lays out one empty line at the device's real line height and
centres the glyph in it. A margin is right at one text size only (the ported
`mt-0.5` left the radio 2 above its label at 1× and further at each step up),
and `items-center` on the row holds only until the label wraps. Measured on the
iOS simulator at the smallest, default and capped sizes: radio and icon share a
centre exactly, within 0.2 of the label's cap-height centre, wrapped or not.

The web has no equivalent policy: browser text zoom reflows, and
`use-root-font-scale.ts` handles the root-size case.

### a 36dp box is not a 44pt target (expo)

Every icon button in expo's chrome is `size-9` (36) — both topbars, the two
floating-surface closes (`ui/dialog.tsx`'s corner X and the add panel's) — or
`size-10` (40) for the two system-modal header closes (edit-link, Advanced
Search) and the advanced-search trigger. iOS HIG asks for 44pt and Material for
48dp, so **every one of them is under the floor as drawn**, and the fix is
`hitSlop`, not a bigger box.

The box has to stay because it is load-bearing twice over: both bars are cut to
36 and a user crosses between them constantly, and the 40 on the search trigger
is set by its glyph's corner margin — the advanced-filter dot lives in that
margin, and 20px of glyph in a 36px box leaves the dot ~1px off the end of the
slider (`features/links/search-bar.tsx` works it through). `hitSlop` costs no
layout at all, which is the whole reason it is the right lever here.

**Every one of those boxes now carries the slop, and for a while three did not.**
The rule was stated here and applied to the two topbars and the advanced-search
trigger, while the closes on the three editor surfaces — edit-link, Advanced
Search, the add panel — shipped bare at 40, and `ui/dialog.tsx`'s shipped at 40
effective because its box was the 16pt glyph plus `hitSlop={12}`. Nothing
reported it: an under-floor target is a working button. The values, each read off
the rule above rather than picked: the two in-row header closes take
`{ top: 4, bottom: 4, left: 8, right: 6 }` (54x48 — `right: 6` runs out to the
row's `pr-1.5` frame edge, and the left 8 is free because the title beside them
is a `Text`, which takes no touches); the add panel's takes a plain `8` (52x52,
nothing pressable near it); the dialog's takes `6` on the kit's 36 box (48). The
five closes sit at the app's two glyph rungs for the same reason the topbars do —
`size-5` on the two bar-shaped headers, `size-4` on the floating pair — which is
`features/links/topbar.tsx`'s free-margin rule, not a size preference: 40/20 and
36/16 both leave 10pt a side.

The **share sheet's** close (`features/share/share-kit.tsx`) takes the topbars'
plain `6` on its `size-9` box for the topbars' reason — the lockup it trails is
an icon and a `Text`, and `ml-auto` leaves the middle of that header empty. Being
in another process changes nothing here: `hitSlop` is plain RN. It is the one
place where a near-miss strands the user rather than annoying them, because on
iOS that X is the only VISIBLE way out of the compose screen — the system's
swipe-down and the backdrop both work and neither announces itself
([share-sheet.md](./share-sheet.md)).

The link card/list tag chips use the same lever on one axis: their 24pt visual
height gets 10pt of top and bottom slop, reaching 44pt vertically without
changing how many adaptive chips fit. They deliberately get no horizontal slop:
the strip has only a 4pt gap, so enough slop to make a short label 44pt wide
would overlap adjacent tag targets. This is a pragmatic improvement, not a claim
that every one-letter pill now has a 44 by 44 target; true two-axis compliance
would require visible minimum-width wrappers (and new fit arithmetic) or one
strip-level action instead of adjacent tag actions.

**The one rule for the value: never take more than HALF the gap to a pressable
neighbour.** RN resolves overlapping touch regions by tree order — the later
sibling wins — and what gets eaten is the loser's own VISIBLE box, so an
over-generous slop on the ⋯ trigger would hand it the right-hand strip of the
Search button beside it. The links topbar's pair splits its `gap-1` two and two
for that reason; the drawer and both settings buttons take a plain `6`, since
the only thing beside them is a `Text` and a Text takes no touches. Slop that
reaches past the immediate parent's bounds is fine — verified, not assumed: the
⋯ trigger's wrapper `View` is exactly button-height, and a tap 10px above the
button still opens the menu.

Nothing catches a missing one. No lint rule, no type error, no test — and
`adb shell uiautomator dump` reports the view's own bounds (36dp) whether or not
`hitSlop` is set, so an automated target-size audit cannot see the fix either.
The only proof is a coordinate tap outside the box on a device:
`adb shell input tap <x> <y>` a few px above the button, then read the result
from a screenshot rather than a dump (an open drawer or dropdown does not show
up in one).

The web side needs none of this: at 36 its pointer targets clear WCAG 2.5.8's
24px floor with room, and the `h-9` band is set by the search input they sit
beside.

**A picker ROW takes the floor as height, not as slop** — `min-h-11` on every
row of `links/tag-picker-rows.tsx`, `links/list-command.tsx` and the share
sheet's copy of the list rows. The lever differs from the icon buttons above
because the constraint does: nothing pins a row to 40 the way a topbar's 36 is
pinned, the rows are full-width so there is no neighbour to steal from, and
`hitSlop` on stacked rows would overlap the row above and below (RN resolves
that by tree order — the later sibling wins, which would silently retarget the
last few px of one row's tap to the next). `py-2.5` around a one-line name
reaches only 40, which is what the two list pickers carried until the rows were
brought in line with the tag picker's. `min-h`, never `h`: a large font scale has
to grow the row, not clip the name.

### modality — an overlay that covers the screen must also cover the a11y tree

A surface drawn OVER the app rather than presented by the navigator has to say
so, or a screen reader walks straight out of it into the content behind. The add
panel (`links/link-add-panel.tsx`, [soft-keyboard.md](./soft-keyboard.md), _the
add panel_) is the case that proves the two halves are not equal:

- **iOS: `accessibilityViewIsModal` on the panel's root works.** Measured with
  `maestro hierarchy` on an iPhone 17 Pro: with the panel up the tree holds the
  panel's nodes and nothing of the links screen, on every open.
- **Android: it does not.** `importantForAccessibility="no-hide-descendants"`
  (and `aria-hidden`, and both plus `collapsable={false}`) on the covered
  subtree left every node behind the panel in the tree — the topbar title, the
  banner, the rows — read back by both `maestro hierarchy` and
  `adb shell uiautomator dump`, and still reachable by an accessibility click.
  Verified against a hardcoded flag, so it is not the state plumbing; RN 0.81 on
  Fabric. **This is not new with the panel**: the same dump with a `Dialog`
  open shows the whole screen behind it too, so every portaled dialog in this app
  has the same gap. The panel keeps the props anyway — they cost nothing and they
  are what will start working when RN fixes it — and the iOS half is real today.

**The opposite failure is just as silent: an overlay that swallows its own
children.** `ui/alert-dialog.tsx` renders its overlay into a `Pressable` (to claim
the touches around the alert), and a `Pressable` is an accessibility element by
default — which hides everything inside it. Measured on the iOS simulator with
Trash's "Delete permanently?" open: the hierarchy held ONE node,
`Delete permanently?, … This can’t be undone., …, Cancel, Delete permanently`,
and no separate Cancel or confirm to focus or activate — in every alert dialog in
the app. `ui/dialog.tsx` never had it, for a reason nothing in our code showed:
`@rn-primitives`' `Dialog.Overlay` passes `accessible={false}` down through its
Slot, and `AlertDialog.Overlay` is a bare `View` that passes nothing. The alert's
overlay now says `accessible={false}` itself. It surfaced as an e2e flow that
could not find its confirm button by id (`link-lifecycle.yaml`), which is the only
reason it surfaced at all — no spec renders the native tree.

The rule for a new overlay: set `accessibilityViewIsModal` on its root and hide
the covered subtree, then CHECK the tree rather than assuming — a dump is the
only instrument that shows either half.

### focus after a row leaves the list (expo) — not handled

A row-menu action that takes its row out of the view (Archive, Unarchive,
Remove, Restore; Move to goes through a dialog and was not checked) leaves a
screen-reader user nowhere. `@rn-primitives`'
dropdown returns focus to the ⋯ trigger when the menu closes — which is right for
Copy link or Pin, and is what happens — but that trigger went with the row, so
the platform picks a fallback. Measured with TalkBack on the Pixel 8 AVD, focus
on the row's ⋯ before the press: after **Copy link** it came back to that ⋯;
after **Archive** it landed on the topbar's ☰, so the user swipes back through the
topbar and anything above the list before reaching the rows again — on every item
of a triage pass. VoiceOver was not checked.

It is not the `sendAccessibilityEvent() dropping event` error the e2e flows see
([e2e.md](./e2e.md), _driving the native apps_): that run logged nothing. The
error is a timing symptom of the same close hook; this is the design gap, and
silencing the error would not touch it. The fix is to move focus on purpose once
the list has re-rendered — to the row that took the removed row's place, else the
one above, else the empty state — which the item renderers cannot do alone
(FlashList recycles them) and which the library's own 50ms restore has to lose
to. Nothing does that yet.

To look at it again: `adb shell settings put secure
enabled_accessibility_services
com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService`
(set it to `null` to turn it off), and read focus off a screenshot — TalkBack's
green rectangle. `adb shell input tap` is not a TalkBack gesture: it activates
directly, without moving TalkBack focus, so put focus where a user's would be
first (closing a menu with a second tap on its ⋯ does it) before pressing the
item.

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
| `apps/bracemark-expo/src/features/links/topbar.tsx`                      | the `hitSlop` rule and the glyph-rung divergence the boxes are derived from      |
| `apps/bracemark-expo/src/features/links/link-add-panel.tsx`              | modality on an in-tree overlay: what iOS honours and what Android drops          |
| `packages/web-ui/src/components/auth/create-account-form.tsx`            | the live-verdict vs. error distinction, worked through in comments               |
