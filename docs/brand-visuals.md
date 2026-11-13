## brand visuals — the mark, the lockup, the fold, the generated pictures

The **invariants** for everything the brand draws: what the mark is, where its
copies live and why they must not drift, the one set of lockup measurements, the
two meanings the 45° fold is allowed to carry, the committed PNGs and the film
the build reads, and the store screenshots. The words — the brand lines, the
voice, terminology, what the public repo entitles us to claim, and the one
social account — are in [brand-assets.md](./brand-assets.md).

Every rule here is enforced by nothing but this file. There is no test that
compares two SVG paths, no lint rule that catches a hand-typed lockup, and no
generator that re-renders the rasters — so a change to any of them is a
multi-file change that only this page will remind you of.

Companions: [hosting.md](./hosting.md) for the origins the brand is served from,
[architecture.md](./architecture.md#apps) for what bracemark-site is, and
[share-sheet.md](./share-sheet.md) for the one surface where the lockup is all
the user has.

### the mark

A solid geometric B with its top-right corner cut away at 45°, the way a page
corner is turned down to keep a place. **The shape itself is documented at the
top of `packages/web-ui/src/components/icons/bracemark-icon.tsx`** — the
one-path/`currentColor` invariant and the 428×512 grid it is constructed on. That
comment is the source of truth for _what the shape is doing_ and is not repeated
here; this page owns the inventory and the rules that span files.

**Two source components and 29 raster assets:**

| where                                                                                                                                                                                          | what                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/web-ui/src/components/icons/bracemark-icon.tsx`                                                                                                                                      | the source of truth                                                                                                                                       |
| `apps/bracemark-expo/src/components/icons/bracemark-icon.tsx`                                                                                                                                  | the RN port — **byte-identical path and viewBox**, colour from `useCSSVariable` because `react-native-svg` takes fill as a prop and has no `currentColor` |
| `apps/bracemark-web/public/` (9), `apps/bracemark-web/src/app/` (4), `apps/bracemark-site/src/app/` (4), `apps/bracemark-expo/assets/images/` (8), `apps/bracemark-extension/public/icon/` (4) | 29 PNG/ICO files rendered from that path                                                                                                                  |

⚠ **The two components must not drift, and nothing enforces it** — no test
compares the two `d` strings. A retouch of the mark is a **two-file** change plus
a re-render of every raster.

**The raster conventions, which are a rule and not a per-file judgement:**

- **Favicons and toolbar icons** (`logo16/32/48/64`, the browser extension's
  `icon/16|32|48|128`, `icon1`/`icon2` in bracemark-web and the marketing site,
  expo `favicon.png`) — mark in `#0a0a0a` on an **opaque white tile cut tight to
  the mark**: on an N×N canvas the tile is **7N/8 wide × N tall, centred**, with
  an **N/8 radius on three corners and a 45° chamfer of N/3 on the top-right**,
  and the mark sits inside it at **ink height 7N/8**, centred, natural 428:512
  aspect. The canvas corners outside the tile stay transparent, so the tile reads
  as a dog-eared chip and not as a square.
  The chamfer is the mark's own fold repeated one level out, and it is
  deliberately **larger** than the fold it echoes — N/3 measured against the tile,
  not the mark's ~30% measured against the mark — so the two diagonals run
  parallel with a white band between them instead of collapsing into one edge.
  That band is what sets the floor: at 16px it is a single pixel, and cutting any
  deeper merges the mark's fold into the tile's, at which point the corner stops
  reading as folded and starts reading as clipped.
- **App and PWA tiles** (`logo192/512`, `*-maskable`, `apple-touch-icon`,
  `apple-icon`, expo `icon.png`/`ios-light.png`) — opaque **white** tile, mark
  `#0a0a0a`, ink height 50–55%, and **no chamfer**. These are full-bleed squares
  the platform masks to a shape of its own (a squircle, a circle, a rounded rect),
  so a corner cut here is either erased by the mask or fights it. The split is
  deliberate and it is visible — the same mark is a dog-eared chip in a tab strip
  and a plain square on a home screen — and it follows from who owns the corner: a
  browser paints our raster as we shipped it, an OS does not.
- **The expo dark and tinted variants** (`ios-dark.png`, `ios-tinted.png`) —
  transparent, near-white mark, 55%; iOS composites them over its own backdrop.
- **The two `favicon.ico`** (bracemark-web, bracemark-site) — four frames each,
  16/32/48/64, following the favicon rule above, tile and chamfer included. **All
  four frames move together.** A shape change that re-renders the PNGs and the
  largest frame leaves 16px on the old shape in every browser that picks that
  frame, and nothing about the file looks wrong — the `.ico` is one path in
  `git status` no matter how many frames inside it are stale.
- **The three expo rasters the platform composites itself** (`adaptive-icon.png`,
  `splash-icon.png`, `splash-icon-dark.png`, all 1024²) — transparent, because
  their background is set in `app.config.ts` rather than baked in: Android's
  adaptive icon sits on `#ffffff`, and the splash pair on `#ffffff` / `#0a0a0a`
  at `imageWidth: 200`, `resizeMode: 'contain'`. Editing the background is an
  `app.config.ts` change, not a re-render — and `adaptive-icon.png` is a
  **maskable** foreground, so it is bound by the 65.2% ceiling below.

Only mark rasters are counted above. The two apps' `src/app/` also hold the social
card, and `apps/bracemark-web/public/` is where the PWA screenshots (`ss-*`) go
when there are any — both governed further down under _the generated pictures_,
which exists because that sentence used to end "which are not brand assets and are
not governed here" and they stayed on the predecessor's branding for the product's
whole life.

**Maskable padding is a measured number: 65.2%.** The mark fits Android's 80%
safe circle at that ink height and no larger — a property of the 0.836 aspect
plus the corner radii. Re-measure it whenever the path changes: the number is
`0.4 × 512 ÷ R`, where `R` is the largest distance from the centre of the mark's
bounding box to its outline — currently ~314 units, on the rounded bottom-left
corner, which is the point that binds. The `-maskable` files ship at 50%,
comfortably inside it; the non-maskable tiles at 55% are **not** maskable and
must not be substituted.

There is **no committed generator** for any of this, so the rules above are the
only thing that makes the rasters reproducible. Two consequences before you
re-render: the geometry reproduces exactly, but the **antialiasing does not** — a
fresh render from the same path differs from the committed file by up to ~26%
alpha on edge pixels alone, because a different rasteriser drew it — so a
re-render is never a byte-clean diff.

Which is the argument for **editing the corner rather than re-rendering the file**
whenever a change is confined to one corner, as the chamfer was. The diff then
stays inside that corner's bounding box and every other pixel stays byte-identical
to what shipped, so the mark itself is provably untouched and the check is
mechanical: the difference of old and new must have an empty bounding box outside
the corner. A full re-render buries the same change in edge noise across the whole
raster and there is nothing left to check it against.

**The white tile is what makes that first class survive a dark browser**, and it
is why those files are no longer transparent. They are the only rasters a
_browser_ paints into its own chrome — a toolbar button, a tab strip, a bookmarks
bar — at a colour it chooses and never tells us, and `#0a0a0a` on Chrome's dark
toolbar is close to invisible. A per-theme variant was never actually available:
MV3 has no manifest-level light/dark icon switch (Firefox's `theme_icons` is
Firefox-only) and the service worker has no `matchMedia` to drive
`action.setIcon` from, so it would need an extension page or content script to
drive it — and a favicon or a PWA manifest icon has no such hook at all. One
opaque tile covers every surface in the class, in every browser, with no runtime
code; the cost is that the mark no longer floats free on light chrome.

⚠ **The class is all-tiled or all-transparent — never mixed.** Restoring
transparency on one file because it looks better in one browser puts a white chip
behind the mark in bracemark-web's tab and none behind the same mark on the
toolbar button beside it. The app and PWA tiles are a different class and keep
their full-bleed square: nothing paints _them_ onto an unknown colour.

### the lockup

Mark beside wordmark — **one set of measurements rendered on nine surfaces**: a
16px mark (`h-4`), the wordmark at
`text-[0.9375rem] leading-none font-semibold tracking-tight`, `gap-2.5` between
them.

⚠ **The leading is web-only — the native wordmark carries no `leading-*`, on
purpose.** `leading-none` computes to the same 15px line box on both platforms,
but only web and Android split its negative half-leading evenly around the
glyphs; iOS takes the whole shortfall off the ascent, so the caps sit ~2px above
the middle of their own box while `items-center` centres the two boxes to the
pixel — the name reads as if it had slipped up off the mark. So
`apps/bracemark-expo/src/components/brand-lockup.tsx` states three of the four
spellings and omits the fourth, letting Inter's own box centre the caps (it does,
exactly). This is the one measurement the two components are allowed to differ
on, and putting the class back is a silent regression: it is a valid style on a
valid tree, no test lays text out, and Android is off by half a pixel rather than
two. The mechanism is in [theme.md](./theme.md), _extending_.

