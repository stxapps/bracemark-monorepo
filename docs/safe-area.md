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
  CSS breakpoints. It is for surfaces where the **document** is what scrolls and
  the viewport is sized independently of it: bracemark-site's pages, and
  bracemark-web's `min-h-dvh` screens (sign-in, the lock gate, the sync gate, the
  404). bracemark-extension's popup scrolls its document too, but its viewport is
  sized _from_ that document, so it opts out — see the bullet after next.
- `html:has([data-no-scrollbar-gutter]) { scrollbar-gutter: auto }` — the opt-out,
  for a screen that is its own viewport-sized frame. A `h-dvh overflow-hidden`
  frame (`/links`, `/settings`) can never scroll the document, so the reserved
  gutter is dead space; and since the frame's width is `html`'s content box minus
  that gutter, the pane's own `overflow-y-auto` scrollbar lands at the frame's
  right edge with the inert gutter beyond it — reading as two scrollbars.
  **Mark only an element that sets both a viewport height and `overflow-hidden`
  on itself** — or the one exception in the next bullet. On a `min-h-dvh` surface
  it silently reinstates the layout shift, with no lint or type error. Spell the
  attribute `data-no-scrollbar-gutter=""` so no `"true"`/`"false"` string is ever
  emitted; the presence selector is correct here because the marker is static,
  never toggled from state.
- **The exception: a viewport sized to its own content — bracemark-extension's
  popup.** `entrypoints/popup/Shell.tsx` carries `data-no-scrollbar-gutter` while
  being neither `h-dvh` nor `overflow-hidden`, so it reads as a violation of the
  rule above and is not one. A toolbar popup has no viewport to be responsive to:
  Chrome sizes the window to the document, so the shell's fixed `w-90` IS the
  viewport, and a gutter reserved inside it comes off the shell rather than off a
  viewport that was going to be that wide regardless. Measured with the popup
  open at 360px: `html`'s content box is 345, and **everything painted past 345 is
  clipped** — the header's hairline, the fields' right edge, their focus ring. The
  layout is untouched (`p-4` still resolves to 16px, the inputs still measure
  16→344), so nothing in the DOM reads wrong and no test can catch it; the symptom
  is only visible in a screenshot, as a form flush to the right edge with a sliced
  focus ring. Nothing is given up in exchange, either: past 600px of content Chrome
  grows the popup to 375 and paints the real scrollbar **outside** the 360px shell,
  so the shell holds still with or without the gutter.
- **The opt-out is about `html`, not about the pane.** A frame that carries it can
  still want a stable gutter on its own inner scroll container, and four of them
  do. The utility is `scrollbar-gutter-stable` (Tailwind core since v4.2; it used
  to be written as the arbitrary property `[scrollbar-gutter:stable]`). In every
  case below it reserves a strip a scrollbar actually uses — the case the blanket
  rule is for — so it is never the dead gutter the bullet above removes.
  - `(app)/settings/layout.tsx` — its topbar and its section both render an
    `mx-auto max-w-2xl` column **inside** that container, so the gutter's width is
    part of where the shared column centres, and letting it come and go slides the
    whole column sideways between a section that scrolls and one that doesn't.
    That file is also where the topbar moved **into** the scroller, for the other
    half of the same alignment.
  - `(app)/links/_panes/sidebar.tsx` — this scroller's overflow is toggled from
    **inside** it: collapsing a section header, expanding a subtree, filtering the
    trees, locking a `hideList` list. Its rows `truncate`, so the width jump
    re-truncates label text rather than merely moving it, and the filter box is
    pinned outside the scroller and inset to those rows, so it holds still while
    they move. One edit covers the drawer too — both hosts render `SidebarBody`.
  - `(app)/links/_layouts/list-layout.tsx` and `card-layout.tsx` — here the pane's
    content width is **read by code**: the list gates its date column on an
    `@container` width, and the card grid feeds `useElementWidth` into its column
    count and from there into a wholesale `virtualizer.measure()`. A 15px flip when
    the list stops overflowing doesn't slide the pane, it re-composes it. The two
    are sibling scrollers for one pane with only ever one mounted, so they must
    carry the utility **together** or the Settings → Misc layout switch shifts the
    pane. `EmptyState` replaces the scroller outright, so the 0→N boundary is a
    full swap that no gutter setting steadies — but its SKELETON
    (`shared/layout-chrome.tsx`) carries the utility anyway, on an
    `overflow-hidden` box that can never scroll. Not to steady that boundary: the
    skeleton is a prediction of the scroller's geometry, and the card grid derives
    its column count from the content width by `auto-fill`, so a skeleton 15px
    wider than the grid it precedes can show two columns where the real grid then
    shows one. `scrollbar-gutter: stable` does reserve the strip under
    `overflow: hidden` — the gutter follows from being a scroll container, not
    from painting a scrollbar.
  - `web-ui/components/ui/command.tsx` (`CommandList`) — the same pattern in the
    surface where filtering IS the interaction. Its only two users are
    `ListCommand` and `TagsCommand`, and `max-h-72` is about nine rows, so the
    first character typed usually takes the list from overflowing to not. Rows
    `truncate`, and filtered `ListCommand` rows prepend an ancestor path, so the
    jump re-truncates text. (The `no-scrollbar` class that used to lead that class
    list was dead — defined in no stylesheet and in no Tailwind core build, so it
    emitted nothing; its position at the head of the list was the hoisting tell
    described in [theme.md](./theme.md), _the token shim the formatter needs_.)
  - `(app)/links/_components/search-bar.tsx` (`TriCheckList`) — a `max-h-32` box,
    roughly four rows, under a filter input that only appears past eight options:
    the box exists only on a checklist already scrolling, so typing reliably
    removes the scrollbar under indented, truncating list and tag names.

  **The rule of thumb these share:** reach for the utility when a scroll
  container's overflow is toggled _by input inside the same surface_ — a filter
  box, a collapse, a mode switch — and especially when its content `truncate`s, so
  the width jump changes the TEXT rather than just moving it. A scroller whose
  height only changes with the data (a dialog body, a settings pane, a Radix menu
  of fixed options) does not need it.

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

