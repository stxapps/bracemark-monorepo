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
    is parked on that frame's top edge (the iOS lift, Android's
    `KeyboardAvoidingView`; [soft-keyboard.md](./soft-keyboard.md)). Adding
    `insets.bottom` on top of that is not clearance but ~34pt of empty
    background between the Save button and the keyboard, at the one moment the
    sheet has the least height to spend — and it comes out of the pickers'
    scroller, since everything else in the panel is fixed height, so past that
    scroller's floor the panel stops shrinking and overflows. The panel
    therefore pads by `SHEET_PAD + Math.max(insets.bottom - cover, 0)`, where
    `cover` is `useShareKeyboard().cover`: the same measurement on both hosts,
    from the native module on iOS and RN's own keyboard events on Android
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
  the AdvancedSearch `Modal` it correctly supplies the status-bar inset on
  Android's full-screen modal and near-zero top inset inside iOS's pageSheet
  (`search-bar.tsx`), with no context reaching across the Modal's window
  boundary and no first-frame flash. Reach for `useSafeAreaInsets()` only when
  you need the numbers (e.g. as a prop, below).
- **An overlay panel does its own inset arithmetic, and the hook is the right
  tool there.** The add panel (`links/link-add-panel.tsx`,
  [soft-keyboard.md](./soft-keyboard.md), _the add panel_) is an absolute layer
  over the links screen, so it cannot inherit the screen's `SafeAreaView`: it
  pads its avoider by `insets.top + 8` — DialogOverlay's gutter, which is what
  keeps a maxed-out panel out of the notch — and its own bottom by
  `max(insets.bottom + keyboardHeight, 0)`, where `keyboardHeight` is the
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
