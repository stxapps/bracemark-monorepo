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
  same tab shape as web. Only the **read/apply half** differs, because RN has no
  DOM class and no pre-paint `<script>`. The `ThemeProvider`
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
  the router tree — a separate process on iOS — and deliberately carries **no
  `ThemeProvider`**: it follows Uniwind's default (system) appearance, so it needs
  zero theme code (the token sets come free from its own `global.css` import).
  Wiring sqlite + settings decryption to honor a device-pinned theme for a
  transient sheet isn't worth it.

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
- **A quick toggle** (e.g. a menu button, not the settings picker) — write through
  `useSettingMutations` to the active source; don't reintroduce a writer on the
  provider. Read the preference from `useSettings()`, or the rendered light/dark
  from `useTheme().effectiveTheme`.