### checking any of this, and what a scrollbar actually costs

All of it turns on whether the platform's scrollbars are **classic** (they consume
layout width) or **overlay** (they float above the content and consume nothing).
Chrome and Firefox on Windows and Linux are classic. macOS is classic whenever
System Settings → Appearance → "Show scroll bars" is **Always**, and _also_ under
the default **Automatic** whenever a mouse is attached — so "a Mac" is not a
synonym for "overlay".

This workspace's own machine reads `Always` (`defaults read -g
AppleShowScrollBars`), switched over from Automatic deliberately and long ago.
That is worth knowing in both directions. It means a local measurement here is a
CLASSIC-scrollbar measurement, so don't generalise it to "macOS" — but it also
means the whole class of bug on this page is visible during ordinary development
here, on the platform that otherwise hides it. Every layout shift these rules
exist to remove can be seen locally, which is the opposite of the usual position
of having to take Windows behaviour on trust.

Measured here in **headed** Chrome, a 200px-wide `overflow-y-auto` box
(`clientWidth`):

| content   | `scrollbar-gutter` | `scrollbar-width` | width |
| --------- | ------------------ | ----------------- | ----- |
| fits      | `auto`             | `auto`            | 200   |
| overflows | `auto`             | `auto`            | 185   |
| fits      | `stable`           | `auto`            | 185   |
| overflows | `stable`           | `auto`            | 185   |
| overflows | `auto`             | `none`            | 200   |
| overflows | `stable`           | `none`            | 200   |
| fits      | `stable`           | `none`            | 200   |

Three things follow, and the last two are the ones that bite:

- The shift `stable` removes is the first two rows: **15px**, on every classic
  platform, which includes this machine.
- **`scrollbar-width: none` cancels `scrollbar-gutter: stable`.** The last two rows
  reserve nothing. Hiding wins, so the two are alternatives and never a pair —
  stacking them silently gets you the hidden scrollbar and no gutter.
- **Headless Chrome cannot answer this question.** The same page in headless
  reports 200 for the overflowing/`auto` row where headed reports 185 — it renders
  a zero-width scrollbar while still honouring `scrollbar-gutter`. Measure scrollbar
  behaviour headed (`headless: false`, see `docs/app-drivers.md`), or not at all.

**Hiding the scrollbar was considered and rejected.** Since `scrollbar-width: none`
cancels the gutter, it is the cheaper stabiliser — constant width at 0px on every
platform — so it is a real alternative to every `scrollbar-gutter-stable` above,
not a variation on one. What it costs is the only cue that a list continues below
the fold, plus the drag handle. That trade loses everywhere it was weighed here:
the links panes and the sidebar rail are primary content where scroll position is
information; `TriCheckList` shows about four of up to twenty rows and needs the cue
most; and bracemark-site's `overflow-x-auto` pricing table (a `min-w-120` table at
390px) has the scrollbar as its ONLY signal that more columns exist. The single
defensible site would be `CommandList` — a bounded, narrow, rounded floating panel
whose cmdk keyboard nav scrolls the active item into view, so ↓ discovers what the
scrollbar would have advertised — and that is exactly where a dead `no-scrollbar`
class sat for a long time (see command.tsx). It stays rejected there too: the tree
`ListCommand` renders makes position worth its 15px. There is deliberately **no
`@utility no-scrollbar`** in `styles.css`; adding one is how this decision would be
reopened, so re-read this paragraph first.

What is **not** settled here: whether Chrome reserves a `stable` gutter under true
overlay scrollbars. It cannot be measured on this machine without changing that
system setting, and `--enable-features=OverlayScrollbar` does not override it. So
the cost of `stable` for a macOS user at default settings _with no mouse attached_
is unverified — assume it may be a real 15px rather than free.

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

### the links rail: resizable and collapsible

From `md` up, bracemark-web's links rail (`(app)/links/_panes/sidebar.tsx`) is the
user's to size and to put away; below `md` it is the drawer either way. Only that
rail does this — the settings rail is eight short destinations with nothing to
truncate. bracemark-expo's docked links rail can be put away too, and stepped
between five widths rather than dragged free (_wide windows on native_, below).
The state is
device-local (`sidebar-view-store.ts` in web-react: `localStorage`, wiped by the
sign-out teardown with the collapsed ids, kept by delete-all-data like
`localSettings`); the measure and the toggles are
`(app)/links/_hooks/use-sidebar-rail.ts`.

- **Width**: 192–400px, default 240 (the old fixed `w-60`), dragged at the right
  edge or stepped from the keyboard — the edge is a focusable WAI-ARIA window
  splitter (arrows ±16, Shift ±64, Home/End, Enter collapses), double-click
  resets. A **40vw** cap rides in CSS so a width dragged on a wide window can't
  starve a narrow one's pane, and the same fraction is applied in JS while
  dragging, so the stored number is the one on screen and the one the separator
  announces.
- **Collapsed**, the rail renders **nothing**, and the frame takes its below-`md`
  shape at full width: the topbar's title opens the drawer, and a "Show sidebar"
  control ahead of it docks the rail again. Hide sits in the rail's brand row,
  where the drawer keeps its close. ⌘\ / Ctrl+\ toggles — not ⌘B, which in
  Firefox opens the browser's own bookmarks sidebar — and only where the CSS
  matched `md` (`MD_QUERY`, read at the keystroke). No icon-only mini rail: every
  user list wears the same folder.

Four things nothing would flag:

- **The state is read on the mounting render, not in an effect.** The collapsed
  ids load after mount; the rail can't — a user who collapsed it would watch it
  appear and vanish on every visit, one who narrowed it would watch the link list
  jump. The store is a `useSyncExternalStore` source whose snapshot is cached
  against the raw stored string (a fresh object per read loops forever), and
  whose writes fall back to memory when storage refuses them, since the snapshot
  _is_ the stored value and the toggle would otherwise do nothing.
- **A drag writes the rail's DOM width, not the store**, and commits once on
  release. The store re-renders the rail, and the rail is both trees; per
  pointermove that is the whole nav. A cancelled drag (`pointercancel`, lost
  capture) puts the width back and commits nothing.
- **The collapse is instant.** The pane beside the rail is a virtualized list
  whose card grid recomputes its columns from its own width (above, the
  `scrollbar-gutter-stable` panes), so a tweened rail re-composes it every frame.
- **Both toggles unmount the control that was pressed** — Hide is inside the rail
  it hides, Show only exists while the rail is gone — so focus is handed to the
  counterpart, and only when it was inside what disappeared.

### wide windows on native (bracemark-expo)

bracemark-expo runs on every window a phone, a tablet or a foldable can hand it
([expo-build.md](./expo-build.md), _devices_): an iPad full screen or in Split
View, Slide Over or Stage Manager; an Android tablet, a split-screen half, a
freeform window; a foldable folded or open; a Flip's cover screen; any phone on
its side. It does not ask which. **The layout changes at one window width, 768 —
Uniwind's `md` — and at nothing else.**

| window                                                                                              | frame                                              |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| under 768 — every phone upright, Slide Over, a narrow Split View, an iPad mini or 7" tablet upright | one pane; the links and settings rails are drawers |
| 768 and up — a tablet, an unfolded foldable, most phones on their side                              | the rails dock beside their panes (`permanent`)    |

- **The number lives once, in `src/lib/window-class.ts`** (`WIDE_MIN_WIDTH`,
  `useWideWindow()`), and it must stay `md`. Uniwind resolves a breakpoint
  against `Dimensions.get('window').width` and bakes `rem` at 16, so `md:` is
  exactly 768 there, and `useWindowDimensions()` reports the same window — split
  and freeform windows included. A JS branch on this hook and an `md:` class on
  the same screen therefore flip on the same frame. That is web's rule (_the core
  problem_, above: never re-derive a breakpoint from a measured width) in its
  native form: there is no scrollbar here to make the two widths disagree, so the
  window width _is_ what the class matched. A second number — 600, Material's
  "medium" — is how the drawer and the classes would come to disagree.
- **The rails dock by turning the same Drawer `permanent`** (`(app)/links/_layout.tsx`,
  `(app)/settings/_layout.tsx`), so the identical Sidebar component is both
  hosts, the way web renders one `SidebarBody` in a rail and a sheet. A row press
  still calls `closeDrawer`, which a permanent drawer ignores. The links rail docks
  at the width `useRailWidth()` resolves (`features/links/sidebar-rail-width.ts`,
  below); the settings rail docks at a fixed 240 (`SETTINGS_RAIL_WIDTH`,
  `(app)/settings/_layout.tsx`), web's `w-60`, and follows nothing. It used to
  follow the links rail's step so that crossing between the two moved nothing,
  which gave every settings pane the bill for a long list name, on a surface with
  no grip to undo it. Web has always taken that jump; ours is 40 at the landscape
  default. The overlay drawer keeps react-navigation's own width.
- **The links rail can be put away; the settings rail cannot** — web's split.
  Collapsed, the links Drawer goes back to `front`: the list takes the full width,
  the topbar's leading slot docks it again ("Show sidebar"), and an edge swipe
  still slides it over for a one-off pick. Hide sits in the rail's brand row,
  through `BrandLockup`'s `action` slot. The flag is device-local
  (`sidebar_view.railCollapsed`, expo-react `sidebar-view-store.ts`, wiped by the
  sign-out teardown with the collapse ids) and is read on the **mounting render**
  in `features/links/sidebar-rail.tsx` for web's reason. Each toggle unmounts the
  button that was pressed, so accessibility focus is handed to its counterpart as
  it mounts.
- **The links rail steps between five widths; it is not dragged free.** Web's
  splitter is found by hover and dragged by a pointer; a touch screen has
  neither the hover nor the precision, and the rail's width feeds the card
  grid's column count, so a free drag would re-compose it per frame. So the rail
  docks at 240, 280, 320, 360 or 400 (`RAIL_STEPS`,
  `features/links/sidebar-rail-width.ts`), and its right edge carries a grip
  (`RailWidthHandle`, `features/links/sidebar-rail.tsx`) whose drag **snaps** — the rail jumps as
  the finger crosses a midpoint, re-composing the grid once per snap, and
  commits on release. Past half the narrowest it collapses on release, like
  web's drag shut; a double-tap returns the default. The grip is an
  `adjustable` control, so VoiceOver and TalkBack step it with a swipe, hearing
  Narrowest … Widest rather than a point count; Hide stays the way to collapse.
  - **The grip sits across the rail's edge, over the Drawer, not in it.** 48
    wide, 24 each side, its pill centred on the hairline, and drawn as a sibling of
    the `Drawer` in `(app)/links/_layout.tsx`, inside `SheetCovered` so a sheet
    still covers it. Android gives a child of the rail no touch past the rail's
    edge, and the drawer library clips the rail's view there
    (`removeClippedSubviews`), so inside it the touch area stopped at the edge
    with the pill flush against it, and a finger aimed at the pill often missed.
    `hitSlop` can't cross that edge either; inward it would only cover the rows'
    "Lock list" buttons. The pill answers on touch-down, because a press that
    shows nothing reads as a press that missed, and from the View's own touch
    events: on iOS a pan that never activated does not finalize, so a pill lit
    through the gesture stays lit after a plain press. Its cost: a tap in the
    first 24 of a link row, at the grip's height, goes to the grip.
  - **Why 40 apart, and why five.** The grip is dragged until the rail looks
    right, not picked from a list, so a finer grid costs nothing — one grid
    re-composition per snap — and 40 is still a change the eye takes in at each.
    240 is web's default (the floor: touch rows, a 32pt lock button on each),
    280 the width the rail was fixed at.
  - **Why it stops at 400**, not 480: it is web's ceiling, for web's reason (a
    wider rail stops buying label and starts costing the list), and the 13"
    iPad on its side (1366) keeps three card columns only while the rail is at
    most 402. Most landscape iPads couldn't reach 480 anyway — the 11" (1180)
    is limited to 472 below. A name longer than ~40 characters is what holding
    the row is for (below), not a wider rail.
  - **One width per window SHAPE** (`sidebar_view.railWidths`, `portrait` and
    `landscape`, in points), and the shape is the window's (`width >= height`),
    not the device's orientation: Split View, Stage Manager and freeform windows
    hand a landscape iPad an upright window (a ⅔ split is 981×1024), and the
    window is what the rail shares. Defaults: 240 upright, 280 landscape — on
    the upright 11" (820) only 240 leaves the link rows the 576 their date
    column needs (`link-row.tsx`).
  - **A width is snapped and limited on read, never rewritten.** What is stored
    is validated as a positive number and nothing more (expo-react's store);
    `resolveRailWidth` snaps it to the grid — a width stored before the grid
    moved lands on the nearest step — then limits it to 40% of the window, web's
    `max-w-[40vw]`: 768 tops out at 280, the upright 11" iPads (820, 834) at
    320, the 13" upright and every landscape iPad at 400. A width the window
    can't give resolves down and is **not** written back, so it returns on a
    wider window; a drag let go where it began writes nothing for the same
    reason. At the 768 threshold the list keeps at least 488 whatever is stored.
  - **No auto-fit to the names**: a rename synced from another device would move
    the rail and re-compose the grid under the user, and one long name would pin
    it wide for good.
  - **`features/links/sidebar-rail-width.ts` is its own file, not part of
    `window-class.ts`,** because it reads the expo-react store and `window-class.ts` is on the iOS
    share extension's import path (`share-kit.tsx`), which must not reach the
    expo-react barrel ([share-sheet.md](./share-sheet.md)). Nothing lints a
    transitive import: the share fence only sees the file that writes it.
  - **A truncated row is read by holding it**: a long-press shows the full name,
    and a nested row's path, in a bubble (`components/ui/peek.tsx`) that goes
    when the finger lifts. Rows stay one line — mixed one- and two-line rows break
    the rhythm a tree is scanned by — and never scroll sideways.
- **No shortcut.** ⌘\ needs a hardware keyboard; both buttons are reachable by
  Full Keyboard Access instead.

Eight things nothing would flag:

- **The card grid's width is computed, not measured, so the rail has to be
  subtracted by hand** (`features/links/main.tsx`). And it replaces the LEFT
  safe-area inset rather than adding to it: docked, the screen starts the rail's
  width in, past any notch, so its own `SafeAreaView` measures a left inset of 0
  — the rail's `SafeAreaView` paid it out of the rail's own width.
  `useSafeAreaInsets()` is the window's and would still report 59 on a notched
  iPhone on its side. Forget the rail and the grid lays out columns for a pane
  240–400 wider than it has, every card under `MIN_CARD_WIDTH`; subtract the
  window's left inset as well and a column drops up to 59 early, with the tag
  strip's budget short by the same. And subtract `useSidebarRail().width` — the
  step this window resolved, or the one a drag is over — never a constant: a
  fixed 280 lays out the wrong grid beside every other step. No test runs
  on a device at these widths; the cards just look wrong.
- **A permanent drawer brings its own edge.** react-navigation draws a hairline
  `borderRight` on a `permanent` drawer in the navigation theme's `colors.border`
  — the stock light grey, since `src/app/_layout.tsx` overrides only
  `background`. The Sidebars already draw `border-r border-border` in the token,
  so both layouts pass `borderRightWidth: 0`; drop it and dark mode gets two
  edges, one of them light.
- **A `sm:`/`md:` step on a CONTROL'S HEIGHT is a touch-target shrink, and there
  are none left.** The registry's `h-10 sm:h-9` (Button's whole scale, Input,
  DropdownMenu rows) answered a web question — a mouse past 640px — and on this
  app 640 is a tablet or a phone on its side, all touch. They went with the
  tablet layout (`ui/input.tsx`'s header carries the argument). Layout steps
  stay (`md:px-6` in settings, the `sm:` row in `sync-paused-notice.tsx`).
  `testing/line-budget.ts` skips breakpoint classes on exactly this premise:
  reintroduce a height, a vertical padding or a `text-*` under a breakpoint and
  the fit check silently becomes phone-only. (`ui/textarea.tsx` records the
  tailwind-merge trap that came with it — a cancel has to be spelled at the same
  variant scope as what it cancels.)
- **Android recreates an activity for an undeclared config change**, and a fold,
  a split-screen drag or a move to another display changes `smallestScreenSize`.
  `plugins/with-android-manifest-policy.js` adds it to `MainActivity`'s
  `configChanges`; without it the window resize is not a `Dimensions` event but a
  remount, and the open screen and a half-typed link go with it.
- **A full-window modal on a tablet is the full window — which is why no form
  uses one.** The add panel, the link editor and Advanced Search are all the
  app's in-app sheet (`Sheet`, `components/ui/sheet.tsx`): a bottom sheet below 768, capped
  at `max-w-xl` and centred, with side borders from `sm` or wherever a side
  inset detaches it from the edge; from 768 a centred `max-w-lg` card, because
  on an iPad the keyboard's top edge a sheet would rest on is not reliably where
  the keyboard is ([soft-keyboard.md](./soft-keyboard.md), _the add panel's two
  shapes_). The editor and Advanced Search used to be an iOS `pageSheet`
  (full-screen on Android) — 820pt wide upright on an iPad (A16), the whole
  screen, and 936 on its side, floating its footer off the keys where nothing
  could measure it ([soft-keyboard.md](./soft-keyboard.md), _the in-app
  sheet_).
- **⚠ An overlay drawn in the links SCREEN stops at the docked rail.** On a wide
  window the screen is the pane beside the permanent Drawer, so an
  `absolute inset-0` layer inside it dims the list and leaves the rail bright
  and tappable. On a phone the screen is the window, so it passes everywhere it
  is tested. The sheets' host is mounted around the Drawer for this reason
  (`SheetHost`, `components/ui/sheet.tsx`). The portaled dialogs never had the
  problem: they land in the root PortalHost.
- **Insets are per edge, and a side inset is not always a landscape notch.**
  The iPhone Duo's outer display reserves a strip down its trailing edge for
  the status bar and camera, at PHONE width, upright
  ([expo-build.md](./expo-build.md), _devices_). Anything that pads by
  `insets.top` and `insets.bottom` only, or mirrors one side onto the other
  (`width - insets.left * 2`), puts content in it. The screens' `SafeAreaView`s
  and DialogOverlay were already per edge; the sheet's sides were not, and
  now are; `main.tsx`'s column math subtracts each side separately.
- **The app is not always the whole screen** — a Split View or Slide Over
  window, an Android split-screen half, the Duo's centred compatibility window.
  Anything that measures against `Dimensions.get('screen')` is measuring the
  wrong box there. The dropdown menus did, through @rn-primitives, and are
  corrected in `ui/dropdown-menu.tsx` (_safe area on native_, below).

**Not yet verified on a device.** This shape was written and checked on a desk
— typecheck, lint, the unit specs, and an `expo prebuild` read back for both
platforms — but not run on an iPad simulator, a tablet AVD or a foldable. The e2e
suite now has a wide leg for it — `e2e:ios:ipad`, `e2e:android:tablet` and their
visual twins, with cases for the docked rails, the dialogs, the backdrop over
the rail and an Android resize across 768 ([e2e.md](./e2e.md), _narrow and
wide_). Its first device runs, 2026-10-23, held all of those — the resize on
the tablet AVD, the rest on it on its side and on the iPad (A16) upright; the
reds on the way were the harness
(e2e.md, _what the first wide runs found_). What they do not cover is below. Before a release: run
each on an iPad (full screen, both Split View widths, rotation across 768), a
tablet AVD, and a foldable AVD folding and
unfolding with the add panel open; and on the iPad, the iPad keyboard's floating
and split modes against the editors' sticky footers, whose lift assumes a
keyboard docked to the bottom of the window ([soft-keyboard.md](./soft-keyboard.md)).

### popups & dialogs

1. **Prefer shadcn/Radix** (`Dialog`, `Popover`, `DropdownMenu`, `Tooltip`,
   `HoverCard`). They handle portalling, focus trap, a11y, and collision/flip/shift
   via Floating UI. Keeping them out of the unsafe area is `collisionPadding`, and
   **web-ui defaults it to the insets** — `PopoverContent`, `SelectContent`,
   `DropdownMenuContent` and `DropdownMenuSubContent` all take theirs from
   `useCollisionPadding()` (`hooks/use-collision-padding.ts`), which is
   `useWindowInsets()` plus an 8px gutter. Pass your own `collisionPadding` only
   to opt out.

   This used to be written here as a rule for call sites, spelled
   `collisionPadding={insets}` — and in that form it had **zero implementations**:
   every component hardcoded a bare `8` and no caller ever overrode it. The reason
   it kept getting missed is that the rule reads as being about the TRIGGER, and
   all of ours sit inside safe-area'd chrome. It isn't: Floating UI clamps the
   CONTENT to the raw viewport, so it takes only a surface tall enough to be
   pushed against an edge, wherever it was anchored from. Hence the default.

   It bites hardest in an installed PWA — `manifest.json` says
   `"display": "standalone"`, so all four insets are live and the top one is ~59px
   on a dynamic-island device — and in landscape, where the side inset is 44–59px
   in Safari either way.

   ⚠ **The padding only works through the content's `max-h`, and a caller's
   `max-h-*` REPLACES it.** Each of those contents carries
   `max-h-(--radix-…-content-available-height)`, and tailwind-merge drops it for
   any `max-h-*` in the caller's `className` — so a caller that wants a tighter
   cap has to keep the variable inside it:
   `max-h-[min(70dvh,var(--radix-popover-content-available-height))]`, never a
   bare viewport unit. Advanced Search's popover (`links/_components/search-bar.tsx`)
   said `max-h-[70vh]`, and on iPhone Safari — where `vh` is the LARGE viewport,
   toolbars retracted — it ran ~70vh down from a trigger in the summoned search
   row and pinned its Clear/Search footer behind Safari's bottom toolbar. No
   error, no failing test; only an iPhone shows it.

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

4. **A centred dialog needs a CAP, and the arithmetic is not the obvious one.**
   `DialogContent` and `AlertDialogContent` are `fixed top-1/2 left-1/2