⚠ **The invariant is the RATIO, and the pair is derived from it.** The mark's
height is **1.6× the wordmark's cap height**. Inter's cap height is 0.6758em, so
that is ≈1.08× the wordmark's font-size, and 15px of wordmark asks for 16.2px of
mark. The usable band is roughly 1.55–1.70×: under it the mark is swallowed by
the word, over it the mark stops reading as half of a lockup and starts reading
as an icon that happens to have text beside it — which is what the previous
20px/15px (1.97×) did, and it is why the mark looked unmoored from the word even
though the two boxes were centred to the pixel by `items-center`.

The ratio is written down because **an absolute pair cannot defend itself**. The
browser extension's popup once stepped the lockup down to 16px/13px — the mark
by ×0.80, the wordmark by ×0.867 — and nothing caught the 8% flattening, because
"20 and 15" says nothing about what the two numbers owe each other. Nothing
lints this and no test can see it.

**16px is also the mark's floor, and the two constraints meet at the same
number.** `bracemark-icon.tsx` records that the 45° cut is the last feature to
survive small sizes and that it still reads at 16px, so nothing may render the
mark under it. A surface therefore cannot carry a lockup SMALLER than the
canonical one, which is why there is no second, compact lane for the popup or
for anything else: it is this pair, or About's larger stacked one below.

