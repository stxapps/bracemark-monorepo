## brand assets — the mark, the lockup, the lines, the licence

The **invariants** that keep the brand consistent across seven surfaces and the
four apps that carry the mark: what the mark is, where its copies live and why
they must not drift, the one set of lockup measurements, the two meanings the 45°
fold is allowed to carry, the three brand lines, and what the public repo
entitles us to claim.

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
  the mark**: on an N×N canvas the tile is **7N/8 wide × N tall, centred, with an
  N/8 corner radius**, and the mark sits inside it at **ink height 7N/8**, centred,
  natural 428:512 aspect. The canvas corners outside the tile's radius stay
  transparent, so the tile reads as a rounded chip and not as a square.
- **App and PWA tiles** (`logo192/512`, `*-maskable`, `apple-touch-icon`,
  `apple-icon`, expo `icon.png`/`ios-light.png`) — opaque **white** tile, mark
  `#0a0a0a`, ink height 50–55%.
- **The expo dark and tinted variants** (`ios-dark.png`, `ios-tinted.png`) —
  transparent, near-white mark, 55%; iOS composites them over its own backdrop.
- **The two `favicon.ico`** (bracemark-web, bracemark-site) — four frames each,
  16/32/48/64, following the favicon rule above, tile included.
- **The three expo rasters the platform composites itself** (`adaptive-icon.png`,
  `splash-icon.png`, `splash-icon-dark.png`, all 1024²) — transparent, because
  their background is set in `app.config.ts` rather than baked in: Android's
  adaptive icon sits on `#ffffff`, and the splash pair on `#ffffff` / `#0a0a0a`
  at `imageWidth: 200`, `resizeMode: 'contain'`. Editing the background is an
  `app.config.ts` change, not a re-render — and `adaptive-icon.png` is a
  **maskable** foreground, so it is bound by the 65.2% ceiling below.

Only mark rasters are counted above. `apps/bracemark-web/public/` also holds
store screenshots (`ss-*`) and an OG image, which are not brand assets and are
not governed here.

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

Mark beside wordmark — **one set of measurements rendered on seven surfaces**: a
20px mark (`h-5`), the wordmark at
`text-[0.9375rem] leading-none font-semibold tracking-tight`, `gap-2.5` between
them.

It is the brand's only appearance on any surface that has no other carrier, so
the surfaces have to agree: bracemark-web's links rail, its settings rail and its
auth card; the browser extension's `OptionsShell`; and bracemark-expo's two
drawers, its auth screen, and **its share sheet** — the purest case of the rule,
since that one floats over somebody else's app and has nothing but the lockup to
say whose sheet it is.

Web types the six utilities into each file with a comment naming the others.
**Expo does not, and must not** — the mark's height is a `height` **prop** there
(`react-native-svg` sizes by prop, not by class), so a hand-typed copy drifts by
a pixel the first time one is edited. All four native call sites go through
`apps/bracemark-expo/src/components/brand-lockup.tsx`, which also takes the
wordmark from `BRAND.name` rather than a literal.

**Settings → About is the one surface that departs from those measurements**, in
both apps: a **40px** mark stacked above the name
(`text-lg font-semibold tracking-tight`) and `BRAND.descriptor`, inside a
bordered card. The rule above binds surfaces where the brand is a **carrier** — a
rail, a sheet, a card that is about something else and has to agree with the six
others a user may have just come from. On About the brand is the **subject**: it
is the screen a person opens to ask what this app is and which version they are
running, and a 20px lockup under a 20px "About" heading reads there as a nav
fragment that wandered in from the rail. No third size follows from this — if a
surface is not About, it is a carrier.

### the 45° fold as a UI device

The fold is also used away from the mark, and it carries **exactly two
meanings**. No use renders the mark — each cuts the same corner off a rectangle,
at a size set against the object rather than against the mark's 30% ratio, which
only reads as a silhouette on ~40px objects.

| where                                                                       | cut     | what it means                                                                                                               |
| --------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| the browser extension's page tile (`corner-cut`/`corner-square`)            | 0.75rem | **state** — square is unsaved, cut is saved; the whole signal, no badge ([browser-extension.md](./browser-extension.md))    |
| bracemark-expo's share-sheet specimen (`features/share/share-specimen.tsx`) | 12px    | **state**, the same one — the native port of the row above, on the same 44px tile                                           |
| bracemark-web's auth card (`(auth)/layout.tsx`)                             | 1.5rem  | **identity** — the signed-out routes have no rail to carry the brand, so the card itself is the Bracemark surface           |
| bracemark-expo's auth card (`components/dog-eared-card.tsx`)                | 24px    | **identity**, the same one — the native port of the row above, not a third meaning; the case is _stronger_ here (see below) |