-translate-1/2`, and "centred, so it never reaches an unsafe edge" holds only
   while every dialog is short — which is not a property anything enforces (the
   edit dialog fills the height by design; the destroy confirmation interpolates
   an unbounded link title). Both carry `max-h-(--dialog-max-h)`, a token in
   `web-ui/styles.css`:

   ```css
   --dialog-max-h: calc(
     100dvh - 2 * max(env(safe-area-inset-top), env(safe-area-inset-bottom)) - 2rem
   );
   ```

   **Twice the LARGER inset, not top + bottom.** A transform-centred box of height
   H leaves `(100dvh − H) / 2` on _each_ side, so a cap that subtracts `top +
bottom` splits the correction evenly between two edges that aren't — 59 against
   34 on an iPhone, where the even split leaves 62px of top clearance against the
   75px it needs. `link-edit-dialog.tsx` used to spell its own
   `max-h-[calc(100dvh-2rem)]` and was wrong by exactly this.

   It is a **token, not a `@utility`**, so the components can write
   `max-h-(--dialog-max-h)`: tailwind-merge parses that as an ordinary `max-h`
   utility and de-dupes it against a caller's own `max-h-*`, where a custom
   utility name would be opaque to it and the two would fight by stylesheet order
   (the `safe-area` + `p-4` hazard above).

   **The cap deliberately ships without an `overflow-y-auto`**, and a growable
   caller owns its own scroller instead — the same contract as expo, where the
   cap is `max-h-full` and the caller pairs it with `shrink`. It can't be
   defaulted: the `-translate-*` makes `DialogContent` the containing block for
   `position: fixed` descendants, and Radix's Popper defaults to
   `strategy: 'fixed'`, so an `overflow` on _that_ box (unlike one on any div
   inside it, which is below the containing block and clips nothing) would newly
   clip the non-portalled popovers `ListSelect` and `TagsField` open inside the
   edit dialog.

   **A scroller under the cap needs `flex flex-col` on the content**, overriding
   the base `grid`. Measured in Chrome: a grid's `auto` rows are sized from their
   content and give none of it back when the container hits a max-height, so the
   box just overflows and the cap changes nothing. Flex items shrink by default,
   and a child whose `overflow` isn't `visible` has its automatic minimum size
   resolved to 0, so the scroller absorbs the squeeze. `flex-1` where the region
   should also FILL (`link-edit-dialog.tsx`), `shrink` where it should stay
   content-sized until it has to give (`link-destroy-confirm.tsx`,
   `bulk-tags-dialog.tsx`).

   `CommandDialog` is the exception and overrides both halves: it hangs from a
   fixed `top-[33.3333dvh]` rather than centring, so all its slack is below it
   and its cap is `calc(66.6667dvh - var(--env-safe-area-inset-bottom) - 1rem)`,
   with `grid-rows-[minmax(0,1fr)]` to let the row shrink at all. (`top-1/3`
   became `top-[33.3333dvh]` in the same change: a percentage on a `fixed` box
   resolves against the initial containing block — the LARGE viewport — while the
   cap subtracted from is `dvh`, and two references for two halves of one sum is
   how a box ends up taller than the room it was measured for.) It has no caller
   in the workspace today; `ListCommand` and `TagsCommand` render `Command` bare
   inside a `Popover` or a `Sheet`.

   **The WIDTH cap is one `min()`, and a breakpoint pair is the wrong shape for
   it.** shadcn ships `max-w-[calc(100%-2rem)]` capped by a `sm:max-w-*`, which
   reads like "gutter on a phone, cap on a desktop" and is non-monotonic in the
   band between the two: below `sm` only the gutter rule applies, and 40rem of
   viewport minus 2rem is 38rem — _wider_ than the 28rem the dialog is capped to
   the moment `sm` engages. Dragging a window down through 640px made every
   dialog jump ~160px **wider as the window got narrower**, then hold that width
   down to ~480px. `DialogContent` states both constraints at once instead:

   ```
   max-w-[min(var(--dialog-max-w,28rem),calc(100%-2rem))]
   ```

   Never wider than the cap, never closer than 1rem to either edge, falling
   monotonically, with no breakpoint involved — the same reasoning as the height
   cap one paragraph up, where a centred box also can't be left to a viewport
   query.

   `--dialog-max-w` is the caller's knob for a narrower dialog
   (`[--dialog-max-w:24rem]` on the paywall and `lock-password-dialog.tsx`), and
   unlike `--dialog-max-h` it is **not** declared in `:root`: the default belongs
   to the component and no page would set it globally. Spelling it as an
   arbitrary _property_ also keeps it invisible to tailwind-merge, which is the
   point — a caller's `sm:max-w-sm` merges as a different key from an unprefixed
   base, so it would apply only above 640px and leave the narrow dialogs
   uncapped across exactly the band this fixes. Three other callers used to spell
   `sm:max-w-md`, which was the base's own default repeated; a width override
   that matches the default is always a no-op worth deleting.

   `AlertDialogContent` sizes by a `data-[size=…]` variant instead and had the
   OTHER half of the same bug: no gutter rule at all, so `max-w-xs` ran it edge
   to edge at a 320px viewport — the cap and the viewport being the same 20rem.
   Both of its caps now carry the `min(…, calc(100%-2rem))`, spelled per size
   rather than through `--dialog-max-w`, because those two values belong to the
   `size` variant and a token set by a variant would fight a caller's own
   `[--dialog-max-w:…]` by source order instead of losing to it cleanly. Its
   `sm:` step is **not** the non-monotonic pair above — it widens 20rem → 28rem
   as the viewport GROWS, in step with the layout switch its header, footer,
   title and media slots all make at that breakpoint for `size=default` — so it
   stays a breakpoint and only the gutter was added. Measured: the only viewport
   whose width moves at all is 320px, from 320 to 288.

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

- **Provider: already there for the router tree — don't add one.** expo-router's
  NavigationContainer mounts react-navigation's `SafeAreaProviderCompat`, so
  screens can use `SafeAreaView`/`useSafeAreaInsets` with **no explicit
  `SafeAreaProvider` in `_layout.tsx`** (see its header comment).
- **EVERYTHING needs the provider, `SafeAreaView` included — and this file said
  otherwise for as long as it took to ship the bug.** It claimed
  "`SafeAreaView` is a native view that measures its OWN insets and reads no
  context; only `useSafeAreaInsets` needs the provider". That was true of
  react-native-safe-area-context v3; it has not been true since v5, which this
  workspace is on. `RNCSafeAreaView` walks `reactSuperview` for an
  `RNCSafeAreaProvider` (`findNearestProvider`) and, finding none, returns out
  of `invalidateSafeAreaInsets` before it reaches `updateLocalData` — so the
  view lays out with **zero insets, silently**. No error, no warning, no
  failing test; the only symptom is content sitting under the hardware.
  - The one tree outside the router's provider is the share sheet
    (`features/share/share-kit.tsx`), and it was written against the old rule:
    a bare `<SafeAreaView edges={{ bottom: 'additive' }}>` with no provider
    above it, which did nothing at all. The Save button sat inside the home
    indicator's own swipe region — the exact defect that `edges` had been added
    to fix, re-introduced by the fix itself. The sheet now mounts its **own
    `SafeAreaProvider`** and reads `useSafeAreaInsets()` into the panel's
    `paddingBottom` **and** its `marginTop`. This said "bottom only — neither
    host ever reaches the notch" and that was wrong: the panel is bottom-anchored
    but it is also `shrink` inside a `flex-1 justify-end` frame, so the frame is
    a ceiling rather than a gap, and a picker's ~484pt of content against ~407pt
    of frame (short phone, keyboard up) fills it — rounded top at `y=0`, header
    under the status bar. The margin is `insets.top + SHEET_GAP`, which bounds
    the panel by subtraction and leaves the same strip of backdrop on both hosts
    ([share-sheet.md](./share-sheet.md)).
  - **That provider needs `initialMetrics`**, and the share sheet is the one
    place in this repo where the usual fallback does not exist.
    `SafeAreaProvider` renders **nothing** until its first `onInsetsChange`, and
    the module's `initialWindowMetrics` constant is derived from
    `RCTKeyWindow()` — i.e. `UIApplication.shared`, which an app-extension
    process does not have ([share-sheet.md](./share-sheet.md)), so it is null
    there. Seeding zero insets keeps the first frame painting and lets the real
    measurement land a frame later, which can only move content to safety.
  - **The keyboard cancels that inset while it is up**, on both hosts. A
    keyboard's frame runs to the **bottom** of the screen — it _contains_ the
    home indicator / gesture bar rather than stopping above it — and the panel
    is parked on that frame's top edge (the frame's own bottom padding;
    [soft-keyboard.md](./soft-keyboard.md)). Adding
    `insets.bottom` on top of that is not clearance but ~34pt of empty
    background between the Save button and the keyboard, at the one moment the
    sheet has the least height to spend — and it comes out of the pickers'
    scroller, since everything else in the panel is fixed height, so past that
    scroller's floor the panel stops shrinking and overflows. The panel
    therefore pads by `SHEET_PAD + Math.max(insets.bottom - lift, 0)`, where
    `lift` is `useShareKeyboard()`: how much of the frame the keyboard covers,
    the same number the frame pads its own bottom by, from the native module on
    iOS and RN's own keyboard events on Android
    (`features/share/share-keyboard.ts`). Nothing catches getting this wrong —
    it reads as dead space, not as a broken layout, until the screen is small
    enough that it is both.
  - **A correct inset still lands nowhere if the view it insets is off the
    screen**, and on the iOS sheet it was: `expo-share-extension` sized the RN
    root to `UIScreen.main.bounds` inside a container the share presentation had
    placed 72pt down, so the panel bottom-anchored itself to an edge 72pt below
    the display. `useSafeAreaInsets()` reported a clean 34 throughout — that is
    what `UIView.safeAreaInsets` says for such a view — and the Save button had
    its full clearance, all of it off-screen. Fixed in native, by
    `plugins/with-share-extension-root-view.js`; the point to carry away is that
    the inset hook answers for the view it is in, and says nothing about where
    that view is. → [share-sheet.md](./share-sheet.md), _the host view is
    full-screen_.
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
  a `Modal` (AdvancedSearch was one) it supplied the status-bar inset on
  Android's full-screen modal and a near-zero top inset inside iOS's pageSheet,
  with no context reaching across the Modal's window boundary and no
  first-frame flash. Reach for `useSafeAreaInsets()` only when
  you need the numbers (e.g. as a prop, below).
- **An overlay panel does its own inset arithmetic, and the hook is the right
  tool there.** The in-app sheet (`components/ui/sheet.tsx`,
  [soft-keyboard.md](./soft-keyboard.md), _the in-app sheet_) is an absolute layer
  over the links section (rail and screen, its `SheetHost`), so it cannot
  inherit the screen's `SafeAreaView`: it pads its avoider by
  `insets.top + 8` — DialogOverlay's gutter, which is what
  keeps a maxed-out panel out of the notch — and by the bare `insets.left` /
  `insets.right` on the sides (no gutter: it is an edge-attached sheet, so a
  side with no inset still meets the screen's edge; the wide card is detached,
  so it takes `inset + 8` there), and the bottom by
  `max(insets.bottom + keyboardHeight, 0)` — inside the sheet's own fill, or
  plus 8 as the gutter under the card — where `keyboardHeight` is the
  UI-thread shared value from `useReanimatedKeyboardAnimation` (0 while closed,
  negative while opening). That is the share sheet's formula, so the
  home-indicator clearance disappears in sync with the keyboard whose frame
  already contains it; `useKeyboardState` is deliberately not used because its
  `keyboardDidShow`/`keyboardDidHide` React updates arrive after the avoidance
  movement. Two traps come with that shape and both are in
  soft-keyboard.md: `absolute inset-0` resolves against the parent's PADDING
  box, so the backdrop has to be a sibling of the padded avoider rather than a
  child; and the avoider needs `pointerEvents="box-none"` or it eats the taps
  the backdrop is there to receive.
- **Portaled content does NOT inherit screen insets.** `Dialog`/`AlertDialog`/
  `DropdownMenu` content portals to the root `PortalHost` (wrapped in
  react-native-screens' `FullWindowOverlay` on iOS) — outside every screen's
  `SafeAreaView`. It's safe by different means:
  - **Centered dialogs** (`ui/dialog.tsx`, `ui/alert-dialog.tsx`): the overlay
    is `absoluteFill` + centered with padding. "Centered, so it never reaches an
    unsafe edge" held only while every dialog was short: `DialogContent` may now
    fill the height it has (`max-h-full`, next section), and a maxed-out box put
    its title under the dynamic island. So `DialogOverlay` applies
    `useSafeAreaInsets()` + 8 as its gutter on native — the hand-rolled rule
    below, not an inheritance. Insets are half the story — the keyboard is the
    other half, and a portaled dialog inherits no more from the screen's
    `KeyboardAwareScrollView` than from its `SafeAreaView`.

    **`ui/alert-dialog.tsx` now carries the same pair**, and the reasoning that
    exempted it was wrong. It said an alert dialog "has no input and no growable
    body, so it can neither fill the height nor summon a keyboard" — the keyboard
    half still holds (there is no `KeyboardAvoidingView` there, and `max-h-full`
    therefore resolves against the overlay directly rather than against an
    avoider inside it), but the body half does not: `link-destroy-confirm.tsx`
    interpolates a link TITLE into its description, which is unbounded, and RN
    text scales with the OS font setting while Uniwind's baked-rem padding does
    not. So it gets the gutter, `max-h-full`, and — in that one caller — the
    `shrink` scroller the cap needs, around the whole `AlertDialogHeader` so the
    `gap-1.5` binding a title to its description doesn't cross the boundary and
    re-space at the content's `gap-6`. The footer stays outside it, pinned.
    Generalise from this rather than from the old exemption: what decides is
    whether the body has a BOUND, not whether the component is called "alert".

    **The WIDTH cap on both is unprefixed `max-w-lg`, not the stock
    `sm:max-w-lg`.** Because the gutter here is structural — the overlay pads by
    `inset + 8` on every edge — the cap has no gutter rule to trade against, so
    gating it on a breakpoint bought nothing and only made the width
    non-monotonic in the same shape as web's (_a centred dialog needs a CAP_,
    above): a 600dp tablet, the common 7" portrait, sat below `sm` and got the
    full 584, while a 640dp one got 512. This is the one place the two platforms
    need different spellings for one behaviour — web's Radix content is centred
    by transform with no padded parent to inherit a gutter from, so it has to
    say `min(cap, calc(100%-2rem))` where this side just says the cap.
    `AlertDialogContent` deliberately keeps no `w-full`, so it stays
    content-sized inside the overlay's `items-center` and a one-line
    confirmation hugs its text; `DialogContent` fills.

  - **Anchored menus** (`ui/dropdown-menu.tsx`): @rn-primitives positions
    against the measured trigger with `avoidCollisions` (default on); its
    `insets` prop is the extra collision padding — the native analogue of
    Radix's `collisionPadding` (rule 1 in _popups & dialogs_ above).
    `DropdownMenuContent` **defaults it** to `useSafeAreaInsets()` + 8, matching
    both DialogOverlay's gutter and web's default; a caller may override, and
    `insets={{}}` opts out. The trigger is measured ONCE, in the press, so
    anything that moves it while the menu is open strands the menu — which is
    why `DropdownMenuTrigger`, finding a keyboard up behind it, drops it and
    takes the measurement again once it is down
    ([soft-keyboard.md](./soft-keyboard.md), _dismissal_).

    It used to pass nothing, on the reasoning that "current triggers all sit
    inside safe-area'd chrome". That reasoning is about the TRIGGER and the
    clamp is about the CONTENT: `getSidePosition` places a menu that doesn't fit
    below its trigger at `dimensions.height - insets.bottom - contentHeight`,
    against `Dimensions.get('screen')` — the PHYSICAL screen, not the app
    window — with `insets.bottom` defaulting to 0. So the menu bottoms out flush
    with the hardware edge however safely its trigger sits. Two did it every
    time: the bulk-edit bar's ⋯ (`features/links/bulk-edit-bar.tsx`), whose bar
    is anchored to the bottom of the screen so the clamp always fires, and the
    last visible row's ⋯ (`features/links/link-row-menu.tsx`) — both putting
    their final item inside the home indicator's own swipe region.

    **And the screen is the wrong BOX whenever the app is not the whole screen.**
    The menu is placed in the app's own coordinates — the trigger measured
    against the root view, the content drawn in it — while every clamp in the
    library is `dimensions.width - insets.right` or `dimensions.height -