**Do not reach for `em` to enforce the ratio.** On web both numbers are already
rem (`h-4` is `1rem`, the wordmark `0.9375rem`), so the proportion already
survives root font scaling for free; an `em` mark height would only force the
font-size onto the flex parent so the SVG could inherit it. On native it is not
expressible at all — `rem` is baked at build time and `react-native-svg` sizes
by a numeric prop ([theme.md](./theme.md), _extending_). This is an authoring
rule, held by this paragraph and by the comments that point at it.

It is the brand's only appearance on any surface that has no other carrier, so
the surfaces have to agree: bracemark-web's links rail, its settings rail and its
auth card; the browser extension's popup header; and bracemark-expo's two
drawers, its auth screen, its landing and **its share sheet** — the purest case
of the rule, since that one floats over somebody else's app and has nothing but
the lockup to say whose sheet it is. The browser extension's `OptionsShell` is
**not** one of them and no longer carries a lockup at all: that document always
renders embedded in a host which draws the name and icon immediately above it,
so a lockup there was the second copy of both (its own header comment carries
the reasoning).

**Nine call sites, two components, no hand-typed copies.** Web goes through
`packages/web-ui/src/components/brand-lockup.tsx` and native through
`apps/bracemark-expo/src/components/brand-lockup.tsx`; both take the wordmark
from `BRAND.name` rather than a literal, and each call site passes only its own
chrome (the rails' `h-14` and hairline, the popup header's `h-11`).

Web typed the utilities into all four files for a long time, with a comment in
each naming the other three — which is how the popup's 16/13 flattening got in
and stayed. Expo never had that option: the mark's height is a `height` **prop**
there (`react-native-svg` sizes by prop, not by class), so a copy drifts by a
pixel the first time one is edited.

The two components are duplicates on purpose. Uniwind and Tailwind are separate
compilers over separate stylesheets, so there is nothing for the native file to
import; the numbers are stated twice and this section is what keeps them equal.
The one remaining hand-typed wordmark step is the browser extension popup's
**sub-view title** (`popup/Shell.tsx`), which stands in the wordmark's slot so
the header is the same bar in both modes — it is a title, not a lockup, and its
comment says so.

