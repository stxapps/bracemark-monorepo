## theme

How bracemark decides whether to render **light or dark**, how the user's choice is
stored, and why `localStorage` stays in the loop even though the choice can sync.
See [local-first-sync.md](./local-first-sync.md) for the encrypted-file data path
the synced half rides on (one entity per `*.enc` blob, file-level LWW, the
`settings/general.enc` file) and the off-sync `localSettings` store the device
half lives in; [client-queries.md](./client-queries.md) for the `useSettings`
read edge this reuses; and [architecture.md](./architecture.md) for the package
layering the pieces sit in.

The theme mirrors the **link-layout** setting one-for-one: same sync/device
split, same two stores, same `useSettings` / `useSettingMutations` seam. If
you've read how `linksLayout` works, you already know the shape — this doc adds
the one thing theme has that layout doesn't: a **pre-paint (FOUC) constraint**
that keeps `localStorage` mandatory.

### the model — four modes, one resolved answer

The user picks one of four **modes**; the DOM only ever needs the resolved
light/dark result. The mode plus two custom-mode times make up a `ThemeState`
(`@stxapps/shared` `theme/theme.ts`):

```ts
type ThemeMode = 'light' | 'dark' | 'system' | 'custom';
interface ThemeState {
  mode: ThemeMode;
  lightStart: string; // "HH:mm" 24h — when light turns on in `custom` mode
  darkStart: string; // "HH:mm" 24h — when dark turns on in `custom` mode
}
```

- `light` / `dark` — pin the theme.
- `system` — follow the OS `prefers-color-scheme`.
- `custom` — light by day, dark by night, on the user's own schedule; the dark
  window may wrap past midnight (e.g. dark `19:00` → light `06:00`).

`DEFAULT_THEME` is `system` with `06:00` / `19:00`.

The resolver is a **pure, platform-agnostic function** so every surface — both
apps and the pre-paint script — agrees on the same answer:

```ts
resolveTheme(state, { now, systemPrefersDark }): 'light' | 'dark';
```

`system`/`custom` need outside facts (the OS preference, the current time), so
the caller supplies them rather than the function reaching for globals. Two
helpers ride alongside it in the same file:

- `msUntilNextThemeSwitch(state, now)` — ms until the next `custom`-mode
  crossover (`null` for every other mode), so a provider can schedule a single
  timer to re-resolve at exactly the right moment.
- `coerceThemeState(value)` — validate/normalize an untrusted value (from storage
  or a synced blob) into a real `ThemeState`, falling back to defaults per field.

### where the choice lives — the sync/device split

Like `linksLayout`, the theme has **two sources**, and a per-device toggle picks
which one applies:

| source     | stored in                              | scope                      |
| ---------- | -------------------------------------- | -------------------------- |
| **Sync**   | `settings/general.enc` (`theme` field) | all the account's devices  |
| **Device** | `localSettings` row (`theme` field)    | this device only, off-sync |

The **`themeSource`** flag (`'sync'` \| `'local'`) lives in the device-local
`localSettings` row and decides which one the app renders. It is deliberately
device-local: "use this device's own theme" is a per-device decision that must
not propagate. Theme actually earns the Device option more than layout does —
dark on the laptop at night, light on the phone is a genuinely common want.

Both stores are the SAME ones layout uses:

- **Synced** — `settingsGeneralSchema.theme` in `@stxapps/shared` (`sync/
entities.ts`), written by `writeSettingsGeneral` + a sync kick, read by
  `readSettingsGeneral`. Optional and permissive (see below).
- **Device** — `LocalSettingsRecord.theme` / `.themeSource` in `@stxapps/
web-react` (`data/db.ts`), a single-row off-sync Dexie table that never becomes
  an `items` blob, never enqueues a pending op, and is wiped on sign-out.

#### why `settingsGeneralSchema.theme` is permissively typed

`themeStateSchema` is a `z.object` whose three fields are `z.string()`, **not**
`z.enum(THEME_MODES)` or a time regex. This schema parses **persisted bytes**,
and `settings/general.enc` is a **shared** file (`linksLayout`, `serverExtraction`,
and `theme` all live in it). If a strict field rejected a newer client's unknown
`mode` or a malformed time, the WHOLE blob would fail to parse and drop from the
UI — taking `linksLayout`/`serverExtraction` down with the theme. So the schema
parses leniently and the **read edge** (`coerceThemeState`, applied in
`useSettings`) is what validates/normalizes into a real `ThemeState`.

It's a `z.object` rather than the file's usual `looseObject` because theme is a
**closed shape** (only these three fields feed `resolveTheme`), so there are no
unknown sub-keys to round-trip — and `z.object`'s inferred type stays index-
signature-free, so a real `ThemeState` assigns straight into it (a `looseObject`
catchall index signature would not). Forward-compat still holds where it matters:
the PARENT `settingsGeneralSchema` is `looseObject`, so a future client's new
SIBLING setting round-trips. **To grow the theme model, add a field beside
`theme`, don't add sub-keys inside it.**

### the read/apply seam

The write and read sides mirror `linksLayout` exactly, in `@stxapps/web-react`:

- **`useSettings()`** resolves and returns `theme` (the active `ThemeState`,
  `localTheme` when `themeSource === 'local'` else `syncTheme`), plus
  `themeSource`, `syncTheme`, and `localTheme` for the settings UI. Both source
  values pass through `coerceThemeState`. Backed by `useLiveQuery`, so a change on
  either store — a local edit, or a sync landing a new `settings/general.enc` —
  re-renders every consumer.
- **`useSettingMutations()`** exposes `setThemeSource` / `setLocalTheme` (→ the
  device-local `localSettings` store) and `setSyncTheme` (→ `writeSettingsGeneral`
  - a sync kick, so every device honors it).

The **`ThemeProvider`** (`@stxapps/web-ui` `contexts/theme-provider.tsx`) is the
read/apply half. It does NOT own the preference — it consumes the already-resolved
`useSettings().theme` (the way the links page consumes `linksLayout`), turns it
into the `.dark` class on `<html>`, tracks `effectiveTheme` (the rendered
light/dark), and re-resolves on each mode's trigger: `system` → an OS
`prefers-color-scheme` change; `custom` → a single `setTimeout` to the next
crossover. `useTheme()` exposes just `{ effectiveTheme }` — the rendered result;
the preference itself stays a single source of truth in `useSettings().theme`, so
read it there rather than re-exposing it here.

This is a deliberate change from the provider's earlier design, which took an
injected `ThemeStorage` (localStorage for bracemark-web, `browser.storage.sync` for
the extension). Now both apps route theme through the same data layer, so the
injection seam earned nothing — the provider reads `useSettings` directly.
(`web-ui` may import `web-react`; see the layering table in architecture.md.)

### the FOUC constraint — why localStorage never leaves

A page must set the `.dark` class **before first paint**, or it flashes the wrong
theme. That runs in a synchronous inline `<script>` in `<head>`, **before** React
mounts and **before** IndexedDB can be opened, let alone decrypted. The synced
theme lives encrypted in `settings/general.enc` in IndexedDB — **unreachable at
that moment**. So:

> `localStorage` always holds the currently-effective `ThemeState`, as a
> synchronous pre-paint cache, no matter which source is active.

`ThemeProvider` writes that mirror (`localStorage['bracemark-theme']`,
`THEME_STORAGE_KEY`) every time the resolved theme changes. The pre-paint script
reads it. In **device** mode the mirror equals the device value; in **sync** mode
it's a warm copy of the synced value. On a cold first load in sync mode the synced
value isn't decrypted yet, so the page paints the mirror (or the default) and
self-corrects once Dexie resolves — unavoidable, and warm on every load after.

The pre-paint script is generated once from **`themeInitScript()`**
(`@stxapps/shared`), a self-contained ES5 IIFE that mirrors `resolveTheme` in
plain JS. Single source, no hand-copied duplicate of the resolver.

### per-app wiring

- **bracemark-web** — `layout.tsx` inlines `themeInitScript()` in `<head>` as a
  server-rendered `<script>`; `inner-layout.tsx` mounts `<ThemeProvider>` (no
  props) inside the data-layer providers. The theme **picker** is Settings → Misc
  (`misc-section.tsx`): a Sync/Device tab, four mode radios, and two time inputs
  revealed in `custom` mode — the same tab shape as the link-layout section right
  above it.

  Paddle's **overlay checkout** is the one surface here the `.dark` class cannot
  reach — a third-party iframe on Paddle's origin, and it opens **light** unless
  told otherwise, which is a white payment sheet thrown over a dark page. So
  `openPaddleCheckout` passes `settings.theme` = the resolved `effectiveTheme`
  on every open. **Per open, not at `initializePaddle`**: Paddle.js initializes
  far earlier (the price preview, as the Subscription section mounts), and
  `Paddle.Update()` carries no checkout settings — so a theme fixed at
  initialize could not be corrected when the theme moves in between, which
  `system` and `custom` both do on their own. A change while the overlay is
  already open does not reach it, and no API would let it.
  → [iap.md](./iap.md), _the purchase flow (Paddle Billing — web)_.