insets.bottom` against that physical screen. In iPad Split View, Slide Over
    and Stage Manager, Android split-screen and freeform windows, and the
    centred window an iPhone Duo gives an app built with an older iOS SDK
    ([expo-build.md](./expo-build.md), _devices_), the screen is larger than the
    app, so a menu near the app's right or bottom edge "fits" and is drawn past
    it. `DropdownMenuContent` adds the overhang — screen minus
    `useSafeAreaFrame()`, the provider's frame — to the right and bottom insets,
    a caller's `{}` included, which puts the clamp exactly on the app's edge and
    adds 0 when the app fills the screen. `ui/dropdown-menu.spec.tsx` pins both.

  - **Hand-rolled absolute positioning** (a future toast, a bottom bar in an
    overlay): nothing inherits — apply `useSafeAreaInsets()` offsets yourself,
    the native mirror of web's hand-rolled rule 2.
- **An `absolute` child of a `SafeAreaView` escapes its inset**, and this is a
  second, separate trap from the portal one above — it needs no portal at all.
  `SafeAreaView` insets by PADDING, and an absolutely-positioned box is laid out
  against the padding BOX: in CSS that is the definition of its containing
  block, and RN's Yoga agrees — `AbsoluteLayout.cpp` adds only
  `computeInlineStartBorder` when an inset is defined, so `bottom: 16` under a
  `SafeAreaView` measures 16 from the hardware edge, not from the safe one.
  (Padding enters only on the static-position path, where a child has no insets
  at all, and even there it is gated by the `AbsolutePositionWithoutInsetsExcludesPadding` errata.) Nothing in the app trips this today: every `absolute` box we have —
  `add-link-fab.tsx`, `shared.tsx`'s RefreshPill — hangs off a normal flex child
  one level in, whose own border box already sits inside the padding. Keep it
  that way; an `absolute` element placed DIRECTLY under a `SafeAreaView` is the
  shape to catch in review, and it has no symptom until a notched device.

### the keyboard is next door

The soft keyboard used to live here, because on web it genuinely is a viewport
concern — `visualViewport` shrinks under it, which is the same measurement this
document is about. On native it is not: the keyboard **overlays** the window on
both platforms, so content has to move itself, and the answer has grown its own
mechanisms, its own defaults and its own silent traps.

All of it — avoidance (which container lifts, and by how much) **and** dismissal
(how the user gets the keyboard back off the screen) — is now
[soft-keyboard.md](./soft-keyboard.md). The web half stays here: `visualViewport`
under _what's provided_, and the keyboard-lifted bottom `Sheet` under _popups &
dialogs_.