Do **not** reach for a `--text-*` token to hold the 15px. The invariant is the
ratio to the mark, and a token names only the half that cannot defend itself: a
one-line edit would move all nine wordmarks and leave every `h-4` where it is,
which is precisely the drift above, made cheaper. bracemark-site's `--text-body`
is the same number for running prose at a different leading, and is unrelated
(`apps/bracemark-site/src/app/globals.css`).

**Settings → About is the one surface that departs from those measurements**, in
both apps: a **40px** mark stacked above the name
(`text-lg font-semibold tracking-tight`) and `BRAND.descriptor`, inside a
bordered card. The rule above binds surfaces where the brand is a **carrier** — a
rail, a sheet, a card that is about something else and has to agree with the six
others a user may have just come from. On About the brand is the **subject**: it
is the screen a person opens to ask what this app is and which version they are
running, and a 16px lockup under a 20px "About" heading reads there as a nav
fragment that wandered in from the rail. No third size follows from this — if a
surface is not About, it is a carrier.

### the 45° fold as a UI device

The fold is also used away from the mark, and it carries **exactly two
meanings**. No use renders the mark — each cuts the same corner off a rectangle,
at a size set against the object rather than against the mark's 30% ratio, which
only reads as a silhouette on ~40px objects.

**The favicon tile's chamfer is not one of these uses and is not a third
meaning.** It is the mark's own fold on the tile that exists only to carry the
mark, and it is governed by the raster conventions above, not by this table. The
rule here binds the fold where it appears **away** from the mark, on an object
that is about something else — which is exactly where a fold has to earn a
meaning, because there is no mark beside it to explain the shape.

| where                                                                       | cut     | what it means                                                                                                               |
| --------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| the browser extension's page tile (`corner-cut`/`corner-square`)            | 0.75rem | **state** — square is unsaved, cut is saved; the part of it on the OBJECT ([browser-extension.md](./browser-extension.md))  |
| bracemark-expo's share-sheet specimen (`features/share/share-specimen.tsx`) | 12px    | **state**, the same one — the native port of the row above, on the same 64x40 slot                                          |
| bracemark-web's auth card (`(auth)/layout.tsx`)                             | 1.5rem  | **identity** — the signed-out routes have no rail to carry the brand, so the card itself is the Bracemark surface           |
| bracemark-expo's auth card (`components/dog-eared-card.tsx`)                | 24px    | **identity**, the same one — the native port of the row above, not a third meaning; the case is _stronger_ here (see below) |

Count meanings, not surfaces — **four rows, two meanings**, each meaning one idea
rendered on two platforms. The expo card is the web card on another platform:
same two screens, same job, same 1.5rem/24px cut, and a native app has no tab
title to fall back on, so it is even more true there that these screens are the
only place the app never says its own name. The share sheet's specimen is the
browser extension's page tile on another platform, and the pairing is just as
tight: the same question ("this page — saved or not?"), the same 64x40 slot, the
same 12px cut, both drawn as the thing the library will draw for that link.

⚠ **The 12px is read against the slot's SHORT edge, and only the short edge.**
Both specimens drew a 44px square until the four surfaces that render a saved
link were measured against each other — bracemark-web's list row and its
skeleton, bracemark-expo's row, and the two specimens — and only the specimens
were square. They now carry the row's `h-10 w-16`, and the cut's ratio survived
the move intact: 12 of 40 is 30%, against 12 of 44's 27%, where the mark's own
fold is ~29%. It survived because the cut is 45° and takes the same 12px off
both edges, so the SHORT one governs — sizing to the 64px width instead would
want 17px, which is 43% of the height and reads as a wedge rather than a folded
corner. A 40px-tall object is still inside the range where the fold reads as a
silhouette of the mark at all, which is what the whole pair depends on. If that
slot's height ever moves, the cut moves with it; its width may move freely.
The derivation is in `bracemark-extension/styles/globals.css`, above the pair.

⚠ **A third meaning is what is forbidden.** A fold that means "saved" somewhere
and nothing in particular elsewhere teaches users it means nothing.