- **bracemark-extension** — MV3 pages (popup, options). `wxt.config.ts` injects
  `themeInitScript()` into every page's `<head>` at build time via a Vite
  `transformIndexHtml` plugin (`themeFoucPlugin`) — a deferred module `main.tsx`
  runs AFTER paint, so the FOUC script can't live there; it must be the inline
  classic `<script>`, and generating it from the shared source beats hand-copying
  it into each `index.html`. `providers.tsx` mounts `<ThemeProvider>` (no props).
  The theme **picker** is the options page (`entrypoints/options/ThemeSection.tsx`):
  a Sync/Device tab, four mode radios, and the two custom-mode time inputs — the same
  tab shape as bracemark-web's Misc section, but **theme-only**. Theme is the only synced
  setting that applies to the extension: `linksLayout` has no library list to lay out
  here, and `serverExtraction` never fires (the extension is active-context only and
  never calls `bracemark-extractor`). The **Device** tab is what earns the extension its
  own picker — it lets this browser keep a theme (e.g. always-dark) distinct from
  bracemark-web, without a context switch to set it. Popup and options share one origin,
  so they share both the `localStorage` mirror and the Dexie stores (a pick on the
  options page applies to the popup too).

  The extension no longer uses `browser.storage.sync` for theme at all: cross-
  device sync is the sync engine's job now (`settings/general.enc`), and cross-
  context sharing (popup ↔ options ↔ background) comes free from same-origin
  IndexedDB. The old `utils/theme-storage.ts` adapter is gone.

