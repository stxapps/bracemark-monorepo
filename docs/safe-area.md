## safe area, viewport & insets

How bracemark apps deal with notches/rounded corners (safe-area insets), scrollbar
width, and viewport sizing — and the gotchas that make these disagree. The web
helpers live in `@stxapps/web-ui` (web-only); the last two sections cover the
bracemark-expo side (native safe area and the keyboard). See
[architecture.md](./architecture.md) for layering.

### the core problem: "width" is not one number

Three viewport widths exist and they disagree, by design:

| value                         | scrollbar? | safe area?                     | notes                     |
| ----------------------------- | ---------- | ------------------------------ | ------------------------- |
| CSS `@media` / Tailwind `md:` | included   | full viewport                  | what a breakpoint matches |
| `window.innerWidth`           | included   | full viewport                  | —                         |
| `documentElement.clientWidth` | excluded   | full viewport                  | layout width              |
| `visualViewport.width`        | excluded   | reflects pinch-zoom / keyboard | best for popups           |

Consequence: if you measure a width in JS and re-derive "am I at `md`?", you can
disagree with what Tailwind actually matched — by the scrollbar width. **Never
re-derive breakpoints from a measured width.** Use the same media query the CSS
uses (see `useMediaQuery` below).

### the three kinds of zoom

Three different "zooms" reach the UI through different channels. They are not
interchangeable, and only two of them are ours to handle.

| zoom                                          | how it's triggered              | what we do                                                                                          |
| --------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| **browser zoom** (Cmd/Ctrl +/−)               | full-page scale                 | nothing — browser scales `px`/`rem`/images/borders proportionally; layout never sees it             |
| **default font size** (browser/OS preference) | changes what `1rem` resolves to | author in `rem` so the UI scales as one block                                                       |
| **pinch-zoom** (touch)                        | gesture                         | enable/disable via meta viewport only; size popups against `visualViewport` so they follow the user |

**Browser zoom** needs no code. It scales rendered output uniformly and does not
change the root font size.

**Default font size** is why we author in `rem`. When the user's preferred size
grows (16px → e.g. 20px), `1rem` grows, and because Tailwind expresses spacing,
sizing, and radius in rem (not just `text-*`), the whole UI scales together and
keeps its proportions. In custom components, use `rem`; avoid hand-computed px
widths/heights/spacing.

rem-everywhere is a deliberate accessibility trade-off, **not** an absolute rule.
Some things should _not_ track the user's font preference and stay in **px** — and
Tailwind's own defaults already draw this line for you:

| scale with font size → `rem`                      | keep device-fixed → `px`                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text, padding/margin/gap, component & icon sizing | borders, `divide`, `ring`, `outline` (Tailwind defaults these to px), hairlines, 1px shadows, image intrinsic sizes, safe-area insets (`env()` returns px) |

The bug to avoid is the **half-scaled** UI: rem text inside a px-fixed container (or
vice versa) clips when the font size grows. Either let a region scale as a whole, or
keep it fixed as a whole.

**Pinch-zoom** can only be enabled/disabled through `<meta name="viewport">`
(`user-scalable=no`, `maximum-scale=1`) — and WebKit ignores that for accessibility,
so you can't fully suppress it on iOS. You can't react to the gesture itself, but it
_does_ move the **visual** viewport: `visualViewport.width/height` shrink and
`offsetLeft/offsetTop/scale` change. So anything sized against `useVisualViewport`
(hand-rolled popups, see below) follows the user into the zoomed region — which is
the desired behavior. `useWindowSize` (layout viewport) is unaffected by pinch-zoom,
which is exactly why breakpoint logic uses it. See the width table above
(`visualViewport.width` is the pinch-zoom-aware row) and `useWindowSize` vs
`useVisualViewport` below.

### prerequisite: `viewport-fit=cover`

`env(safe-area-inset-*)` are **all 0** unless the page opts into edge-to-edge with
`viewport-fit=cover`. In `bracemark-web` this is set in `src/app/layout.tsx`:

```ts
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', … };
```

Without it, none of the `safe-area` utilities or `useWindowInsets` do anything.

### what's provided

**CSS** (`@stxapps/web-ui/styles.css`)

- `scrollbar-gutter: stable` on `html` — reserves the scrollbar gutter so its
  width is constant; layout stops shifting and JS width math stays in sync with
  CSS breakpoints. It is for surfaces where the **document** is what scrolls:
  bracemark-site's pages, bracemark-web's `min-h-dvh` screens (sign-in, the lock
  gate, the sync gate, the 404), and bracemark-extension's popup — which has no
  inner scroll container at all, since Chrome grows the popup to its content and
  scrolls the document itself past 600px.