**The state fold is not the whole confirmation, and the code said so before the
prose did.** Both specimens' headers claimed the cut was the entire "saved"
signal — "no check badge, no colour, no state word competing with the title" —
while `Complete.tsx` set its `PopupTitle` to "Saved" and named the list, and
`share-screen.tsx` printed "Saved to <list>". The words carry the state on both
platforms; the fold is the part of the confirmation that happens to the OBJECT
rather than to the chrome around it, which is the whole reason the specimen does
not move across the save. Keep it — it is one CSS pair and one RN overlay, and
dropping it would take one of the two meanings in the table above with it — but
do not restate the stronger claim, which is the version an accessibility review
would fail us on if it were true (a fold announces nothing).

The two platforms draw it differently, and on RN the technique is chosen by
**scale** rather than by taste:

- **Web clips**, and the clip takes the ring and the box shadow with it — so the
  card draws its hairline as a 1px filled layer underneath and its shadow as a
  `drop-shadow` filter. Copy that pattern for any clipped surface big enough to
  have a border.
- **RN has no `clip-path` at all**, so it has two techniques, and the dividing
  line is whether the shape carries a hairline:
  - **At card scale, a stroked path.** The obvious native trick — a rotated
    square in the page colour laid over the corner — cannot carry a hairline,
    which would leave the diagonal as the one edge with no border, and the
    diagonal is the whole device. So the expo auth card's outline is **one
    filled-and-stroked `react-native-svg` path** sized from the content's
    measured box: three rounded corners and a straight chamfer where the fourth
    would be. It also ships **no shadow**, deliberately — RN would cast the
    _content box's_ rectangular shadow, putting a rectangular halo around a
    folded corner and turning a turned page into a chipped one.
  - **At tile scale, the overlay is correct** — and it is not an approximation.
    Web's own 44px tile loses its ring along the diagonal too, because
    `clip-path` erases the ring with everything else, so a rotated square in the
    page colour reproduces the web result exactly. That is what the share sheet's
    specimen uses, and it keeps `react-native-svg` off a path whose init cost
    would be paid on every cold share ([share-sheet.md](./share-sheet.md)).

### the generated pictures — the card and the store screenshots

**Eight committed PNGs the build reads, and none of them can be checked by
looking.** Four are the social card (`opengraph-image.png` + `twitter-image.png`
in `apps/bracemark-site/src/app/` and `apps/bracemark-web/src/app/`, 1200x630,
with an `.alt.txt` beside each); four are the PWA screenshots in
`apps/bracemark-web/public/` that `manifest.json` lists — `ss-narrow-1/2.png` and
`ss-wide-1/2.png`. They are **artifacts**: produced deliberately, out of the
build, committed, and governed by the contract below rather than by a generator
this repo runs.

**And one film, under the same contract.** `apps/bracemark-site/public/video/`
holds `demo.mp4` and `demo.poster.png` — 1920x1080, silent, about nineteen
seconds — which the launch post plays through `<DemoClip />`
(`apps/bracemark-site/src/components/mdx-components.tsx`). Every line of type in
it is a constant this repo owns: the tagline, the hero's `SIGNATURE` panel, three
of `SCREENSHOT_CAPTIONS` (`saveTab`, `encryptedBeforeSync`, `searchNotOurs`) and
the slogan. So it is stamped like a card and goes stale like one, with two
differences worth knowing. The pair is stamped **together** — the poster is
frame 0 of the same render, `check:assets` reads the mp4's size out of its track
header the way it reads a PNG's, and it refuses a clip whose poster is missing, a
different size, or stamped from different inputs. And its text alternative is
**not a sidecar**: a `<video>` has no `alt`, so the component builds the label
from the same constants, in the order the film shows them, and there is no
second file to forget.

⚠ **The film shows the iOS app beside bracemark-web, in sync, and no stamp
records that.** It is a claim made by a picture rather than by a string, so
_only what ships_ in [brand-assets.md](./brand-assets.md) binds it and nothing checks it: the clip is true on a
page that also says the iOS app is available, and on no other. The launch post
says so in its first paragraph. Before the clip is put anywhere else — the
landing page, a post written for a platform we have not shipped on — that is the
question to ask of it.