- **bracemark-expo** — the model is identical (four modes, the sync/device split,
  the same `useSettings`/`useSettingMutations` seam in `@stxapps/expo-react`),
  and the picker is Settings → Misc (`features/settings/misc-section.tsx`), the
  same tab shape as web. Two things differ, both because RN lacks a browser
  affordance rather than by design.

  The first is the **`custom`-mode crossover times**. Web uses
  `<Input type="time">`, whose load-bearing property is not its popup but that
  the browser only ever emits a complete `"HH:mm"` — and `coerceThemeState` at
  the read edge discards anything else, so a free-text RN field could never
  reach a new time (every intermediate keystroke is invalid and coerced away
  mid-edit). RN's stand-in is the platform's native time picker, wrapped in
  `features/settings/time-field.tsx` — a button showing the time, opening
  Android's dialog or, on iOS, a spinner in our `Dialog`. See
  [expo-dependencies.md](./expo-dependencies.md) —
  _@react-native-community/datetimepicker_.

  The second is the **read/apply half**, because RN has no DOM class and no
  pre-paint `<script>`. The `ThemeProvider`
  (`apps/bracemark-expo/src/components/theme-provider.tsx`) is the port of web-ui's:
  it consumes the already-resolved `useSettings().theme`, exposes
  `useTheme().effectiveTheme`, and re-resolves on each mode's trigger. It mounts
  once at the root `_layout.tsx`, wrapping `<Stack>` inside the data-layer
  providers, so it covers **both** route groups (`(auth)` and `(app)`) — settings
  read from the sqlite singletons, so it needs no account. There is deliberately
  **no `expo-ui` package** while bracemark-expo is the only expo app, so it lives in
  the app, not a package (the same reason the RN reusables components do). Three
  substitutions from web, and one surface with no web counterpart at all:

  - **Apply is `Uniwind.setTheme('light' | 'dark' | 'system')`, not the `.dark`
    class.** RN has no `<html>` to toggle; Uniwind's runtime theme is the
    equivalent, and `global.css` already declares the `@variant light`/`@variant
dark` token sets (the native mirror of web-ui's `:root`/`.dark`).
  - **`system` is handed to Uniwind, not resolved-and-pinned like web.** This is
    the one real divergence in the resolver path. `setTheme('light'|'dark')` calls
    `Appearance.setColorScheme(...)` under the hood, which _shadows_ the OS signal
    (`Appearance.getColorScheme()` then returns the pinned value, not the OS one) —
    so in `system` mode the provider must leave the override clear and let
    Uniwind's own `Appearance` listener track the OS (`setTheme('system')` does
    exactly that). `light`/`dark`/`custom` resolve to a concrete value via the
    shared `resolveTheme` and pin; there the `Appearance.setColorScheme` side
    effect is a _bonus_ — it makes `<StatusBar style="auto">` (already in
    `_layout.tsx`) and native components follow the app theme with **no extra
    StatusBar wiring**. The OS-change and `custom`-crossover triggers are the RN
    analogues of web's: an `Appearance.addChangeListener` (for `matchMedia`) and
    the same `msUntilNextThemeSwitch` + `setTimeout`.
  - **No `localStorage` FOUC mirror and no `themeInitScript`.** The entire
    pre-paint apparatus (the section below) exists _only_ because a browser paints
    before React/IndexedDB. Native has no pre-paint script and no synchronous
    store to read mid-mount, so there is nothing to mirror into. The native splash
    screen covers startup — but only because it is **held** there:
    `src/components/splash-hold.tsx` keeps it up until `AuthProvider` has read the
    session back, since expo-router would otherwise drop it one frame after the
    navigator is ready, which is before any of our reads land
    ([expo-dependencies.md](./expo-dependencies.md), _expo-splash-screen_). Under it,
    Uniwind's own startup default is `system` — which matches `DEFAULT_THEME`, so
    first paint is consistent with the default exactly like web's cold-load
    fallback. The hold is on AUTH, not on settings, so a **pinned** theme can still
    cross over a paint or two after the splash lifts; eliminating that is the same
    lever extended rather than a cache, and it is not free — `useSettings` has no
    "the live read has landed" signal to gate on (it defaults every field instead,
    which is what makes it safe to call mid-mount everywhere else), so it would
    need one before the hold could wait for it.
  - **The root navigator carries `--color-background` too.** Every navigator in
    the app (the root `Stack`, `(app)`'s, `(auth)`'s, settings' and the links
    `Drawer`) reads react-navigation's theme from the nearest provider, and with
    none of our own they all took its stock `DefaultTheme`, whose
    `colors.background` is `rgb(242, 242, 242)` — which native-stack hands to every
    screen as its default `contentStyle`. That is invisible under a screen painting
    its own `bg-background`, and it is the only thing on screen whenever one isn't:
    the null frames of the guards and the gates (docs/locks.md, _the no-flash
    pair_). In dark mode it read as near-white. `src/app/_layout.tsx` now wraps the
    root `Stack` in a `ThemeProvider` (react-navigation's, not ours) carrying
    `DefaultTheme` with `background` replaced by the live token via
    `useCSSVariable` — the same read `ui/switch.tsx` uses, for the same reason: a
    hex pair here would be a second copy of `global.css` free to drift. Only
    `background` is overridden, not the whole palette — `card` still reaches the
    Drawer panel, and nothing in this app renders against `text`/`border`.

  The **iOS/Android share sheet** (`features/share/share-root.tsx`) mounts outside
  the router tree — a separate process on iOS — so it carries **no
  `ThemeProvider`**: no `useSettings` to read (it can open neither settings
  source), no `effectiveTheme` context (nothing under it consumes one —
  `ui/input.tsx` takes the keyboard appearance from `useUniwind()`), and no
  re-resolve triggers, since Uniwind's own `Appearance` listener still covers an
  OS flip and a `custom` crossover cannot land inside the three seconds the sheet
  exists.

  What it does carry is the **apply step, once, during its first render**
  (`features/share/share-theme.ts`). It reads the preference from a **file
  mirror** the app writes as it applies its own theme (`@stxapps/expo-react`
  `data/share-theme-store.ts`) — the App Group container on iOS, the document
  directory on Android — and runs the same shared `resolveTheme`. Four things
  about that shape are load-bearing:

  - **The mirror carries the `ThemeState`, not the resolved light/dark.** A
    sheet opened at 20:00 must read dark even if the app last ran at noon, so
    `custom` is resolved at OPEN time. The file therefore never needs rewriting
    on a crossover — only on a real preference change.
  - **The read is synchronous, and applied during render, not in an effect.**
    An effect runs after the first paint: the sheet would arrive in the OS theme
    and flip. `File.textSync()` is the same lever the taxonomy snapshot already
    pulls (`docs/share-sheet.md`), and it is why the old objection — "wiring
    sqlite + settings decryption isn't worth it for a transient sheet" — no
    longer applies: neither is involved.
  - **Every failure degrades to `system`**, i.e. to the OS-following behaviour
    this replaces: no file, an unreadable one, bad JSON, an unknown mode. Nothing
    on this path throws, because a throw during the sheet's first render is a
    blank sheet.
  - **The app claims ownership before it applies** (`claimAppTheme()`, called
    from `ThemeProvider`'s effect), and the sheet defers to a claim. This is
    Android-only in effect: its share activity runs in the app's process and
    shares the warm React host, so `ThemeProvider` may already have pinned
    Uniwind — and pinning calls `Appearance.setColorScheme`, which is
    process-wide. Without the claim, a stale mirror could re-theme the RUNNING
    APP from a sheet floating over another app, with no path back (the
    provider's effect re-runs on `theme` changes only). The flag is
    per-JS-context, which is the right grain: the iOS extension is a separate
    process and never sees a claim.

  This also settles an asymmetry the sheet had before the mirror existed: warm
  Android inherited the app's pinned theme through that shared host while cold
  Android and iOS followed the OS — the same device and setting, two results.

  The sign-out teardown needs no entry for the mirror. iOS's copy sits under the
  App Group's `share/` subtree, which `clearShareData()` removes wholesale; on
  Android, sign-out drops the `localSettings` row, `useSettings` re-emits
  `DEFAULT_THEME`, and the provider rewrites the file with it. It holds no
  account data either way — a mode and two clock times.

- **bracemark-site** — the marketing site is **light-only, deliberately**, and it is
  the one property with no theme code at all: no `ThemeProvider`, no
  `themeInitScript()`, no `.dark` class ever set. Everything above this bullet is
  unreachable from it, for three structural reasons rather than an oversight: it
  has no `@stxapps/web-react` dependency (no Dexie, no `useSettings`), the
  preference lives encrypted in `settings/general.enc` behind an account the site
  has no notion of, and it serves the **apex** while bracemark-web serves `app.` —
  a different origin, so it cannot read even the `localStorage` FOUC mirror.
  The commitment is pinned in two places that must move together:
  `viewport.themeColor` and `viewport.colorScheme` in `layout.tsx`.

  Should that ever change, the mechanism is **not** the four-mode model — there is
  no account to hang a preference on and a toggle would compete with the real
  preference the app already owns. It is `prefers-color-scheme` and nothing else,
  which happens to agree with `DEFAULT_THEME` (`system`) for a visitor who has not
  chosen anything yet. Two notes for whoever does it:

  - **The greyscale is free; the accent is not.** The pages are written against the
    shadcn tokens, so they follow web-ui's `.dark` block unchanged. The site's own
    four accent tokens (`globals.css`) are authored for a white ground and invert
    badly: `--color-signal` drops from 7.88:1 on white to **2.51:1** on the dark
    background (`--color-signal-strong`, 1.87:1), while `--color-signal-soft` and
    `--color-signal-line` — subtle tints on white — become an 18:1 white panel and a
    14.8:1 rule. That is a second accent ramp to author, on 29 and 17 elements.
  - **The inverted slabs invert with it.** The hero's ciphertext panel, the claim
    section, and the featured plan card are `bg-foreground text-background`; under a
    dark theme they become near-white. They still read as the page's inverse, but
    the rhetoric — dark is the opaque thing the server sees — flips with them. A
    design call, not a token.

  On the wiring itself: web-ui's dark variant is class-based
  (`@custom-variant dark (&:is(.dark *))`), so a media query alone drives nothing.
  Prefer a short pre-paint inline script setting `.dark` from `matchMedia` (plus
  `suppressHydrationWarning`) over redefining the greyscale tokens under
  `@media (prefers-color-scheme: dark)` in the site's sheet — the latter duplicates
  ~30 of web-ui's dark tokens, which is exactly the drift that sheet's own header
  warns against, and it leaves the `dark:` variants inside web-ui components inert.

### the token shim the formatter needs

bracemark-expo declares its color tokens the Uniwind way — inside
`@variant light` / `@variant dark` under `@layer theme`, not in `@theme`. That
is correct for the build, but it makes the tokens **invisible to
`prettier-plugin-tailwindcss`**, which compiles the stylesheet with stock
tailwind and reads theme keys only from `@theme`. Utilities like `bg-primary`,
`text-muted-foreground` and `border-input` therefore generate no css, the plugin
files them as unknown classes, and unknown classes sort to the FRONT of a class
list. Left alone, every whole-workspace `npm run fix` reorders the entire expo
tree — ~56 files of pure churn that no lint or type error catches, burying the
real change in it.

`tools/prettier/expo-tailwind.css` is the fix: a **formatter-only** stylesheet
that imports `global.css` and re-declares the same `--color-*` NAMES in a real
`@theme` block. The root `.prettierrc` points the expo/expo-react override at it
instead of at `global.css`. Nothing else references it — metro names its entry
explicitly (`cssEntryFile: './global.css'`), so it cannot reach a native build.
Its values are placeholders, because sorting depends on a token's name and never
its value; mirroring the real `oklch()` values would only add a third copy to
drift against `global.css` and `web-ui/src/styles.css`.

**Adding a `--color-*` token to `global.css` means adding its name to that file
too.** Nothing enforces it; the symptom is class-order churn reappearing for
utilities built on the new token. web-ui needs no equivalent — its `@theme
inline` block already declares every `--color-*`, so a shim is expo-only.

The shim is expo-only; **an override is not.** Every app needs its own
`tailwindStylesheet` entry in `.prettierrc`, and the failure when one is missing
looks nothing like the expo case. `bracemark-site` had no entry at all for its
whole first stretch, so the plugin fell back to stock tailwind and filed _every_
token utility as unknown — not just the site's own `text-signal`, `font-display`
and `text-body`, but web-ui's `text-muted-foreground` and `border-border` too,
all of them hoisted to the front of every list. That is **stable**, so it never
churns and `--list-different` stays at zero; it is simply the wrong order,
everywhere, and nothing about a clean formatting run says so. The site's
override points straight at `apps/bracemark-site/src/app/globals.css` and needs
no shim, because its tokens are declared in a real `@theme` block — the
`@import '@stxapps/web-ui/styles.css'` at the top of that file is followed
through, so one stylesheet covers both the shared tokens and the site-local
ones. A new app is the case to watch: add the override when you add the app, or
its class lists sort against stock tailwind from the first commit.

### the state variants — and when the bare form lies

`packages/web-ui/src/styles.css` opens with a block of `@custom-variant`
declarations that bridge the shadcn shorthands onto the attributes Radix actually
emits: `data-checked:` → `[data-state="checked"]`, `data-open:`, `data-active:`,
`data-horizontal:`, and so on. Without them each shorthand compiles to a bare
presence selector that never matches, and the style silently never applies. That
block is the whole list; anything not in it falls through to Tailwind's built-in
`data-*` handling, which is a **presence** selector — `data-selected:` compiles to
`[data-selected]`, matching whenever the attribute exists at all.

That is safe on Radix, which omits an attribute when the state is off. It is
**not** safe on an attribute React writes, because React stringifies false-valued
`data-*`: `data-selected={false}` renders `data-selected="false"`, and
`[data-selected]` matches it. cmdk sets its highlight exactly that way
(`data-selected={!!selected}`), so the bare-variant `bg-muted` highlight painted
every `CommandItem` at once — the list read as a solid slab on the white popover,
no row looked picked, and the pointer highlight looked broken because it was
indistinguishable from the resting state. Nothing catches this: the class is
valid, the css is emitted, the selector is real.

A note on writing this section down, learned writing it: **do not spell a
complete bare-variant utility anywhere in `docs/` or in a source comment.** The
scanner is plain text over the whole repo — every app's css entry auto-detects
sources from the workspace root — so a documented example is extracted as a real
candidate and the dead rule is re-emitted into every app's stylesheet. Name the
variant and the utility separately, as above.

**So: `data-[selected=true]:` — the value-matching form — for any attribute set
from our own JSX or by a library that passes a boolean.** The bare shorthand is
for the bridged Radix states above. The same rule governs `data-checked` on
`CommandItem` (ours, set from `value.includes(id)`), which is why the check mark
is keyed on `group-data-[checked=true]/command-item:` — and note the bare
`data-checked:` would not even have meant the right attribute there, since the
bridge redirects it to `data-state`.

While you're in cmdk: its pointer highlight and its keyboard highlight are the
same `data-selected` attribute (`onPointerMove` selects the row under the
cursor), so a `CommandItem` needs no separate `hover:` fill. Adding one gives two
rows a highlight at once — the hovered one and the keyboard-selected one.

### the menu-item focus recolour

`DropdownMenuItem` carries `focus:**:text-accent-foreground`, gated on
`not-data-[variant=destructive]:` so a destructive row keeps its red
(`DropdownMenuSubTrigger` and the checkbox/radio items carry the same rule).
`**:` compiles to `& *` — **every** descendant, at any depth — and it outranks a
plain utility on the child (two class-ish components against one). So any colour
a menu item's own children set is a REST-state colour only: under the cursor it
is gone.

That is right for the common case, where an item is one label and one glyph and
the whole row should go to accent ink together. It is wrong wherever a child is
deliberately a different tier, and there are two of those:

- **A second, quieter line.** The links ⋯ menu's "Storage full / Some changes
  aren't syncing" row is a two-line report, and on hover its
  `text-muted-foreground` subtitle jumped to `accent-foreground` — the two lines
  flattened to one weight. `text-muted-foreground!` is the fix; the important
  suffix is the only thing that outranks the descendant rule.
  `DropdownMenuShortcut` solves the same problem from the other side, opting IN
  with `group-focus/dropdown-menu-item:text-accent-foreground` — which is what
  the item's `group/dropdown-menu-item` name is there for.
- **A glyph that means something by its colour.** `text-destructive` on an icon
  inside a default-variant item flips to near-black on hover: a red that stops
  being red the moment you point at it. Use `variant="destructive"` on the ITEM
  (the `not-` gate exempts it, and it paints the svg besides), or drop the colour
  and let the label carry the meaning — which is what the same menu's "Sync
  failed — Retry" glyph does, since that action retries rather than destroys.

Not silent, but easy to miss: the resting screenshot is correct, and you only
see it with a pointer on the row.

### contrast — the wash surfaces

[accessibility.md](./accessibility.md) sends contrast questions here, so: the one
pairing in the palette that needs watching is **`text-muted-foreground` on a wash**.
Light mode has four wash surfaces and they are all the same value —
`--muted`, `--secondary`, `--accent` and `--sidebar-accent` are each
`oklch(0.97 0 0)` — so anything muted that sits on a hovered row, a selected row,
a secondary surface or a sidebar-accent row is on 0.97, not on `--background`.

shadcn's stock `--muted-foreground` (`oklch(0.556)`, #737373) is calibrated
against `--background` alone. It measures 4.73:1 there and **4.34:1 on 0.97** —
under the 4.5 AA floor, which applies to everything below 24px (or 18.66px bold),
so making text _bigger_ doesn't buy relief until it is very big indeed. We
therefore ship `oklch(0.54)`: 5.06:1 on white, 4.85:1 on a `bg-muted/50` hover,
**4.64:1 on the full wash**.

### contrast — dark mode, where the ratio lies

Dark mode diverges from shadcn too, and for a reason WCAG cannot express. Run the
stock `--muted-foreground` (`oklch(0.708)`) against the surfaces it actually sits
on and every number looks _better_ than light mode's: 6.91:1 on the 0.205
popover/card (what a `Dialog` is — `dialog.tsx` is `bg-popover`), 7.63:1 on the
0.145 background, 5.83:1 on the 0.269 wash. Nothing fails, so nothing gets
flagged; muted text in dark dialogs nonetheless reads thin, and people report it.

The ratio is the problem. WCAG 2.x contrast is polarity-blind and overrates
light-on-dark at low luminance. [APCA](https://git.apcacontrast.com/), which is
not, scores that same pair **Lc 50 against light mode's Lc 75** — a third less
contrast from one token. Trust APCA on this axis; the WCAG number is not wrong so
much as measuring something that doesn't predict legibility here.

We therefore ship `oklch(0.78)` in dark: **Lc 60 on the 0.269 wash** — the lowest
value clearing APCA's body-text floor on the _worst_ surface, which is the same
rule that picked 0.54 in light — and Lc 63 in a dialog. It stays 41 Lc below
`--foreground` (Lc 104 on the popover), so the muted rank still reads. Parity with
light mode's Lc 75 is not reachable: it needs ~0.85, close enough to
`--foreground`'s 0.985 that the two stop being distinguishable and the hierarchy
the token exists to express collapses.

Three things follow.

- **Both values are deliberate divergences from shadcn**, in two files that must
  move together: `packages/web-ui/src/styles.css` (`:root` _and_ `.dark`) and
  `apps/bracemark-expo/global.css` (the `light` _and_ `dark` variants). Re-deriving
  either block from an upstream shadcn theme silently reverts it, and nothing lints
  or fails — the symptom is only ever a measurement. Only the token's _value_ moves,
  so `tools/prettier/expo-tailwind.css` needs nothing (it shims names). The same is
  true of the three edge tokens in the next section, which diverge for the same
  reason and travel in the same two files.
- **The dark wash is PINNED at 0.269 and cannot be raised.** It is the surface
  `--muted-foreground` was solved against, and it sits exactly on the floor: 0.78
  reads Lc 60.5 there, and a wash of 0.280 drops it to Lc 60.0 — through the
  body-text bar. So "make the hover row easier to see by lightening the wash" is
  not available; it spends a token that has no headroom left (parity would need
  ~0.85, which collides with `--foreground`). Dark's row hover is consequently
  Lc 3.0 on a popover against light's 6.1, and that is a deliberate ceiling, not
  an oversight. A brighter hover has to come from something other than the wash.
- **A new wash darker than 0.97 re-opens the question.** Check it against
  `--muted-foreground` before adding it; icons are the easier case (WCAG 1.4.11
  asks 3:1 of a meaningful glyph, which muted clears on every surface we have).
- **Check dark pairings with APCA, not a WCAG ratio.** Any new light-on-dark text
  colour — a tone on a coloured surface, a disabled state, a placeholder — will
  pass the ratio long before it is comfortable to read.
- **NEVER stack an alpha modifier on `text-muted-foreground`.** It follows from
  how both values above were picked — each is _the lowest value clearing the
  floor on its worst surface_ — so the token has zero headroom by construction and
  every `/NN` on it lands under the bar automatically. It is not a near miss:
  against the token's own Lc 75 light / 63 dark, `/70` reads Lc 54 / 36, `/60`
  reads 47 / 28 and `/50` reads 39 / 21, so a dimmed caption in dark mode is at
  or below APCA's Lc 30 spot-reading floor. Dark is always the half that
  collapses, and WCAG hides it — `/60` on the dark background still measures a
  comfortable-looking 5.5:1. Thirteen such call sites had accumulated across
  bracemark-web, bracemark-expo and bracemark-extension (both sidebars' empty
  strings and section headers, two icons, the extension's options mark, and
  `bracemark-expo`'s Input, whose NATIVE branch alone asked for the placeholder
  at `/50` while its own web branch and all three web-ui fields used the token
  whole — Lc 63 on web against an intended Lc 21 on a dark phone; the class was
  in fact never reaching the device at all, which is its own entry under
  _extending_). All of them now use the token as-is. **When something must sit quieter than muted, move
  size or weight, not opacity** — or give dark its own token the way
  `TabsTrigger` does (`text-foreground/60` with a `dark:text-muted-foreground`
  override), which is the one instance of this shape in the workspace that is
  correct. `text-foreground/NN` is the safe half of the family — `--foreground`
  has room to spare — but it is measured on the same axis: `/70` reads Lc 87
  light and only 60.5 dark, so the tag chips and disclosure buttons on both
  clients use `/80` (96 / 74), which still sits a clear rank above muted.

Contrast is not otherwise linted anywhere. `hover:text-foreground` on the `ghost`
button is why ghost triggers are exempt in their hovered state — they leave the
muted colour exactly when they land on the wash.

### contrast — dark mode, where the edge does the work

The section above is about text. The same trap catches **boundaries** one layer
down, and there it is worse, because the metric that hides it is the one a
designer reaches for first.

Take the hairline. Light's `--border` (0.922) on `--background` composites to a
lightness difference of **dOkL 0.078**. Dark's stock `--border` (`white/10%`) on
its `--background` composites to **dOkL 0.109** — by OKLab lightness, a _bigger_
step than light's. Measured with APCA, light's hairline reads **Lc 15.6** and
dark's reads **Lc 3.2**: a fifth as visible. Near black, APCA's soft-clamp models
the screen flare that actually eats those differences, and the arithmetic that
says the step is larger is describing a distinction the eye does not get to make.
So: **dOkL is not a boundary metric at the dark end.** The three edge tokens now
diverge from shadcn for that reason, by the same
worst-surface rule that picked `--muted-foreground`:

| token      | shadcn dark | ours        | why                                                                                                                                  |
| ---------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--border` | `white/10%` | `white/20%` | dark's worst surface (`--background`, Lc 9.4) now matches light's worst (the 0.97 wash, Lc 9.6); 12.0 on a popover, 14.4 on the wash |
| `--input`  | `white/15%` | `white/20%` | equal to `--border`, as the two already are in light (both 0.922) — see below                                                        |
| `--ring`   | `0.556`     | `0.7`       | `ring-ring/50` is what `focus-visible` paints: Lc 11.9 → 20.0 against light's 27.8; `border-ring` 30.5 → 51.6 against light's 53.4   |

`--sidebar-border` / `--sidebar-ring` move in lockstep, as they do in light.

**`--input` is three roles, not one**, and that is what fixes its value at 20%
rather than the 25% the border role alone would want: it is the control's border
(`border-input`), the control's fill (`bg-input/30`), and the tag chip
(`bg-input`, `links/tags-field.tsx`). At 25% the border matches light exactly but
the chip goes to Lc 18.9 against light's 10.9; at 20% the chip reads 14.2 and the
border 12.0. shadcn's 10/15 split existed only to prop up a `--border` too weak to
draw a control — once the hairline is right, the split has no job, and equality
restores the structure light already has.

#### elevation: in dark, a panel has no fill and no shadow, only an edge

A floating panel normally separates from what it sits on three ways. In dark two
of them are unavailable, and both fail to **exactly Lc 0.0**:

- **Shadow does nothing.** `shadow-2xl` is a black shadow; on `--background` it
  measures Lc 0.0. There is no dark-mode shadow that separates anything.
- **Fill does nothing, twice over.** `--popover` on `--background` is only Lc 1.6
  to begin with — and the popovers in `links/list-select.tsx` and
  `links/tags-field.tsx` open from inside the quick-add popover and the edit
  Dialog, which are **themselves `bg-popover`**. Panel and backdrop are then the
  same colour: Lc 0.0.

Raising `--popover` does not rescue this: the dark end is so compressed that
moving it 0.205 → 0.34 — far enough to wreck the surface ramp — buys only Lc 7.5.
**The edge is the efficient lever, and in dark it is the only one.** So every
elevated surface draws one with `ring-1 ring-border`: `popover`, `select`,
`dropdown-menu` (both), `dialog`, `alert-dialog`, `card`, and the extension's
`PageSpecimen`. That replaced three hand-typed values (`ring-foreground/5`,
`ring-foreground/10`, and a `dark:ring-foreground/10` one-off on `dropdown-menu`
— a local patch for exactly this bug, which reached only Lc 4.8 and only on one of
the six surfaces). Using the token instead of a `foreground/N` mix is what lets
the edge be a whisper in light and a real line in dark from one declaration; it
also costs light mode nothing, since `ring-border` there is Lc 15.6, which is
where `card` already was.

This is why **expo needs no counterpart change**: React Native has no `ring`, so
`apps/bracemark-expo` already draws every panel edge — its `dropdown-menu`
popover included — with `border-border`, and inherits the fix from the token.

**A bottom sheet is the case where the edge is not enough, and there the fill has
to be the lifted one.** Quick-add below `md` on web, and always on expo
(`features/links/link-add-panel.tsx`), is a form on a `bg-black/50` scrim over the
links page, and it used to wear the page's own `bg-background`. In light the scrim
does all the work — it takes the white page to `#7f7f7f`, and the panel reads
Lc 75.3 against it. In dark it does none: there is nothing to subtract from a
0.145 page, which lands at `#050505` under a `#0a0a0a` panel, **Lc 0.7**. A
darker scrim changes nothing (`/80` reads 0.8). That left the `border-t`, and an
edge-attached sheet has only the one: a single horizontal `border-border`
hairline, drawn across a list whose rows are divided with the same token. A
closed ring outlines a panel; one line over a list is one more row divider, which
is how it read on the Pixel 8 AVD and in a 390px browser alike.

So both ports take `bg-popover` — the recipe every other elevated surface in
this section already is, fill and edge together. By Lc the fill is still almost
nothing (1.7), exactly as the heading says, and the hairline it sits under moves
only 9.5 → 13.0. What it buys is not on that scale: a region instead of a line,
so the corners and the header's whole width differ from the page where only one
pixel row did before. It also makes the form one colour in both its web
containers — the `md`+ popover was `bg-popover` all along.

On web the fill lives in `sheet.tsx`'s base rather than at a call site, so every
sheet has it: quick-add and **Move to** (`links/move-to-surface.tsx`, whose wide
twin is a `Dialog` — `bg-popover` too) from the bottom, and the links drawer from
the left. Expo's Move to is a `Dialog` already.

**A nav drawer is the same case, and it was first ruled out of it.** The left and
right sheets used to keep `bg-background`, on the reading that they are the nav
rails — the page's sidebar arriving from an edge — and that a full-height
`border-r` is not something a row divider can be mistaken for. That is true of
the line and beside the point: it is the same `bg-black/50` scrim over the same
page, so the drawer's fill reads the same Lc 0.7 against its backdrop, and the
hairline (Lc 9.5) was the only thing left — one line down a screen with the same
colour on both sides of it. On expo there was not even that. Both drawers
(`features/links/sidebar.tsx`, `features/settings/sidebar.tsx`) are
react-navigation's, which draws a border only for a `permanent` drawer; a `front`
one gets a corner radius that the sidebar's square view paints over, and a panel
fill of `colors.card` that the sidebar covers. So the two sidebars now draw
`border-r border-border bg-popover` themselves — in the token rather than the
navigator's `colors.border`, which is the stock light grey in both modes (only
`background` is overridden; see _per-app wiring_ above) — and the edge reads
Lc 13.0 on the lifted fill.

**What decides it is whether the surface floats, not what it contains.** The same
`SidebarBody` is `bg-background` in bracemark-web's `md`+ `<aside>`: there it is a
column of the page, level with the topbar its header's hairline meets, with no
scrim and nothing under it. A lifted fill would be an Lc 1.6 tint that splits the
frame into two colours. The fill belongs to the host, which is why the shared
body sets none.

The cost is the active row. `bg-muted` reads Lc 3.9 on the page and Lc 3.0 on a
popover — the ceiling _contrast — dark mode, where the ratio lies_ already
records for every menu row, and the wash cannot be raised to buy it back. The active row carries
`font-medium text-foreground` as well, so it is not the fill alone that marks it.

The iOS/Android **share sheet** (`features/share/share-kit.tsx`) takes the pair
too, and needed it most: it wore `bg-background` with no edge at all, over a
backdrop that is not ours — the host app, dimmed by the system on iOS and by a
`bg-black/40` scrim on Android — which in dark is usually dark as well. Its saved
specimen paints its corner cut in the panel's fill (`share-specimen.tsx`), so the
two classes move together; nothing catches a mismatch.

The two system-modal editors on expo (`link-edit-screen.tsx`, `search-bar.tsx`)
stay `bg-background`, for a different reason: full-screen on Android, and on
iOS a page sheet that covers everything but a blank strip under the status bar,
so there is no page left behind them to be confused with.

The two fixed notices on web take the fill as well, and neither takes
`bg-primary`. `update-pill.tsx` floats over the page with no scrim, and
`update-required-banner.tsx` is `fixed` over the topbar rather than being one,
and above the modal layer besides ([offline-mode.md](./offline-mode.md));
both wore `bg-background` under a `shadow-*` that measures nothing in dark, so
the pill was an outline and the banner had the topbar's own fill and hairline. Each
keeps its own edge — the pill's closed border, the banner's `border-b` (Lc 12.7
on the lifted fill, against 9.4). **Primary is the fill of a surface that _is_
the button** — the FAB, the links pane's "New updates" pill — and these two
_contain_ one: on primary their Reload would vanish into the surface, the
banner's `text-muted-foreground` line would read Lc 26–29, and the pill
[offline-mode.md](./offline-mode.md) calls quiet would be the loudest thing on the
page for as long as the tab stays open.

What stays `bg-background` is what is level with the page: the sticky topbars and
expo's sticky footer are bars of the frame, closed by a hairline, with nothing
under them but the content they scroll.

### the radius scale — one shape system, two kits

**The round shape is not a token, and raising `--radius` will not produce it.**
`--radius: 0.625rem` is mirrored byte-for-byte in `packages/web-ui/src/styles.css`
and `apps/bracemark-expo/global.css`, and both derive the same
`--radius-sm/md/lg/xl` from it (6/8/10/14px). Neither sheet touches
`--radius-2xl`, `--radius-3xl` or `--radius-4xl`, so those keep Tailwind's own
defaults — 16px, 24px, 32px — on both sides. The kit's round look is written into
the COMPONENTS as `rounded-4xl` / `rounded-2xl` / `rounded-xl`, which do not
derive from `--radius` at all. Move `--radius` and you move the registry
leftovers and nothing a user notices; the classes are the system.

| role                                                    | class           | px  | components                                                                                                |
| ------------------------------------------------------- | --------------- | --- | --------------------------------------------------------------------------------------------------------- |
| single-line control                                     | `rounded-4xl`   | 32  | button, input, select trigger, command input, input-group, tabs list                                      |
| dialog surface                                          | `rounded-4xl`   | 32  | dialog content, alert-dialog content                                                                      |
| floating or edge-attached surface                       | `rounded-2xl`   | 16  | dropdown-menu content (and sub-content), popover, select content, card, accordion, bottom sheets          |
| row in a surface, and any control too tall to be a pill | `rounded-xl`    | 12  | menu items (item, checkbox-item, radio-item, sub-trigger), select item, tabs trigger, field, **textarea** |
| box                                                     | `rounded-[6px]` | 6   | checkbox                                                                                                  |
| circle                                                  | `rounded-full`  | —   | radio dot, switch, the alert-dialog media badge                                                           |

Expo's `TagsField` no longer needs a wrapping-field exception: it is the same
single-row outline Button shape as `ListSelect`, and therefore takes the normal
`rounded-4xl` single-line-control radius. Web's token-combobox trigger remains a
`rounded-2xl` control, but is also one line: two removable selections plus a
non-shrinking `+N` keep its height fixed.

**32px on a 36–40pt control is a pill, not a rounded rectangle**, and that is the
point: CSS and React Native implement the SAME rule — css-backgrounds-3's
corner-overlap clause, "proportionally reduce the used values of all border radii
until none of them overlap", which RN spells out in
`ReactCommon/react/renderer/components/view/BaseViewProps.cpp`'s
`ensureNoOverlap` — so 32 on a 40pt-tall control resolves to 20 on both sides and
the same class reads identically across the two runtimes, even though native's
touch heights are taller (`h-10 sm:h-9` against web's `h-9`). The value is deliberately
one number for both rather than a per-platform "pill" spelling, because a pill
spelled as `rounded-full` would flatten the dialog surfaces — which are NOT pills
and must keep 32px against a 400pt box.

**An edge-attached sheet takes the floating-surface radius on only its free
corners: `rounded-t-2xl` for a bottom sheet.** Web quick-add is the same form as
its wide popover, so changing containers must not change its shape; the native
quick-add panel and share sheet follow that role too. `rounded-4xl` remains for a
detached dialog with four visible corners. A system-presented modal is the other
case: the navigator or native `Modal` owns the outer corners, so the app does not
redraw them. Its inner spacing may still follow that presentation — the edit-link
and Advanced Search headers carry the app's only two `ios:` variants, `ios:pt-4`
and `ios:pt-2.5` over a shared `pt-2`, because iOS's page-sheet arc wants optical
clearance that Android's full-screen modal (already inset by `SafeAreaView`) does
not.

**The two numbers differ because the anchor is the TITLE'S CAPS, not the
padding.** Advanced Search's header row is set by its 40pt close button, so a
28pt `text-lg` line box floats with 6pt of slack above and below; edit-link's row
IS its 44pt title/URL stack, where the padding is the whole gap. Add Inter's
7.4pt from line-box top to cap top (_extending_, below, carries the metrics) and
both titles land 23.4pt under the sheet's edge. The shared `ios:pt-5` the two
used to carry put them 6pt apart, and both loose. Nothing BELOW the title is
forked, and nothing should be: the arc is the only iOS-specific thing about these
headers, so where the bottom paddings differ (`pb-2` against `pb-2.5`) they
differ on BOTH platforms and answer their own content — a muted subtitle line
sits closer to the border than a floating single title does. Android is still
6pt apart on the same cap-top measure, because the shared 8pt base cannot see the
button's slack; the correction would go on Advanced Search, and it has not been
eyeballed on the AVD.

⚠ **The two kits are separate copies and this pairing drifted for months.** There
is nothing to import across them (Uniwind and Tailwind are separate compilers
over separate stylesheets, the same reason `brand-lockup.tsx` exists twice), so
`packages/web-ui/src/components/ui/*` and
`apps/bracemark-expo/src/components/ui/*` hold the numbers twice. web-ui was
restyled to the scale above; the react-native-reusables copies kept the
REGISTRY's defaults — `rounded-md` on button and input, `rounded-lg` on both
dialogs and the tabs list, `rounded-md`/`rounded-sm` through the whole
dropdown-menu, `rounded-[4px]` on the checkbox — and nothing said so. No lint
error, no type error, no failing test; the two apps are never on one screen, and
each looks internally consistent on its own. It surfaced only when someone put
the two side by side. Each native file now records its radius in its own
"local changes vs upstream" list, which is also what stops a re-copy from the
registry from quietly undoing it.

Before spending a native build on a radius, run the Uniwind probe in _extending_
below: every class in the table above is confirmed to map (`rounded-*` resolve to
their `--radius-*` var, `rounded-full` to 99999, arbitrary `rounded-[6px]` to a
literal 6), but an unmapped class is silently absent on the device rather than an
error.

**Radius was the first axis brought into parity; the section below is the rest
of that audit.**

### the two kits — what is ported, what is platform, what is still open

`packages/web-ui/src/components/ui/*` (shadcn, over Tailwind) and
`apps/bracemark-expo/src/components/ui/*` (react-native-reusables, over Uniwind)
are the same nine primitives written twice: alert-dialog, button, checkbox,
dialog, dropdown-menu, input, radio-group, switch, tabs. Nothing can be imported
across them, so every shared value is stated twice and the pair has to be held by
this document and by each native file's "local changes vs upstream" list.

**`textarea` is a tenth pair and the one that is NOT written twice.** The
registry ships no textarea, and on this platform there is nothing to copy: web
has two elements, RN has one `TextInput`, and the native `ui/input.tsx` is where
the font-scale cap ([accessibility.md](./accessibility.md), `lib/font-scale.ts`)
and the `keyboardAppearance` theme lift live. So
`apps/bracemark-expo/src/components/ui/textarea.tsx` COMPOSES that file — four
overrides and nothing else (`rounded-xl`; `h-auto sm:h-auto min-h-16` for web's
`field-sizing-content min-h-16`; `py-3`; `textAlignVertical: 'top'`, which
Android needs and no utility class reaches) — rather than rendering a second
TextInput that both of those single-site rules would then have to be taught
about. Its header is its "local changes" list, against web-ui's `textarea.tsx`.
The `sm:h-auto` half of that cancel is the load-bearing one: `cn` is
tailwind-merge, so a conflicting `h-*` drops Input's `h-10` but leaves its
`sm:h-9` standing — a different variant scope is not a conflict — and a note
field that silently collapses to 36pt is waiting on the first screen wide enough
to match `sm:`.

**PORTED — web-ui is the source of truth for all of these.** The native copies
sat at the registry's defaults until this pass; they now carry web's values:

| axis                     | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| radius                   | the whole scale above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| control shadows          | none. The registry puts `shadow-sm shadow-black/5` on button, input, checkbox and radio; web-ui carries no shadow on any control (only floating surfaces get one)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `destructive` button     | a TINT — `bg-destructive/10 text-destructive`, pressing to `/20` — not a solid `bg-destructive` with white text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ghost` button           | presses to `muted`, not `accent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `outline` button, input  | `bg-input/30` in both themes, not `bg-background` with a dark-only override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| radio, checked           | the disc FILLS `bg-primary` under a `primary-foreground` dot. The fill carries its own `rounded-full` and the item has no `overflow-hidden`: iOS clips children to the BORDER box where Android clips to the padding box, so a square fill clipped by the ring kept four flat sides that only dark's translucent `--input` border let through                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| dialog overlay           | `bg-black/80`, not `/50`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| dialog surface           | `bg-popover`, not `bg-background`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| dialog width             | 28rem on both native contents (`max-w-md`), against the registry's 32. Only the NUMBER ports out of web's `min(var(--dialog-max-w,28rem),calc(100%-2rem))`: the `calc` gutter is the native overlay's `inset + 8` padding, and the token is a tailwind-merge workaround for web's breakpoints (a native caller narrows with a plain `max-w-sm`, and two do, at web's same 24rem). The alert-dialog takes web's ≥`sm` 28rem rather than its 20rem base, because web steps 20 → 28 in lockstep with its header going centred → left-aligned and the native header is left-aligned always                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| dialog title             | `text-base font-medium`; the alert-dialog's is `text-lg font-medium`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| dropdown row             | `px-3 gap-2.5` on every row INCLUDING the sub-trigger (web's own sub-trigger sat at `gap-2` and was brought up to match, so this is the one entry where the native copy was right first); the label is `text-xs text-muted-foreground`; the separator is `bg-border/50`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| dropdown state indicator | the TRAILING edge: `pr-8 pl-3` on checkbox- and radio-item rows, the indicator box `absolute right-2` — not the registry's leading gutter. Ported while nothing imported either component, since the next call site would have inherited the side silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| dropdown `inset`         | `pl-9.5` — the row's `px-3` plus a `size-4` glyph plus `gap-2.5`, i.e. where a leading-icon row starts its text. The registry's `pl-8` was the same sum over `px-2`/`gap-2`; porting the row inset without it left native 6px short, silently, on a prop no call site uses yet. Carried by Item, Label, SubTrigger, CheckboxItem and RadioItem on both sides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| picker row               | `px-3`, from web-ui's `CommandItem` — every row of the list and tag pickers on both platforms (`links/list-command.tsx`, `links/tag-picker-rows.tsx`, and the share sheet's line-for-line copy of the list rows), so one tag name sits in one place across the two ports. Native keeps its own `py-2.5` and `min-h-11` (the one-step-taller rule below, and [accessibility.md](./accessibility.md) on why a row takes the 44 as height rather than as slop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| picker tree indent       | one `w-6 border-l` guide line per level of depth, drawn INSIDE the row — 24 per level on both platforms (`links/guide-lines.tsx` is the native leaf; web inlines the spans in `CommandItem`). Native drew a bare `paddingLeft: depth * 12` instead until this pass, so depth read as "starts further right" with nothing tying a child to its parent. Two cancels make it work, and both are silent if dropped: `-my-*` cancels the row's vertical padding so a line spans the full row height and meets the next row's (`-my-2` web, `-my-2.5` native), and **`-mr-2` cancels the row's `gap-2` for the guide/name pair** — that gap lands on the name and not on the lines, so it offsets the two by a constant 8 that NO unit width can absorb, and only depth 1 looks right (`line_1` = `text(0)` either way). With it cancelled a level costs one unit on both, so `line_n` = `text(n-1)`: every line hangs from the left edge of the name it belongs to. The unit is 24 because that is what the names already stepped by (`w-4` + the gap), so the fix moved depth 2 and deeper, not depth 1. Both hide the indent entirely while filtering, where the ancestor path carries the depth instead |
| picker empty state       | `py-6 text-center text-sm text-muted-foreground` — centred, so it reads as a state of the panel rather than as a row at the rows' own inset (worse on native, where a non-pressable line in row geometry sits among Pressables that light up under a finger). The muting is a local change to the registry's `CommandEmpty`, which paints at full foreground                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| tabs, inactive trigger   | `text-foreground/60`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**PLATFORM — these differ because the runtime differs, and they are correct.**
`ring-*` becomes `border-*` (RN has no ring — see _elevation_ above); Radix
`data-*` state selectors become props and rendered indicators; hover becomes
press (`active:`), value for value; `hitSlop` does what web's `after:-inset-*`
does; every size is one step taller than web's, because a phone target is not a
pointer target; `Switch` is the platform control rather than the registry's
`Pressable` (its own header argues that at length), and its palette is mapped
twice — web's tokens on iOS, where the thumb sits inside the track, and the
thumb-carries-`primary` convention on Android, where it overhangs onto the page; text colour reaches children
through `TextClassContext` rather than a cascade, which is why a call site that
wants a non-default step restates it on its own `Text`.

**STILL OPEN, deliberately.** Native `Button` has web's eight sizes but no
per-size icon shrink (web's `[&_svg]:size-*` has no descendant-selector
equivalent — call sites size their own glyph); the checkbox has no
indeterminate; alert-dialog has no media badge and no `size` variants; and
ten web primitives have no native twin at all (accordion, card, command, field, input-group, label,
popover, select, separator, sheet) — some by design, since the share
pickers are screens rather than overlays ([share-sheet.md](./share-sheet.md)).

⚠ **An icon button is `<Button variant="ghost" size="icon-sm">`, not a
`Pressable` with classes on it.** Twenty call sites drew their own — a
`size-9 rounded-md active:bg-muted` box — in the very screens whose web twins
use the kit's Button, and the day the kit took web's radii every one of them
became an 8px square beside a pill. (Two more controls were the same story at
other sizes: the share sheet's back button, now `variant="ghost" size="sm"`, and
the list picker's combobox trigger, now `variant="outline"` exactly as its web
twin is.) **The registry copies themselves are a source of these, not only call
sites**: `ui/dialog.tsx`'s corner close shipped as a bare `Pressable` wearing
`rounded opacity-70 active:opacity-100` — a 4px radius belonging to no role in
the table above, an opacity blip where every other icon button gives a ghost
fill, and a box that was just the 16pt glyph, which `hitSlop={12}` could lift
only to 40 — while web-ui's twin had been `variant="ghost" size="icon-sm"` all
along. It is the kit's Button now, at the scale's one-step-taller 36, and the
file's own local-changes list records it. Hand-rolled control chrome does not track the
kit, and nothing reports that it has stopped matching: it is a valid box with
valid classes. **It is not only buttons**: the same rule caught two
checkbox-shaped boxes a pass later, both still at the registry's `rounded-[4px]`
after `ui/checkbox.tsx` took web-ui's 6 — the advanced-search editor's tri-state
row (`features/links/search-bar.tsx`) and the opaque plate the card puts behind
its selection checkbox so an unchecked outline survives a light photo
(`features/links/link-card.tsx`, whose comment read "at the checkbox's own 4pt
radius": the prose tracked the kit while the class did not, which is the failure
in miniature). (The component itself spelled that radius `rounded-sm` — the same
6px, but a spelling that rides `--radius`; it now says the `rounded-[6px]` the
table above lists.) The tri-state row is the case this rule cannot dissolve into
"use the component": `@rn-primitives/checkbox` types `checked` as a `boolean`, so
a row with include/exclude/off has no kit component to reach for and must restate
its values by hand. It now carries a note saying so and naming what to follow,
which is the only thing holding it. Two of them legitimately restate the BOX
(`className="size-8"` on the link row's ⋯ trigger and the links rail's
disclosure, whose web twins pin the same 32 for the same reason) — restating a
box is fine, redrawing the control is not. Rows are the exception that proves
it: a nav row or a list row is not a control, both apps hand-roll them, and both
spell them `rounded-md` (a picker row inside a surface takes `rounded-xl`, the
same role the kit's menu items have).

### extending

- **A new mode** — add it to `THEME_MODES` (`theme/theme.ts`), handle it in
  `resolveTheme` (and `msUntilNextThemeSwitch` if it's time-based), mirror the
  branch in `themeInitScript`'s ES5 IIFE (web FOUC only), and add a radio in both
  apps' `misc-section.tsx` — its label and hint go in `@stxapps/react`
  `lib/misc-settings-copy.ts`, whose `Record<ThemeMode, …>` will not typecheck
  until they do; only the icon stays at the call site. `coerceThemeState` accepts
  any value in `THEME_MODES` automatically. bracemark-expo's `ThemeProvider` needs no change for a normal
  resolve-and-pin mode (it goes through the shared `resolveTheme`); it only needs
  a new branch if the mode requires a distinct apply path like `system`'s (leave
  the `Appearance` override clear) or a non-`Appearance`/non-timer trigger.
- **A new theme field** — put it beside `theme` in `settingsGeneralSchema` (a new
  sibling round-trips through the parent `looseObject`), not as a sub-key of
  `theme`. Add it to `ThemeState` + `coerceThemeState`, and to
  `LocalSettingsRecord` if it needs a device variant.
- **A new utility class on the expo side** — check that Uniwind can actually map
  it before you spend a native build. An unmappable class fails **silently**: no
  lint error, no type error, and the style is simply absent on the device. You
  can settle it in seconds in node instead.
  `node_modules/uniwind/dist/module/bundler/css-processor/processor.js` exports
  `ProcessorBuilder`, and `new ProcessorBuilder({}).transform(cssText)` fills
  `.stylesheets` with the per-class RN style objects. Feed it what `npx
@tailwindcss/cli -i apps/bracemark-expo/global.css -o out.css --content
<probe.html>` emits; the dist ships unresolved `@/` aliases, so run it under a
  `module.register` resolve hook mapping `@/x` → `dist/module/x{,.js,/index.js}`.
  Two things this settles that reading the source does not: **`rem` is baked at
  BUILD time to `value * 16`** (`--uniwind-em`, from `polyfills.rem`, which
  `metro.config.js` does not set), so a `max-w-105` cap is a hard 420 that does
  NOT move with the OS font scale — unlike web, where the class and its mirrored
  JS constant can drift under a raised root font size; and ratio values survive
  as **strings** (`aspect-12/7` → `aspect-ratio: "12/7"`), which RN accepts.
  Don't take comfort from an existing usage without checking how it's paired —
  `aspect-square` was already in `ui/radio-group.tsx`, but alongside `size-4`, so
  a broken `aspectRatio` there would have been invisible.
- **`rotate-*` is one of the classes that doesn't map** — settled by that probe,
  so don't re-derive it. Tailwind v4 compiles `rotate-90` to the standalone
  `rotate: 90deg` property (not `transform: rotate(90deg)`), which uniwind turns
  into the nested style `{ rotate: { rotateZ: '90deg' } }`; its runtime
  (`core/native/parsers/transforms.ts`) moves that value whole into RN's
  `transform` array, so RN gets an entry whose value is an object and drops it.
  A rotated glyph on this side is therefore a DIFFERENT GLYPH: a disclosure
  chevron is `expanded ? ChevronDown : ChevronRight` (lucide's ChevronDown is
  ChevronRight at 90°), as `features/links/sidebar.tsx` and
  `features/settings/lists-section.tsx` both spell it, against a web twin that
  says `rotate-90`. For an angle with no glyph — the dog-eared card's 45° corner
  — write the RN `transform` array inline in `style`
  (`features/share/share-specimen.tsx`).
- **`placeholder:` is another, and it took the Input's placeholder with it.**
  Tailwind emits `placeholder:text-muted-foreground` as a nested `&::placeholder`
  rule, and Uniwind's processor (`bundler/css-processor/processor.ts`) keeps a
  nested selector only when it has a runtime answer for it — a theme class,
  `:active`, `:focus`, `:disabled`, a `data-*` attribute. A pseudo-element has
  none, so the class reaches the device as `[{}]`: present, empty, and no
  warning. `ui/input.tsx` carried that class on its native branch from the
  registry, so no placeholder colour was ever set and each platform drew its own
  default hint — UIKit's `placeholderText` (a 30% alpha: Lc 16 on the dark field,
  30 on the light one) and AppCompat's (39 / 50) — against the Lc 62 / 70 of
  `--muted-foreground`, which is what web's fields wear. The native lever is the
  prop `placeholderTextColorClassName="accent-muted-foreground"`: Uniwind
  resolves an `accent-*` utility to RN's `placeholderTextColor` and re-resolves
  it per theme. The same goes for the other colours a `TextInput` takes as props
  rather than style (`cursorColorClassName`, `selectionColorClassName`). **Run
  the probe through `compileTailwind`, not the Tailwind CLI, for anything with a
  variant in it**: the CLI flattens nesting to
  `.placeholder\:…::placeholder { color }`, which the processor then reads as a
  plain `color` on the class — an answer that is wrong in the other direction,
  and not what Metro sees.
- **A placeholder longer than its field wraps on Android, and no class or prop
  stops it.** A single-line field's hint mounts on one line, clipped at the
  edge, and then wraps the first time it changes or the field is typed in and
  cleared: the second line shows as a sliver under the first, which the
  fixed-height box has pushed off-centre. Android lays a hint out at two
  widths — "very wide" during a measure pass, the view's physical width when a
  discarded layout is rebuilt at draw time — and under Fabric the second is the
  common one, because nothing re-measures a field whose frame did not change.
  The link editor's Title is the field that showed it: its placeholder is the
  page's extracted title, which is long and arrives after mount. `numberOfLines`
  does not help (it caps the typed text's layout, not the hint's), and there is
  no JS route to a measure pass. The lever is an ellipsize mode on the native
  `EditText`, which makes both paths truncate to one line and leaves typed text
  alone. React Native sets it itself from **0.88**; on 0.81 it has no prop, so
  `ui/input.tsx` reaches it through a local module
  (`apps/bracemark-expo/modules/bracemark-input`, Android only) off the field's
  first `onLayout`. Every field gets it from the chokepoint; a call site does
  nothing. iOS needs none of this — `UITextField` truncates its placeholder on
  its own, checked on the simulator. Retiring the module is a line in
  [dependency-upgrades.md](./dependency-upgrades.md), _the target window_.
- **A `leading-*` tighter than the font is not centred on iOS**, and nothing
  about the class is broken. Uniwind resolves a unitless line-height against the
  element's own font-size at style time (`core/native/store.js`, `lineHeight < 6`
  → `× fontSize`), so `leading-none` on the 15px step reaches RN as a 15pt
  lineHeight — the same number web computes. What differs is who pays for the
  deficit against the font's natural box. Web splits the negative half-leading
  evenly above and below the glyphs, and so does Android
  (`CustomLineHeightSpan`, which implements the css-inline-3 rule); iOS's
  `RCTApplyBaselineOffsetForRange` **returns early** whenever
  `maximumLineHeight < font.lineHeight` — it only ever compensates a box LARGER
  than the font — and TextKit then takes the whole shortfall off the ASCENT. So
  the glyphs ride high by about half of it. Inter's natural box is 1.21× its
  size, and at 15pt (measured through TextKit with this repo's own
  `assets/fonts/InterVariable.ttf`) `leading-none` puts the baseline 11.0 from
  the top of a 15pt box and the cap block's centre at 5.54 against the box's 7.5:
  **~2px high**, which is what pulled the brand wordmark off the middle of its
  16px mark ([brand-assets.md](./brand-assets.md), _the lockup_). `items-center`
  is not the cause and no `items-*` value is the cure — the two boxes are centred
  to the pixel; the caps are not centred inside theirs. Drop the leading and the
  font's own box does it for free (for Inter, ascender − cap height = descender
  exactly, 1984 − 1490 = 494 units, and its `win` metrics equal its `hhea` ones,
  so Android's `includeFontPadding` adds nothing asymmetric either), or pick a
  leading at or above 1.21 so the iOS compensation actually runs. Nothing about
  it reports itself: it is a valid style on a valid tree, jest never lays text
  out, and on Android — the cheap surface, where a layout usually gets eyeballed
  first — the same class is off by half a pixel. **The NAME is now linted**
  (`apps/bracemark-expo/eslint.config.mjs`, a `no-restricted-syntax` selector
  over string literals, which is where this app's `leading-none`s came from: a
  port of a web twin arrives holding a class that is correct there). What lint
  cannot judge is a NUMBER — whether `leading-4` is tight against the size it is
  paired with is arithmetic across two classes — so the rest of this bullet is
  still the only thing standing between you and it.

  **So on this side: `leading-none` never, and no leading under `leading-tight`.**
  It is the only step in the scale that _cannot_ clear Inter's 1.21 — `1.0`
  against `1.25`, which is the next step up and clears it by 0.04 — and what it
  buys on web, a box tight to the glyphs, is what RN gives for free when no
  leading is set at all. Setting none is therefore the port of `leading-none`,
  not a loss of one. Every `leading-*` on the expo side has been measured against
  its own font-size this way and the rest are fine (offsets in points, `+` = low):
  `text-xs`+`leading-4` −0.11 and +`leading-5` −0.11, `text-base`+`leading-5`
  −0.14 (as `Text` — not as `ui/input.tsx`, see below), `text-base`+`leading-7`
  (`ui/text.tsx`'s `p`) −0.14,
  the 15px specimen+`leading-snug` −0.38, `text-3xl`+`leading-tight`
  (`components/landing.tsx`) +0.24. The three that were not are the three
  `leading-none`s, all now gone: the brand wordmark (−1.96), `ui/text.tsx`'s
  `small` variant (−1.09) and `ui/dialog.tsx`'s `DialogTitle` (−1.55, which also
  put it 3.8pt tighter than `alert-dialog.tsx`'s title, its sibling, which never
  had one). Both registry files carry the note in their own local-changes list.

  Re-measure rather than re-derive if the family ever changes: 1.21 is **Inter's**
  ratio (`assets/fonts/InterVariable.ttf`), and the self-centring that makes the
  no-leading case exact is Inter's too — its ascender minus its cap height equals
  its descender to the unit. Both are properties of the file, not of RN.

  **A single-line `TextInput` on iOS is the OTHER direction, and gets no leading
  at all.** Its lineHeight reaches UITextField as a bare paragraph style — the
  `defaultTextAttributes` path, which `RCTApplyBaselineOffset` never runs on — so
  a box LARGER than the font isn't compensated either, and the whole surplus goes
  above the glyphs. Measured on the simulator, caps against a 40pt field:
  `text-base`+`leading-5` +0.50 low, `text-sm` at its own 20pt leading +3.17
  (the search-bar filter box, which tailwind-merge lets swap the size and the
  leading together), unset +0.17 — half a device pixel, the floor. Android
  splits it evenly and was never off. So `ui/input.tsx` unsets it on iOS for
  single-line fields, in `style` rather than in classes, which is why it holds
  at every call site whatever size it passes; its comment carries the rest,
  including why `leading-[normal]` is not the spelling.

  **A FIXED BOX CLIPS A LINE BOX TALLER THAN IT, and the bottom edge is where
  it shows.** This is the third direction and the only one with no leading in
  it: `text-base` is not a size, it is a size PAIRED with Tailwind's 1.5
  line-height — a 24pt box for a 16pt font — and a box's usable height is its
  `h-*` minus its borders minus its vertical padding. Yoga measures a row child
  against that inner height AtMost, so a taller line box has the paragraph's own
  frame CLAMPED to it, while iOS has already dropped the glyphs by half the
  box's surplus over Inter's 1.21× (the compensation above, working as
  designed). What falls off is therefore the DESCENDER: measured on an iPhone,
  the y of `My List` and the g of `Add tags`, the two combobox triggers the link
  editors put beside an Input.

  **The first box found doing it was the kit's**:
  `Button size="default"` carried the registry's `h-10 px-4 py-2`, and `py-2`
  left 22pt inside a height the class had already pinned — so the padding could
  not size anything and could only shrink what the label was measured against.
  22 fits the kit's own `text-sm` label at 1× with 2pt to spare, which is why
  this surfaced first at the three call sites that restate `text-base`
  (`components/links/list-select.tsx`, `components/links/tags-field.tsx`,
  `features/settings/time-field.tsx` — the first carries the measurement), and
  it does **not** fit that same label one Dynamic Type step up: RN's iOS
  multiplier for `ExtraLarge` is 1.118, 20 × 1.118 = 22.35, so every
  default-size button in the app clipped its descenders for anyone who had ever
  touched the text-size slider — ~35 call sites, none of them wrong in
  themselves. At `sm:` (`h-9`, 18pt inside) it clipped at 1×, which is one more
  thing the tablet layout would have walked into (_the two kits_, above).
  **The padding is now gone from every size in the native kit** — `ui/button.tsx`
  carries the derivation — which is also a drift closed rather than opened, since
  web-ui's own `default` is `h-9 gap-1.5 px-3` and has never had vertical
  padding. Removing it is invisible at 1× (the height is unchanged, and
  `items-center` centres the same line box in the same box) and leaves 38pt
  inside, which absorbs the 1.3 ceiling for `text-sm` and `text-base` alike.
  That ceiling is worth reading in this light: [accessibility.md](./accessibility.md),
  _font scaling_, bounds the overflow "to what the surrounding chrome absorbs",
  and a fixed box with padding that leaves 2pt of slack is chrome that absorbs
  nothing.

  Nothing reports any of it — a valid class on a valid tree, jest never lays
  text out, and the web twins are correct as written, because a web button does
  not clip an overflowing line box, which is what makes such a class look safe
  arriving from a port. **So: no vertical padding on a box whose height is
  pinned** (it cannot add room and can only take it), and a control that means
  to match an `Input` takes `ui/input.tsx`'s type verbatim — `text-base
leading-5`, measured-centred as a `Text` — rather than the size variant's.

  **The budget to check is at the 1.3 cap, not at 1×**: inner height ≥ 1.3 ×
  the line box — 26 for `text-sm`, 31.2 for `text-base`, 20.8 for `text-xs`.
  Two more boxes failed it after the button, both exact at 1× and both only
  visible with the OS text size raised: `ui/tabs.tsx`'s list (`h-9` minus its
  `p-[3px]` and the trigger's border and `py-1` left 20 — the labels were cut
  in half; now `min-h-9`, since nothing else pins it), and the advanced-search
  filter box (`h-8` minus Input's `py-1` left 22 — Android sheared the cap
  tops; now `py-0`, the button's fix). Growing a single-line Input with `h-auto
min-h-*` is not the general answer: an empty Android field measures its
  placeholder taller than typed text, so the box shrinks on the first keystroke.
  The budget is now a spec, `components/ui/line-budget.spec.tsx`, which fails on
  all three specimens as they shipped ([accessibility.md](./accessibility.md),
  _font scaling_).

- **A new type-scale token** — the bar is high, and it is not "this size repeats".
  Tailwind's `--text-*` names a size, but what usually has to hold is a size
  **paired** with a leading, and a role that shares a number with a different
  role is not the same token. `0.9375rem` (15px) is the worked example: it is
  the marketing site's prose step at `leading-7`, the brand wordmark at
  `leading-none`, and the page specimen at `leading-snug` — one number, three
  roles. Only the first is a token
  (`--text-body` + `--text-body--line-height`, in
  `apps/bracemark-site/src/app/globals.css`), because only it repeats inside one
  stylesheet, in one role, ~24 times. The wordmark is deliberately **not** one —
  its invariant is a ratio to the mark's `h-4`, and a token would make the
  one-line edit that breaks the ratio look safe
  ([brand-assets.md](./brand-assets.md), _the lockup_); the specimen is three
  call sites across three apps, held by comments that name each other.
  Site-local tokens go in the site's own sheet, never `web-ui`'s — a token the
  app never uses does not belong in the app's sheet. On the expo side a
  `--text-*` token also needs the Uniwind check above; it does **not** need a
  line in `tools/prettier/expo-tailwind.css`, which `@import`s `global.css` and
  therefore already sees anything declared in a plain `@theme` block (the shim
  exists only for the `@variant`-nested `--color-*` names).
- **A quick toggle** (e.g. a menu button, not the settings picker) — write through
  `useSettingMutations` to the active source; don't reintroduce a writer on the
  provider. Read the preference from `useSettings()`, or the rendered light/dark
  from `useTheme().effectiveTheme`.