- `html:has([data-no-scrollbar-gutter]) { scrollbar-gutter: auto }` — the opt-out,
  for a screen that is its own viewport-sized frame. A `h-dvh overflow-hidden`
  frame (`/links`, `/settings`) can never scroll the document, so the reserved
  gutter is dead space; and since the frame's width is `html`'s content box minus
  that gutter, the pane's own `overflow-y-auto` scrollbar lands at the frame's
  right edge with the inert gutter beyond it — reading as two scrollbars.
  **Mark only an element that sets both a viewport height and `overflow-hidden`
  on itself.** On a `min-h-dvh` surface it silently reinstates the layout shift,
  with no lint or type error. Spell the attribute `data-no-scrollbar-gutter=""`
  so no `"true"`/`"false"` string is ever emitted; the presence selector is
  correct here because the marker is static, never toggled from state.
- **The opt-out is about `html`, not about the pane.** A frame that carries it can
  still want a stable gutter on its own inner scroll container, and `/settings`
  does: its topbar and its section both render an `mx-auto max-w-2xl` column
  **inside** that container, so the gutter's width is part of where the shared
  column centres, and letting it come and go slides the whole column sideways
  between a section that scrolls and one that doesn't. `[scrollbar-gutter:stable]`
  there reserves a strip a scrollbar actually uses — the case the blanket rule is
  for — so it is not the dead gutter the bullet above removes. See
  `(app)/settings/layout.tsx`, which is also where the topbar moved **into** the
  scroller for the other half of that alignment.
- `@utility safe-area` — pads all four sides with the insets.
- `@utility pt-safe / pr-safe / pb-safe / pl-safe` — per-side variants to mix with
  normal spacing.
- `@utility px-safe / py-safe` — the axis pairs, so the safe utilities cover the
  same shapes the numeric `p*-` scale does. They emit **physical** longhands
  (`padding-left`/`padding-right`), not `padding-inline`, because the insets are
  themselves physical — see the comment in `styles.css`.
- `--env-safe-area-inset-*` custom-property tokens. **Do not read these back via
  `getComputedStyle`** — several browsers (Safari included) return the literal
  `env(...)` string. Use `getWindowInsets()` instead, which measures a probe
  element's resolved padding.

Neither scrollbar-gutter rule is observable on macOS with the default overlay
scrollbars, where `scrollbar-gutter` is spec'd to have no effect. Both the layout
shift and the doubled gutter only appear with classic scrollbars — Chrome/Firefox
on Windows and Linux — so neither can be checked on a Mac at default settings.

**Utils** (`@stxapps/web-ui/lib/window`)

- `getWindowInsets(): Insets` — safe-area insets in px (probe-element based,
  SSR-safe → zeros). One-shot; not reactive.

There is deliberately **no `getScrollbarWidth()` / `useScrollbarWidth()`**, and
re-adding one is a trap. The obvious `innerWidth - documentElement.clientWidth`
does not measure the platform's scrollbar — it measures what the root scroll
container is currently reserving, which is per-route here: the same browser
answers ~15 on `/sign-in` and 0 on `/links`, because of the opt-out above. The
flip happens on a client-side navigation, which fires no `resize`, so a cached
value would be stale with no event to invalidate it. Measure the element you
actually care about with `useElementWidth` — its content box already excludes
that element's own scrollbar.

**Hooks** (`@stxapps/web-ui/hooks/use-media-query`, `…/use-window-metrics`)

- `useMediaQuery(query)` — SSR-safe `matchMedia` subscription. Pass the _same_
  string Tailwind uses, e.g. `'(min-width: 48rem)'` for `md:`. Seeds `false`
  unconditionally and corrects in an effect: a `useState` initializer runs on the
  client's **hydration** render too, so reading `matchMedia` there would make the
  first client render disagree with the server HTML for every visitor the query
  matches. Gate anything that would visibly flash behind a `mounted` flag.
- `useWindowInsets()`, `useWindowSize()`, `useVisualViewport()` — reactive,
  backed by **one shared store**: a single subscription and a single DOM read per
  event regardless of how many components call them, with per-slice reference
  stability so a component only re-renders when the value it reads changes.