⚠ **BOTH FAMILIES SHIPPED BRACE.TO v1 FOR THE PRODUCT'S WHOLE LIFE, AND NOTHING
SAID SO.** The card this repo shipped from `Initial commit` read "Save links to
visit later", named the _predecessor_ in its body copy, claimed "Powered by
Stacks technology", drew the old dotted-square mark, and carried **eleven
third-party wordmarks** — the same smear the hero panel refuses to draw even once
(`page.tsx`, the note above its preview slot, on the endorsement test). The eight
`ss-*.png` were the same picture with a caption on it, and they outlived the card
because brand-assets.md said in as many words that they were "not brand assets and are
not governed here". Both survived the entire rename for the reason every failure
on this page survives: **a picture has nothing to lint.** No type error, no test,
no failing build, and a wrong one renders exactly as well as a right one.

**So the pictures are stamped, and the stamp is what is checked.**
`assets.stamp.json` — at the workspace root, beside the other files that describe
the tree rather than live in it — records, for each file, the strings and tokens
it was drawn from and the hash of the file itself; `npm run check:assets`
recomputes those inputs from the live constants and fails when they have moved:

| part                 | must equal                                       | or the picture            |
| -------------------- | ------------------------------------------------ | ------------------------- |
| the headline         | `BRAND.tagline`                                  | says a sentence we do not |
| the wordmark         | `BRAND.name`                                     | drifts from the lockup    |
| a screenshot caption | `SUBTITLE` / the listing lines                   | promises what we do not   |
| the mark             | the `d` in `web-ui`'s `BracemarkIcon`            | is a **third** copy of it |
| the colours          | `--foreground`/`--muted-foreground`/`--signal`   | invents a second palette  |
| the pixel size       | what `manifest.json` and the card format declare | is silently mis-declared  |

It checks **inputs, not pixels**, and that is deliberate rather than a shortcut:
a re-render is never a byte-clean diff (see the antialiasing note under _the
mark_), so comparing pictures would fail on every regeneration and comparing
inputs fails only when something actually moved. Run it beside
`npm run check:private`; a failure names the file, the string it was drawn from
and the string that constant says now.