Count meanings, not surfaces — **four rows, two meanings**, each meaning one idea
rendered on two platforms. The expo card is the web card on another platform:
same two screens, same job, same 1.5rem/24px cut, and a native app has no tab
title to fall back on, so it is even more true there that these screens are the
only place the app never says its own name. The share sheet's specimen is the
browser extension's page tile on another platform, and the pairing is just as
tight: the same question ("this page — saved or not?"), the same 44px tile, the
same 12px cut, both drawn as the thing the library will draw for that link.

⚠ **A third meaning is what is forbidden.** A fold that means "saved" somewhere
and nothing in particular elsewhere teaches users it means nothing.

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

### the brand lines

**Three lines, three jobs, never substituted for each other.** They live in
`packages/shared/src/stores/listing-copy.ts` because five consoles and three apps
have to agree and nothing else enforces that.

| line           | text                                                   | for                                                                      |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| **descriptor** | End-to-end encrypted bookmark manager                  | directories, categories, any surface that supplies no context of its own |
| **tagline**    | The bookmark manager that can't read your bookmarks    | hero, OG title, X bio, press                                             |
| **slogan**     | We don't promise not to look. We built it so we can't. | sign-offs, ads, the inverted band                                        |

The tagline is the asset: it names the category and the mechanism in one clause
and states the mechanism as an **inability rather than an intention**, which no
competitor holding plaintext can copy. Its one weakness is that "can't read" can
momentarily parse as _broken_ rather than _blind_, so it is safest where
supporting copy resolves it immediately — which is why the ~30-character store
fields get a fourth line instead: **"Bookmarks only you can read"**, the same
claim inverted to a positive.

**Adjectives are the failure mode here, not a missing feature.**
"Privacy-focused", "private & secure" and the rest are claims about intent, in a
product whose whole argument is that intent is worthless — putting them next to
"we don't promise not to look" contradicts it out loud. Prose says the mechanism
("a path, a size, and bytes we hold no key for").

### the source — what we may claim

**The repository is public: `github.com/stxapps/bracemark-monorepo`, AGPL-3.0.**
The whole product is in it — both apps, the browser extension, both Workers, the
marketing site. This is a **claim we make about ourselves**, so it is subject to
the same rule as the brand lines: it must say the same thing on every surface,
and it must not outrun what the code supports.

**The claim boundary, which every surface below is written to.** Public source
lets a visitor **read what we do**. It does **not** let them verify that the
bundle their browser executed was built from it — there is no reproducible build
and no signed release, so nothing ties a served asset back to a commit. So:
_"see for yourself what we do"_, never _"verify what you are running"_. Every
placement states the limit rather than leaving a reader to discover it. If
reproducible builds ever ship, this paragraph is what changes, and the surfaces
below move with it.

**Why AGPL and not MIT.** A hosted fork is the only real competitive risk, and
the AGPL's network clause is the one that addresses it: run a modified version as
a service, publish the modifications. It does not restrict a user, which is the
audience that matters here.

⚠ **The licence is stated in three places and they have disagreed once already.**
The root `LICENSE` file (AGPL-3.0), the root `package.json` `license` field, and
`SOURCE.license` in `packages/shared/src/stores/listing-copy.ts`.
`package.json` said `MIT` against an AGPL `LICENSE` for the repo's whole first
stretch, which is not cosmetic: a reader may rely on either, and the permissive
one is the one they would rely on. `listing-copy.spec.ts` pins the third copy;
the other two are on you.

**Where it is published, and why each.** The URL and licence come from `SOURCE`
in `listing-copy.ts`, beside `COMPANY`, for the same reason `COMPANY` is there.

| surface                            | what it says                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| marketing site footer, _Company_   | "Source code" — where a developer looks first, on every page |
| /about, _See for yourself_         | the argument and the caveat, in prose, after "Who makes it"  |
| /about, the _Built with_ colophon  | `AGPL-3.0 · github.com/…` as a specimen line                 |
| /faq, privacy group, `source`      | the question as actually asked, before `security-report`     |
| /privacy, _Security_               | so the policy's claims can be read against the software      |
| Settings → About, both apps        | one row; the only one not pointing at the marketing site     |
| the repo's `README` and `SECURITY` | the landing surface, and where to send a vulnerability       |

Deliberately **not** on the home page hero or in the store listings. In a hero it
reads as a developer-audience signal competing with the actual pitch; in store
copy it is a claim that can only be corrected by shipping a build through review.