`useWindowSize` vs `useVisualViewport`: the former is the **layout** viewport
(`innerWidth/innerHeight`, scrollbar included, matches CSS breakpoints, _unaffected
by zoom or the on-screen keyboard_) — use it for breakpoint-aligned logic. The
latter is the **visual** viewport (the visible region after pinch-zoom and the soft
keyboard, with `offsetLeft/offsetTop/scale`) — use it to size/position popups so
they clear the keyboard. On most mobile browsers the keyboard fires only
`visualViewport.resize`, not `window.resize`, so layout size won't even reflect it.

### applying safe area

Put the inset utility **on the element that owns the height**, never on a wrapper
around it. Padding paints _inside_ the border box (Preflight sets
`box-sizing: border-box` on everything), so `class="safe-area h-dvh"` is still
exactly one screen tall and simply hands its children a shorter content box. The
same utility on a **parent** of that `h-dvh` box instead adds to it — the document
becomes `100dvh + top + bottom` and the frame's bottom edge sits below the fold,
which on an `overflow-hidden` single-screen frame means the last row is unreachable.

That second shape is what `bracemark-web` used to have: a blanket
`<div className="safe-area">` in `inner-layout.tsx` around every route. It's gone.
Each full-height surface now carries its own:

| surface                                           | where                                                     |
| ------------------------------------------------- | --------------------------------------------------------- |
| links frame                                       | `(app)/links/page.tsx` — on the `h-dvh` frame             |
| settings frame                                    | `(app)/settings/layout.tsx` — same                        |
| sign-in / create-account, 404, the error boundary | `components/focused-page.tsx` — the outer `min-h-dvh` box |
| app lock screen                                   | `components/app-lock-gate.tsx` — its full-screen wrapper  |
| decrypting / sync-error screens                   | `components/initial-sync-gate.tsx`                        |

`(app)/layout.tsx` deliberately wraps its children in **no element at all** — it is
a parent of the first two, so insets there would reproduce the blanket bug one level
lower. It used to hold a bare `min-h-dvh` div; that constrained nothing those frames
don't already set on themselves, and an empty box at that position is an invitation
to put padding on it.

**Measure full-height surfaces in `dvh`, never `vh`.** `100vh` is the viewport with
a mobile browser's URL bar _retracted_, so a `h-screen` frame hangs its bottom edge
behind the bar — and a single-screen frame has no scroll of its own to bring it
back. Every box in the table uses `h-dvh`/`min-h-dvh`; `min-h-screen` and `h-screen`
should not reappear in `bracemark-web`.

**`svh`/`lvh` are not upgrades to `dvh`, and nothing in this workspace should use
them.** The usual argument for `svh` — that `dvh` re-resolves while the URL bar
animates, so it janks — does not reach any surface we have, because the bar only
animates when the _document_ scrolls:

- A `h-dvh overflow-hidden` frame makes the document exactly viewport-tall, so it
  never scrolls and the bar never moves. Inner panes scrolling doesn't retract it.
- A `min-h-dvh` box on a short page is the same story. On a long page the content
  already exceeds the min-height, so the unit stops deciding the height at all.

What `svh` _would_ cost is real: it resolves to the bar-visible height always, so in
the bar-retracted state the box is **shorter than the viewport**. On
`focused-page.tsx` that means a strip of `body`'s `bg-background` showing beneath the
box's `bg-muted`; on an `overflow-hidden` frame it means dead space below the shell.
`dvh` is the only unit that always ends exactly at the bottom of what the user can
see, which is the property every surface here wants.

The one case the units really do differ on is content taller than `svh` but shorter
than `lvh`: it scrolls, the bar retracts, it now fits, the bar returns, it scrolls
again. That oscillation is set by _content_ height — swapping the min-height unit
does not fix it, and reaching for `svh` because of it is a misdiagnosis.

A blanket on the surface **itself** is still the right default when that surface is
a flat background with a centred column (the auth pages, the lock screen): the
background fills edge-to-edge under the notch while the content is inset. Switch to
the narrower utilities (`pt-safe` header, `pb-safe` bottom bar, `px-safe` side
content) once a sticky bar should bleed to the edge with only its _contents_ inset —
`web-ui`'s `sheet.tsx` is the worked example. The set is `safe-area`, the four sides,
and the two axes; anything else you invent (`ps-safe`, `p-safe`) is an **undefined
utility class, which emits nothing at all rather than erroring**, so a typo here
fails silently.

**Don't stack a safe utility and a numeric one on the same _side_ of the same
element.** The conflict is per-side, and the winner is decided by declaration order
in the generated stylesheet — class order in JSX has nothing to do with it. What
each utility actually emits (Tailwind v4):