**Regenerate and re-stamp when:** the tagline, subtitle or a listing line
changes; **a screenshot caption changes**; **the slogan changes** (the promo tile
below and the film's last frame are set in it); **a `SIGNATURE` string changes**
(any picture that draws the hero's panel — the film does); the mark changes; a `--color-*` token moves; the links list layout changes shape; the browser extension's popup changes
shape; the share sheet does; the Advanced search panel gains, loses or renames a field; the
selection bar, the Sync row in Settings → Data, the import's over-limit question, the Edit link
dialog or the welcome's recovery step (after create-account) is reworded or rearranged; the free plan's link cap moves (the import figure prints it); or a screenshot
shows a screen that no longer exists. Nothing else will
tell you — that list _is_ the tripwire, and for the store pictures further down it
is the _only_ thing there is, since those are not stamped. The same holds for the
marketing site's own figures — the landing page's and the ones its `/docs` pages
show (`apps/bracemark-site/src/content/figures.ts`): bare `.webp` captures, checked
for their files and sizes and not stamped
([architecture.md](./architecture.md), _the marketing site's `/docs`_).

**The card has two designs and the stamp records which one is committed.**
`slab` is type on white over an inverted ciphertext band — the page's own
inverted-slab rhetoric, where dark is what the server sees. `library` is the
seeded capture from `e2e/shot` cropped to the list pane, which shows the
real product and pays for it by cropping a 25:19 object into 1.91:1 and carrying
other people's cover art.

**1200x630, and the twin file is not redundant.** Every unfurler sizes a
`summary_large_image` at 1.91:1 and upsamples from that step; the card this
replaced was 800x418, inside the floor and soft on any retina timeline. With only
the og file Next emits no `twitter:image` tag at all, so `twitter-image.png` is a
byte-identical copy rather than a duplicate.

⚠ **The PWA screenshots are bare captures — no device bezel, no caption.** Chrome
draws them inside its own install dialog at a few hundred pixels, where a frame
inside a frame reads as a mistake and a caption is illegible. A store listing is
a different consumer of the same capture: it may add a caption, but the mobile
store design deliberately adds no handset bezel either. And the set
`manifest.json` lists is the set that ships: two of the v1 files sat in `public/`
referenced by nothing, deploying 2MB per release for no reader.

**They are `1170x2532` narrow and `2560x1600` wide** — 390x844 CSS at DPR 3, and
1280x800 CSS at DPR 2. Both are chosen rather than inherited; the v1 files were
1242x2688 and 2732x2048, legal but arbitrary. A `wide` screenshot is a **desktop**
one and 4:3 is not a desktop — 2732x2048 read as a landscape tablet — so it is the
median laptop viewport. `narrow` is the median modern phone (iPhone 12–16; Pixel
is 412 CSS) rather than the widest, because the dialog scales a screenshot to a
fixed width: a narrower CSS viewport makes the app's own type **bigger** in the
result. Both sit under Tailwind's `sm`, so the mobile layout is the same either
way. The captures that fill these are scenes in `e2e/shot/scenes.ts` —
`docs/e2e.md`, _the published screenshots_.

⚠ **Chrome applies three rules to `manifest.json`'s screenshots and reports none
of them.** Every dimension in 320–3840; the long side at most **2.3x** the short
side; and every screenshot of one `form_factor` must share **one aspect ratio**.
Break any of them and the set is dropped from the install dialog — which still
opens, so the symptom is a picture that is simply not there. `npm run check:assets`
enforces all three, because nothing else does. The number to watch is the narrow
ratio, **2.164:1**: it is deliberate headroom, and phones keep getting taller — a
20:9 screen is 2.22 and a 21:9 is 2.33, over the ceiling. Pick a phone by its
ratio, not its name. Format is **PNG or JPEG only**; WebP is not accepted here,
whatever `make-image-variants.sh` argues for the site's own figures.

**Two per form factor, not four**, and the count is a decision. Chrome takes up to
5 narrow and 8 wide, but the dialog shows about one and a half at a time; and every
extra file is another PNG the regenerate list above invalidates, another stamp
entry, another capture run against real sites. Two is where the set stops being a
still life and starts making a claim — **My List** (`/links`, filled) and
**the library doing something** (a committed `?text=` search, which on a phone also
shows the summoned search row and on a laptop shows the rail with nothing
highlighted, because a text search projects to no single axis). A third can be
added later provided it comes from the **same profile**, since one form factor must
share one aspect ratio. The captures are scenes in `e2e/shot/scenes.ts`.

⚠ **A filtered view is short, and that is the fixture rather than a defect.** The
shot library is 26 links across 10 lists, so the search shots land four rows and
leave air under them — about 70% of the narrow frame and 60% of the wide one are
used. On wide the rail carries the full height, so the empty pane reads as a
narrowed view; if it ever stops reading that way the fix is a longer `library.ts`,
not a broader search word.

#### the store screenshots — public copy, private pictures

**The browser extension's Chrome Web Store and AMO listings are four 1280x800
pictures, and none of them is in this repo.** That is the same rule the eight
above obey, read the other way: the repo tracks an image **when a build reads
one**, and nothing here reads a store screenshot — a person uploads it to a
console. What IS here is the half that can go wrong silently.

**The captions are public, and that is the point of them being here at all.**
`SCREENSHOT_CAPTIONS` in `packages/shared/src/stores/listing-copy.ts` holds every
store-screenshot line. A caption is a user-facing claim drawn into a picture, so
a caption typed beside the art would be the one piece of public copy
in the product that nothing reviews — where in that file it gets the character
budget, the bare-"extension" rule, the banned-claim list and the typographic
apostrophe check for free, exactly like the store descriptions beside it. They are
keyed by slug rather than by position: **which caption goes on which screen, and
in what order, is listing strategy** and is not decided here.

⚠ **No console enforces a caption length, so `STORE_LIMITS.screenshotCaption`
is the only thing that does.** A long caption is accepted everywhere and simply
sets smaller, wraps to three lines and spends the room the product was going to
have. 40 characters is what the layout holds.

⚠ **These console-uploaded pictures are NOT stamped, and the gap is real.**
`assets.stamp.json` covers files in this tree; a store picture has no destination
in it, so `check:assets` cannot see that a caption edit has made one wrong. The
regenerate list above
therefore gains a line that nothing will enforce: **a caption changes → redraw the
store screenshots.** They declare their inputs anyway, so the contract is already
written the day a store family becomes a tracked asset.

**Chrome requires 1280x800 and caps a listing at five; AMO sets no size and caps
at ten — so there is one set of art, at Chrome's size, for both.** Four of the
five slots are used, for the same reason the install dialog gets two per form
factor rather than four: a carousel is swiped once, and every extra picture is
another capture to re-take when a screen changes shape. Chrome also **requires a
440x280 promo tile**, which is art rather than a screenshot: the lockup and
`BRAND.slogan` on an inverted ground, with the tile's own top-right corner turned
down. That is the fold's _identity_ meaning from the table above, on the one
surface in a store grid with nothing else to carry the brand — and the polarity
is what makes the cut the mark's own gesture rather than its inverse, since a
light tile would have to reveal ink to be visible at all. It is not in this repo
either, for the reason the four screenshots are not, and it is not stamped
either: **`BRAND.slogan` changing is one more line on the regenerate list that
nothing will enforce.**

**The mobile stores use the same four semantic pictures, not the same four
files.** App Store receives native iOS captures at 1290x2796 for the 6.9-inch
phone class; Play receives native Android captures composed at 1080x1920. These
two phone families were the eight-asset deliverable while the app was phone-only.
It is iPad-native now ([expo-build.md](./expo-build.md), _devices_), so App Store
submission also needs an iPad family: capture the same four jobs independently in
the real iPad layout — rails docked — at 2064x2752 rather than stretching phone
art. The Play size is deliberate
9:16: it is recommendation-eligible and stays inside
Play's 2:1 long-side ceiling, unlike a raw 1080x2400 emulator screenshot. Four
is enough to meet Play's recommendation-surface minimum while leaving Apple's
first three images to carry the main story. Re-verify every size and count in
the consoles at submission.

The families share captions and subject matter so the promise does not change by
store, but each shows the platform-native app and share surface a buyer will
actually receive. They are caption-above-product composites on the quiet border
field: Bricolage Grotesque, foreground ink, one or two lines in the top 18%, then
an unframed app pane with a hairline and top corners that continues past the
bottom edge. No handset outline, Dynamic Island, camera hole, vendor mockup,
gradient, decorative object or mixed light/dark set. This keeps the UI large,
avoids claiming one device model, and follows Play's guidance to minimize text
and device imagery. The caption-to-screen pairing and upload order remain outside
the public repo.

⚠ **The one third-party thing in a store picture is the page being saved**, and it
is chosen under the rule `e2e/shot/library.ts` already argues: our own pages,
public-domain or openly-licensed material, cover art that is a photograph rather
than a masthead. The listing-safe seed permits no logo-card cover: a real host and
favicon are nominative context, but a publisher mark presented as artwork is a
different claim and a store reviewer can reasonably read it as an endorsement.
A store screenshot crops harder than any figure on the site, so inspect the
finished crop rather than approving the source list in the abstract.

**When there is nothing fit to ship, the key comes out.** The eight v1 files were
deleted outright rather than left in place until replacements existed: a manifest
that declares no screenshots degrades to Chrome's plain install prompt, which is
strictly better than a dialog showing the predecessor's mark, a tagline we do not
use and eleven third-party wordmarks. `screenshots` is therefore **optional** to
`check:assets`, which treats its absence as legitimate while keeping both of its
manifest⇄tree directions live — a stamped `public/ss-*.png` that nothing
references still fails.

⚠ **Chrome's richer install UI needs a `description` too, and without one the
screenshots are never drawn at all** — committed, correct and invisible. The
manifest carries one, and it is **not typed there**: it is
`PWA_INSTALL_DESCRIPTION` in `packages/shared/src/stores/listing-copy.ts` (the
same string as Play's short description — same job, one line a person reads while
deciding to install), and `check:assets` fails when the two disagree. That is the
same treatment the cards' `.alt.txt` sidecars get, for the same reason: it is
TEXT, it is a user-facing claim, and `manifest.json` is a file nobody opens. It is
also a stamped input of all four screenshots — the one input a bare capture
depends on without drawing, because Chrome renders the sentence immediately above
the carousel and the two are one composition.

**Optional and not taken yet:** screenshot entries also accept a `label`, which
Chrome can show. Those are user-facing copy and belong in `listing-copy.ts` beside
the description rather than typed into the manifest.
