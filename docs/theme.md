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
  [expo-native-deps.md](./expo-native-deps.md) —
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
  substitutions from web:

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
    screen (`expo-splash-screen`, already wired) covers startup, and Uniwind's own
    startup default is `system` — which matches `DEFAULT_THEME`, so first paint is
    consistent with the default exactly like web's cold-load fallback. If a
    pinned-theme cold flash ever needs eliminating, the native lever is a real gate
    (hold the splash until the settings live read first resolves), not a cache.

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
inline` block already declares every `--color-*`, which is why the churn was
expo-only.

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
  so `tools/prettier/expo-tailwind.css` needs nothing (it shims names).
- **A new wash darker than 0.97 re-opens the question.** Check it against
  `--muted-foreground` before adding it; icons are the easier case (WCAG 1.4.11
  asks 3:1 of a meaningful glyph, which muted clears on every surface we have).
- **Check dark pairings with APCA, not a WCAG ratio.** Any new light-on-dark text
  colour — a tone on a coloured surface, a disabled state, a placeholder — will
  pass the ratio long before it is comfortable to read.

Contrast is not otherwise linted anywhere. `hover:text-foreground` on the `ghost`
button is why ghost triggers are exempt in their hovered state — they leave the
muted colour exactly when they land on the wash.

### extending

- **A new mode** — add it to `THEME_MODES` (`theme/theme.ts`), handle it in
  `resolveTheme` (and `msUntilNextThemeSwitch` if it's time-based), mirror the
  branch in `themeInitScript`'s ES5 IIFE (web FOUC only), and add a radio in both
  apps' `misc-section.tsx`. `coerceThemeState` accepts any value in `THEME_MODES`
  automatically. bracemark-expo's `ThemeProvider` needs no change for a normal
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
- **A quick toggle** (e.g. a menu button, not the settings picker) — write through
  `useSettingMutations` to the active source; don't reintroduce a writer on the
  provider. Read the preference from `useSettings()`, or the rendered light/dark
  from `useTheme().effectiveTheme`.