| utility                                       | declaration                                   |
| --------------------------------------------- | --------------------------------------------- |
| `safe-area`                                   | `padding-top/right/bottom/left` — 4 longhands |
| `pt-safe` / `pr-safe` / `pb-safe` / `pl-safe` | the one matching longhand                     |
| `px-safe` / `py-safe`                         | the two matching longhands                    |
| `p-4`                                         | `padding` — shorthand, all four sides         |
| `px-4`                                        | `padding-inline` → left/right                 |
| `py-4`                                        | `padding-block` → top/bottom                  |
| `pt-4`                                        | `padding-top`                                 |

Every safe utility emits physical longhands; the numeric axis ones emit logical
shorthands. That difference does **not** buy you an escape — `padding-inline`
resolves to `padding-left`/`padding-right`, so it conflicts with them and just
resolves by order like everything else. What matters is only which _sides_ overlap:
`safe-area` collides with any numeric padding utility, `px-safe` + `px-4` collide,
and `pt-safe` + `px-4` is fine while `pt-safe` + `py-4` is not.

For the blanket case the habit is simply to give `safe-area` a box with no padding
of its own and keep the numeric padding a level in; `components/focused-page.tsx`
(the auth pages, the 404 and the error boundary) and `app-lock-gate.tsx` are both
shaped that way for exactly this reason.

### the marketing site (bracemark-site)

The apex is a **scroll** site — no single-screen frame anywhere — which changes both
halves of this page. `bracemark-site` is a different property from `bracemark-web`
([architecture.md](./architecture.md#apps)); the utilities are the same because both import `web-ui`'s sheet.

**`dvh` appears exactly once**, on the sticky-footer column in
`src/app/layout.tsx`, and that is the only place a scroll site needs a viewport
unit:

```tsx
<div className={cn('bg-background text-foreground flex min-h-dvh flex-col antialiased')}>
```

The `h-dvh`-on-every-surface rule above is a **`bracemark-web` rule**. It exists
because that app has `overflow-hidden` frames whose last row is unreachable if the
box outgrows the viewport; the site has none, so viewport-locking any section there
would manufacture the problem rather than solve it. `min-h-screen`/`h-screen` are
still wrong in both apps, for the same `100vh`-behind-the-URL-bar reason.

**Every inset on the site is horizontal, plus one bottom.** Top insets are 0 in
Safari — the URL bar already covers the notch in both orientations — so what
actually bites is **landscape**, where the side inset is 44–59px against a 16px
`px-4` gutter, and the **home indicator** under the footer's last rows. The site
sets `viewportFit: 'cover'` in `layout.tsx`, so these are live; a page that opts
into edge-to-edge and then insets nothing is the worst of both, and that is what
this was before.

Every gutter on the site is a two-element sandwich — bleeding outer, numeric inner —
because `px-safe` and `px-4` can't share an element (see the collision rule above).
Two shapes, by whether the outer element has a background worth bleeding:

| shape                                                       | where                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bleeding** — outer already existed, tint reaches the edge | `site-header.tsx` (`px-safe pt-safe`), `site-footer.tsx` (`px-safe pb-safe`), the `Band` component and the three bare `<section>`s in `app/page.tsx`, `app/about/page.tsx` |
| **wrapper** — no background, the div exists only to inset   | `components/page-shell.tsx` (so every long document), `app/faq/page.tsx`, `app/pricing/page.tsx`, the hero in `app/page.tsx`                                               |

`pb-safe` sits on the `<footer>`, **not** on `<body>`: the `min-h-dvh` column is
body's child, so padding one level up adds to that column instead of insetting it —
the blanket bug again, one level higher than the `bracemark-web` version. `pt-safe`
on the sticky header does nothing in Safari and is there for standalone/PWA display,
where the top inset is real.

### breakpoints vs. insets

Left/right insets that shrink usable width are almost always 0 in portrait — they
appear mainly in landscape (side notch) or with rounded display corners. Top/bottom
insets reduce height, not width. So a layout can match `md:` yet have ~16–32px less
content width in landscape. Keep it in mind for layouts that are tight at a
breakpoint edge; if it actually breaks, size that region with a **container query**
(`@container`) so it responds to its own post-inset width, rather than fighting the
breakpoint math.

### popups & dialogs

1. **Prefer shadcn/Radix** (`Dialog`, `Popover`, `DropdownMenu`, `Tooltip`,
   `HoverCard`). They handle portalling, focus trap, a11y, and collision/flip/shift
   via Floating UI. Keep them out of the unsafe area by feeding insets:

   ```tsx
   const insets = useWindowInsets();
   <PopoverContent collisionPadding={insets} />;
   ```

2. **Hand-roll only when Radix can't express the UI** (custom anchored panel,
   coordinate-driven menu). Size against `visualViewport` (keyboard/pinch-zoom
   aware) minus insets:

   ```ts
   const vv = useVisualViewport(); // keyboard / pinch-zoom aware
   const inset = useWindowInsets();
   const availW = vv.width - inset.left - inset.right;
   const availH = vv.height - inset.top - inset.bottom;
   // position within the visible region: add vv.offsetLeft / vv.offsetTop
   ```

   (`useVisualViewport` already excludes the scrollbar and reflects zoom, so
   there is nothing further to subtract for it.)

3. **A surface pinned to the bottom edge with a focused input in it needs (2)
   even though it's a Radix component.** `position: fixed` resolves against the
   **layout** viewport, so `bottom-0` is _under_ the soft keyboard, and Radix
   can't help — Floating UI measures the same layout viewport, so an anchored
   `PopoverContent`'s `--radix-popover-content-available-height` overstates the
   room by the keyboard's height too. Lift by the occluded band and cap to what's
   visible:

   ```ts
   const vv = useVisualViewport();
   const layout = useWindowSize(); // layout viewport — keyboard-blind, on purpose
   // Skip the lift while pinch-zoomed: `scale > 1` shrinks vv the same way a
   // keyboard does and the subtraction can't tell them apart.
   const keyboardInset = Math.max(0, layout.height - vv.height - vv.offsetTop);
   // → style={{ bottom: keyboardInset, maxHeight: vv.height - gutter }}
   ```

   Live use: the links topbar's quick-add, which is an anchored popover at `md`
   and up and a keyboard-lifted bottom `Sheet` below it
   (`links/_components/link-add-surface.tsx`, [editors.md](./editors.md)).

### performance note

`useMediaQuery` is cheap to use per-component: `change` fires only at the breakpoint
boundary and does no layout work. Anything that calls `getComputedStyle` /
`getBoundingClientRect` (like `getWindowInsets`) forces a reflow, so those are
funneled through the single shared store in `use-window-metrics.ts` — one
measurement per event for the whole app. Follow the same rule for any future
"global truth" input (scroll position, etc.): hoist it into one shared
`useSyncExternalStore`, don't let every component subscribe and measure
independently.

### safe area on native (bracemark-expo)

The same notch/home-indicator problem, but the mechanics differ from web: there
is no `env()`/CSS cascade — insets come from **react-native-safe-area-context**,
and both apps' surfaces are edge-to-edge by default (iOS always was; Android
15+ enforces it), so every screen must handle them.

- **Provider: already there — don't add one.** expo-router's
  NavigationContainer mounts react-navigation's `SafeAreaProviderCompat`, so
  screens can use `SafeAreaView`/`useSafeAreaInsets` with **no explicit
  `SafeAreaProvider` in `_layout.tsx`** (see its header comment). The one tree
  outside any provider is the share sheet (`features/share/share-kit.tsx`), and
  it uses `SafeAreaView` anyway — **which is legal, and the distinction is worth
  knowing: `SafeAreaView` is a native view that measures its OWN insets and
  reads no context; only `useSafeAreaInsets` needs the provider.** It takes
  `edges={{ bottom: 'additive' }}` and nothing else. Bottom, because the iOS
  host view is pinned to the screen bottom and the Android panel is a bottom
  sheet, so both land under the home indicator / nav bar — the omission was
  visible as a Save button whose bottom edge sat inside the home indicator's own
  swipe region. Nothing else, because neither host ever reaches the notch.
- **Screens: `SafeAreaView` from `react-native-safe-area-context`** (never the
  deprecated RN-core one), wrapped once per file as
  `const StyledSafeAreaView = withUniwind(SafeAreaView)` so it accepts
  `className` — it's a composite component, not a core host like `View`/`Text`
  (the note in `components/landing.tsx`). The standard shape is
  `<StyledSafeAreaView className="bg-background flex-1">` around the screen:
  padding paints inside the box, so the background fills edge-to-edge under
  the notch while content is inset — the native mirror of web's per-screen
  `safe-area` (above), and per-screen for the same reason: it sits on the box
  that owns the screen's height rather than wrapping it. Same caveat too — once
  a bar should bleed to the edge with only its contents inset, switch to the
  `edges` prop / per-side inset styles.
- **Why the native `SafeAreaView` and not `useSafeAreaInsets` + padding:** it
  measures **its own** insets natively, per window and per container — inside
  the AdvancedSearch `Modal` it correctly supplies the status-bar inset on
  Android's full-screen modal and near-zero top inset inside iOS's pageSheet
  (`search-bar.tsx`), with no context reaching across the Modal's window
  boundary and no first-frame flash. Reach for `useSafeAreaInsets()` only when
  you need the numbers (e.g. as a prop, below).
- **Portaled content does NOT inherit screen insets.** `Dialog`/`AlertDialog`/
  `DropdownMenu` content portals to the root `PortalHost` (wrapped in
  react-native-screens' `FullWindowOverlay` on iOS) — outside every screen's
  `SafeAreaView`. It's safe by different means:
  - **Centered dialogs** (`ui/dialog.tsx`, `ui/alert-dialog.tsx`): the overlay
    is `absoluteFill` + centered with padding; centered content never reaches
    the unsafe edges, so no inset work.
  - **Anchored menus** (`ui/dropdown-menu.tsx`): @rn-primitives positions
    against the measured trigger with `avoidCollisions` (default on); its
    `insets` prop is the extra collision padding — the native analogue of
    Radix's `collisionPadding` (rule 1 in _popups & dialogs_ above). Current
    triggers all sit inside safe-area'd chrome, so nothing passes it yet; a
    trigger near a raw screen edge should pass
    `insets={useSafeAreaInsets()}`.
  - **Hand-rolled absolute positioning** (a future toast, a bottom bar in an
    overlay): nothing inherits — apply `useSafeAreaInsets()` offsets yourself,
    the native mirror of web's hand-rolled rule 2.

### keyboard avoidance on native (bracemark-expo)

On web the keyboard is a viewport concern (`visualViewport` shrinks — see
above). On native the keyboard **overlays** the window on both platforms —
with edge-to-edge (enforced on Android 15+) `adjustResize` no longer resizes,
so Android behaves like iOS — and content must move itself. Two mechanisms
exist, and **the presentation container decides which, not the feature**:

| surface                                                       | mechanism                                                           | examples                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| regular expo-router screen                                    | keyboard-controller `KeyboardAwareScrollView` in the screen wrapper | `auth-screen.tsx`, `settings/[section].tsx` |
| RN `Modal`                                                    | plain `KeyboardAvoidingView behavior="padding"`                     | AdvancedSearch (`links/search-bar.tsx`)     |
| share sheet (iOS extension process / Android `ShareActivity`) | plain `KeyboardAvoidingView` — keyboard-controller cannot work here | `share/share-screen.tsx` `Sheet`            |

- **The default is react-native-keyboard-controller.** Its `KeyboardProvider`
  mounts once at the root (`src/app/_layout.tsx`) and feeds
  WindowInsetsAnimation-synced keyboard values; screens consume them via
  `KeyboardAwareScrollView` (wrapped with `withUniwind` for `className`).
- **The unit of handling is the screen/scroll container, not the leaf.**
  Components rendered inside an already-keyboard-aware screen — the settings
  sections (`lists-section.tsx`, `tags-section.tsx`), future
  `ListSelect`/`TagsField` cousins — declare nothing themselves. Don't nest a
  second avoider; two stacked avoiders double the offset.
- **Why RN `Modal` opts out:** a `Modal` is its own native window. React
  context technically crosses the boundary, but the provider's native
  `KeyboardControllerView` doesn't wrap the modal's window, so its animated
  values can't drive content there. Hence plain
  `KeyboardAvoidingView behavior="padding"` inside the Modal (AdvancedSearch's
  in-file comment carries the local rationale).
- **Why the share sheet can't use it at all** (the stronger constraint):
  keyboard-controller's iOS layer is built on `UIApplication.shared`, which
  doesn't exist in an app-extension process — expo-share-extension's
  `APPLICATION_EXTENSION_API_ONLY=No` only makes such pods compile, not work.
  Even nesting a fresh `KeyboardProvider` wouldn't help. Android's
  `ShareActivity` could technically differ, but one plain KAV keeps the two
  hosts rendering the same tree (docs/share-sheet.md).
- **For a new surface, decide the presentation first; the keyboard answer
  follows.** A future link-add/link-edit built as a router screen inherits the
  keyboard-controller path for free; built as a page-sheet `Modal` (like
  AdvancedSearch), it must carry its own plain `KeyboardAvoidingView`.
