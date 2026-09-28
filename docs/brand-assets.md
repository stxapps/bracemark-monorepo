## brand assets — the mark, the lockup, the lines, the licence, the account

The **invariants** that keep the brand consistent across seven surfaces and the
four apps that carry the mark: what the mark is, where its copies live and why
they must not drift, the one set of lockup measurements, the two meanings the 45°
fold is allowed to carry, the three brand lines, the voice everything else is
written in, the two nouns the product uses for what it stores, what the public
repo entitles us to claim, and the one social account we hold.

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

### the brand lines

**Three lines, three jobs, never substituted for each other.** They live in
`packages/shared/src/brand/brand.ts` because five consoles and three apps have to
agree and nothing else enforces that. Not in `stores/listing-copy.ts` next door:
a store listing is only one of their consumers, and Settings → About, the
marketing site and the app chrome are the others.

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
fields get a fourth line instead: **"Links encrypted on your device"**. The
listing name already supplies the bookmark category; the shorter line uses the
product's object noun and names the mechanism. It replaced "Bookmarks only you
can read", whose noun phrase could still be taken at a glance as an instruction
to save only what you have time to read — grammatically avoidable, commercially
real on a surface read that quickly.

**Adjectives are the failure mode here, not a missing feature.**
"Privacy-focused", "private & secure" and the rest are claims about intent, in a
product whose whole argument is that intent is worthless — putting them next to
"we don't promise not to look" contradicts it out loud. Prose says the mechanism
("a path, a size, a timestamp, and bytes we hold no key to open").

### the voice

The three lines above are what we say where a surface gives us one sentence. This
is how everything **else** is written — the marketing site's prose, an FAQ answer,
a button, an empty state, the sentence a failed request puts on screen. It is the
same kind of rule as the two nouns below and carries the same warning: nothing
enforces a word of it, and a paragraph in the wrong register type-checks, lints
and ships.

**Four attributes.** Each is stated with the misreading it invites, because the
misreadings are what actually happen — "plain" drifts into slack, "we" drifts
into corporate.

**Mechanical — describe the machine, never our intentions.**

- **We are**: specific about what the software does and precisely what our servers
  hold.
- **We are not**: reassuring. "Privacy-focused", "bank-grade", "your data is safe
  with us" are claims about intent, in a product whose whole argument is that
  intent is worth nothing beside architecture. Putting one next to _"we don't
  promise not to look"_ contradicts it out loud.
- **Sounds like**: "A path, a size, a timestamp, and bytes we hold no key to
  open. Not the title, not the address, not the tags." (the home page's inverted
  half). Note the completed verb: the compressed "bytes we hold no key **for**"
  shipped for a stretch and read as vague — a stranded preposition makes the
  reader invert the clause to find the claim in it.
- **Does not sound like**: "Your bookmarks are private and secure."

**The mirror of that rule is naming an enemy, and it fails the same way.**
"Bracemark exists to prevent the exploitation of your behaviour and interests" is
"privacy-focused" with the intent moved to the other party — a purpose we assert,
in a product whose case is that a purpose is worth nothing beside an
architecture. It also claims more than the machine does: we can keep
`api.bracemark.com` out of your library, and we cannot stop the sites you visit,
your browser or your ISP from assembling the same picture — `bracemark-extractor`
is handed a plaintext URL whenever the opt-in is on
([link-extraction.md](./link-extraction.md), _server extraction_). That makes
"prevent" the true-subset-as-the-whole error the privacy claims were rewritten to
avoid, in the one direction a reader can falsify from their own browsing. And it
buys a category the property has otherwise stayed out of, for the same reason two
words of set dressing came out of the hero specimen
(`apps/bracemark-site/src/app/page.tsx`, the tag row): the name of an -ism
recruits a whole genre, and the argument moves from what our server holds, which
is checkable, to a critique of an industry, which is not.

**The harm underneath it is real, and is already stated three times — each time
as a fact rather than as a cause.** /about opens on it ("what you are reading,
buying, worrying about, and working on"); the hero specimen assembles that picture
in front of the reader out of two topic tags and a weekday; the landing band's
"No ads, ever" carries the investor clause that says why the policy can hold.
There is no fourth surface missing. If one is ever wanted it is descriptive and
bounded to our own server — "a list of what you save is a list of what you want;
we hold bytes we have no key to open" — and it is never a sentence about why we
exist.

**States its own costs, unprompted.** The distinctive one, and the one most
easily edited out by someone tidying.

- **We are**: willing to spend a section arguing against the product.
  `FULL_DESCRIPTION` ends on "WHAT IT COSTS TO BUILD IT THIS WAY"; /about carries
  the same heading in prose; the create-account ceremony says saving the recovery
  code is "genuinely on you".
- **We are not**: modest, and not hedging. The concession is load-bearing: every
  other claim on the page is one the reader has no way to check, made by the party
  who benefits, and the costs are the only part of it they can verify against
  their own use.
- **The rule**: any surface long enough to make the case must also say what the
  architecture costs — no password reset, search that runs on the device, no
  shared or public lists. Not relegated to /faq.

**Second person, present tense, ordinary words.**

- **We are**: writing to one person doing one thing.
- **We are not**: casual. No exclamation marks, no "Oops", no jokes; the register
  is plain, not chatty.
- **Sounds like**: "Archive a link when you are done with it — it leaves My List
  but stays saved." / "Save a link and it lands here."
- **Does not sound like**: "Users can leverage the archive to keep their library
  tidy!"

**First person plural, and it takes the blame.**

- **We are**: a "we" that owns the mechanism and owns the failure. "We hold no
  key." "We cannot look, so we cannot be asked to." "Could not sign in."
- **We are not**: a "Bracemark" that refers to itself in the third person in
  running prose. The name is the subject where the sentence is about the product
  ("Bracemark is a bookmark manager that cannot read your bookmarks"); "we" is the
  subject where it is about the people running it, and that is every sentence
  about a promise, a cost, or a mistake.

#### tone by surface

The four attributes hold everywhere. What moves is how much room there is to
argue, and the register follows the room rather than the channel.

| surface                                | tone                                                                   | specimen                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| hero, store name/subtitle, OG title    | flat and declarative — one claim, no hedge, no supporting clause       | "Links encrypted on your device"                                                                                |
| /about, /faq, `FULL_DESCRIPTION`       | argued and long — makes the case, then concedes                        | "That is not a privacy policy. It is the architecture."                                                         |
| in-app labels and helper text          | instructional — what this does, in the user's own words                | "Every link you save shows up here, whichever list it lives in."                                                |
| empty states                           | names the next act, never the absence                                  | "No tags yet. Type a name to make one."                                                                         |
| upgrade and paywall copy               | names what stays **free** in the same breath as what does not          | "Nesting a list inside another is a Plus feature. Flat lists and tags stay free and fully usable."              |
| errors                                 | fixed shape, below                                                     | "Could not change your password. Please try again."                                                             |
| /terms, /privacy, the consent sentence | plain and literal — full document titles, no marketing register at all | "By creating an account, you agree to our Terms of Service and Privacy Policy" (`components/legal-consent.tsx`) |

#### errors have a fixed shape, and it is already in the code

Two forms, and the choice between them is whether the user can do anything.

- **Nothing they can act on** — _"Could not ⟨their own verb⟩. Please try again."_
  "Could not sign in.", "Could not create account.", "Could not change your
  password.", "Could not generate a recovery code.", "Could not sign out your
  other devices." The subject is **us**. There is no "Error:", no status code, no
  "Something went wrong", and nothing cute — a product whose case is precision
  does not get to be playful at the one moment it failed.
- **Something they can act on** — name what was wrong, then the act.
  "That recovery code didn't work. Check it and try again." / "This doesn't look
  like a valid URL. Click Confirm to save it anyway." / "This link is in your
  Trash. Restore it, or click Confirm to save a new copy."

⚠ Every one of these **mounts**, which means every one of them needs
`role="alert"` and a carrier that provides it. That is not a wording rule and it
is the one with a worse failure mode: the text appears and nothing is announced.
[accessibility.md](./accessibility.md) owns it.

#### only what ships — and a tool's output is copy

**Promise only what ships.** The list of what is planned and not shipped lives in
one place, the copy rule at the top of `packages/shared/src/stores/listing-copy.ts`
— read it there rather than copying it here, where it would go stale. The rule
is older than this section and was written for store copy, which is why it sat
in that file alone. It binds every string a user reads.

**That includes what a tool prints.** The marketing site's bookmark converter
writes a receipt — losses, warnings, skipped-record reasons — and its own
errors, from `packages/shared/src/tools/bookmark-converter.ts` and the worker
beside its page. None of that looks like copy: it is built in a loop, from
counts, far from any page. It is still the product talking, it is held to this
whole section, and nothing checks it — `listing-copy.spec.ts` walks the store
strings only. The specimen: when Bracemark backups became a converter input, the
receipt's losses line and the page's input row both listed page copies and
screenshots among what a backup holds. Both are planned features, and a sentence
saying they are "not included" tells the reader they exist.

**Another app's feature, in its own words, is not the same finding.** The
converter reads LinkWarden, whose exports carry archived pages, so "archived
pages" on the converter's page describes that data and stays. What is barred is
our name for our planned feature — "page copies", "screenshots" — which reads as
ours wherever it appears.

**A limit the copy states is a claim, and it has to hold for the ordinary
case.** The same change printed "up to 100,000 links" beside a byte limit that
stopped a note-free library at about 94,000; the fix moved the limit, not the
sentence. Where two limits interact, the copy names the one the reader will meet
and the condition under which they'll meet the other — "fewer if they carry long
notes". [data-lifecycle.md](./data-lifecycle.md), _the bookmark converter's
limits_, has the measurement.

#### the mechanics

Written down because they are already kept, not because they are being decided
here — the point is that the next string matches the last two hundred.

| rule                      | this                                                                               | not this                                         |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| headings, buttons, labels | sentence case — "What it costs to build it this way", "Create account"             | Title Case                                       |
| em dash                   | spaced — "…when you are done with it — it leaves My List but stays saved"          | unspaced, or a hyphen standing in                |
| exclamation marks         | none, on any user-facing surface                                                   | one "!" anywhere                                 |
| serial comma              | yes — "links, lists, tags, pins, files, and settings"                              | dropping it before the final "and"               |
| contractions              | the default — "won't be shown again", "doesn't look like a valid URL"              | uncontracted-by-habit, which reads legal         |
| the platform verb         | **click** on web, **tap** on expo — the ported string differs in exactly this word | "select", "press", or one string serving both    |
| plan names and numbers    | read `PLAN_LABELS` and `iap/plans`; store copy carries **no** numbers at all       | typing "Plus", a price, a cap, or a trial length |

**The serial comma was the one row not already kept when this table was
written.** The rule stood and the copy did not: the marketing site dropped it
more often than it kept it — "Lists, tags and pins", "titles, addresses and
hosts", four clauses of /terms — while /delete-account kept it throughout. The
sweep put it into every user-facing string, the store copy in `listing-copy.ts`
included. Nothing enforces it: a list is grammar, not a character, so no
selector can find the missing comma the way one finds a straight `'`. Section
headings in /terms and /privacy are quoted by name elsewhere on the same page
(_Plans, fees, and subscriptions_), so a heading and its cross-reference move
together. The one exception is an **ampersand label** — "List, tags & note",
"Lists, tags, pins, notes & layouts" — where the `&` already marks the last item
and a comma before it reads as a typo.

**A serial comma needs three items; two take none.** The sweep's own failure
mode is to reach for the comma at every "and", and two things joined by one
"and" are a pair, not a list: "reads every message and writes or approves every
reply", "a path and a size", never "reads every message, and writes". The test
is to count what the "and" closes — three or more and the comma goes in; two and
it stays out. Not to be confused with a comma between two **clauses**, each with
its own subject, which is ordinary punctuation and stays: "There is no grace
period, and we don’t bring a deleted account back from a backup." One sweep
already added the stray kind to /privacy, and this rule is harder to hold than
the one above it, because a two-item comma looks like diligence rather than an
error.

**The one place contractions are dropped is a decision, not an oversight.** The
tagline says _can't_ and `FULL_DESCRIPTION` opens with _cannot_ — "Bracemark is a
bookmark manager that **cannot** read your bookmarks", and later "We **cannot**
look, so we cannot be asked to." The uncontracted form is the heavier one and is
reserved for the sentence making the claim most flatly. Everywhere else the
contraction is right, and reaching for "cannot" in helper text just sounds stiff.

**"Most flatly" needs a test, because it is a judgement and nothing enforces
it.** Two sentences of the same kind spelled two ways is the only real
inconsistency here — the two forms side by side are ordinary English — so the
line has to fall in the same place for every author. It is: **"cannot" when the
subject is us or our server and the verb is about reaching the library** — read,
open, decrypt, search, index, sign you in. "Of your library we hold ciphertext
we cannot open", "a server that cannot read your links cannot search them for
you either", "we cannot sign you in or decrypt your account for you". Everything
else contracts, including sentences about us: "we can’t offer payment", "an edit
you regret can’t be rolled back from our side" (a missing feature, not the
architecture), "Permanent deletion can’t be undone". **The brand lines are the
exception**, in the other direction: the tagline and the slogan ("We built it so
we can’t") are spoken lines, set once in `brand/brand.ts`, and keep their
contraction although they state the claim. The contraction sweep that put this
test into practice left /terms, /privacy and /security uncontracted on purpose:
those three pages write out every negation, and that register is theirs.

⚠ **The apostrophe is the typographic `’` in everything a user reads — an
editorial choice, not a consequence of the quote character.** The distinction
matters because the codebase spent a long stretch making it the other way round.
`.prettierrc` sets `singleQuote: true`, and prettier picks whichever quote needs
fewer escapes, so a straight `'` in prose silently flips its literal to double
quotes — and the next sentence gets written to match whatever quote it landed in.
A single-quoted literal took `’` because a straight `'` would have to be escaped;
a double-quoted literal or a JSX text node took `'` because it would not. The same
recovery-code sentence ended up existing in both forms, one screen apart, in four
hand-copied files.

Following the rule dissolves the mechanism: copy that carries `’` needs no
escaping, so prettier keeps single quotes throughout, and a double-quoted literal
in a copy file becomes a smell rather than a normal outcome.

Two things now hold it, because "the rule is written down" is exactly what failed
here:

- **Two specs assert it** over every exported string in the published-copy
  modules: `listing-copy.spec.ts` for the store copy — the strings that leave the
  repo, either into the browser extension's `manifest.json` at build time or into
  a store console by hand — and `brand.spec.ts` for the brand lines, `COMPANY` and
  `SOURCE`. Each walks its module rather than a list of names, so a new export is
  covered without anyone remembering to add it. The character budgets cannot catch
  this on their own: `’` is one UTF-16 code unit, exactly like `'`, so no length
  moves.
- **The copy that exists twice lives in one file.** `packages/react/src/lib/`
  holds it: `recovery-code-copy.ts` (create-account and Settings → Account),
  `lock-copy.ts` (the unlock pane and its two gates), `misc-settings-copy.ts`
  (every radio row in Settings → Misc.), `paywall-copy.ts` (the action-interrupt
  upgrade dialog, both apps' `contexts/paywall-provider.tsx`), beside the
  `new-password-copy.ts` that set the pattern. Each covers a surface that exists
  once per platform, where the native half is a hand port of the web one and
  nothing but the shared file keeps the two saying the same words. The rule for
  what goes in: only the WORDS, and only when there are two of them — a string
  that exists on one platform only (the biometric button) stays at its call site
  rather than moving somewhere that implies a twin. `PAYWALL_COPY` marks the edge
  of "only the WORDS": each entry carries the `plan` that unlocks it, which is not
  a word at rest but is one by the time it is read — the CTA renders
  `Upgrade to {PLAN_LABELS[plan]}` and the description names the same plan in
  prose, so the two travel together or the sentence can promise Plus while the
  button sells Pro.

The sweep **is** done — every string a user reads carries `’`, across both apps,
the packages and the marketing site — and **`no-restricted-syntax` in the root
`eslint.config.mjs` now holds it**, so this is the one rule in this section a
reader does not have to remember. Three things are worth keeping.

**There was a second spelling, and it hid from the obvious grep.** In JSX TEXT
the straight apostrophe was written as the HTML entity `&apos;` — forty-four of
them, none of which a search for `'` can find. Babel decodes it at parse time (on
Metro as well as on web) into exactly the straight `'`, so it was never a fix for
anything, only a disguise. Nothing in this repo asks for it, either:
`react/no-unescaped-entities` is NOT enabled here, and a bare `'` in JSX text
passes `npm run lint` — the entity is a habit carried in from projects that do
enable that rule (it was a Next.js default for years). A third spelling, `&rsquo;`, was in two files and was the only
correct one of the three. Both entities are gone; the literal `’` needs no entity
and does not trip the rule. **Write `’`, not `&rsquo;`** — one spelling, and it
greps.

**The rule is about the CHARACTER, not about who reads the string.** It covers
every `.ts`/`.tsx` in the workspace, and fixing a hit is always the same thing:
type `’`. A log line, a thrown `Error`, a dev-only warning — all of them take `’`
too. That is deliberate and it is the cheaper rule to live under: the alternative
makes every author judge whether a string might reach a user one day, which is
exactly the kind of call that produced the drift above. The one real exception is
a string where the apostrophe is **data** rather than prose — a parser token, a
fixture, a value compared against user input — where `’` would be a bug and a
disable comment is right. There are none today.

Out of scope: **comments** (not a string literal, so the rule never sees them) and
**specs and `e2e/`**, which are ignored — a test NAME is prose nobody reads in the
product, so `it("applies a child's own hide …")` stays as it is. A spec asserting
on real copy still has to spell that copy exactly, or it stops passing, which is
how `listing-copy.spec.ts` and `field-messages.spec.ts` already work.

The three selectors are `Literal`, `TemplateElement` and `JSXText`; the last is
the one that earns the rule, for the `&apos;` reason above. `listing-copy.spec.ts`
keeps its own assertion regardless — the rule fires on the source, the spec fires
on the exported VALUES, which is what actually reaches a store console.

⚠ **The quotation mark is the typographic pair `“ ”` (U+201C/U+201D)**, by the
same editorial rule and with the same scope — every string, one pair, never a
straight `"`, never `&quot;` or `&ldquo;`.

**The mechanism that broke the apostrophe does not exist here, and that is the
point.** Prettier flips a literal to double quotes only when the content holds
more single quotes than doubles, so a `"` in prose needs no escaping and forces
no flip — nothing was ever pulling the choice wrong. It has consequently been
right by taste alone since the beginning: all 25 quotation marks in the workspace
are `“ ”`, and every straight `"` in a `.ts`/`.tsx` is a **comment** or **data**
(the CSV quoting in `import/csv.ts` and `export/csv.ts`, the HTML attributes in
`export/netscape.ts`, the attribute-scanner regexes in `expo-react`'s
`parse-html-head.ts` and the HTML fixtures its spec feeds them).
Which is exactly why it is written down at zero rather than after a drift:
nothing was pulling it wrong, and nothing is pulling it right either.

**Three jobs, all of them already in the code.** A delimiter around **content the
user typed**, which is the common one and is not optional — `Create “{trimmed}”`
in the four list/tag pickers across both platforms, `Move “{name}” to`,
`“{title}” and its saved content`. A **defined term** in the legal pages —
`(“{COMPANY.shortName}”, “we”, “us”)`, the “Service”, “AS IS”. And a **mention**,
where a phrase is being discussed rather than asserted — _there is no “we promise
not to look” in that sentence_ on /about, _What does “end-to-end encrypted”
actually mean here?_ in the FAQ.

**Nesting is barred, and the reason is the rule above it.** The standard inner
pair is `‘ ’`, whose closing mark is the SAME codepoint as the apostrophe — so a
nested quotation puts a character that means _apostrophe_ everywhere else in the
product at the end of a phrase, one word away from a real one. Restructure the
sentence instead. There is no nesting today, and the only `‘` in the workspace is
a table entry in `shared`'s `html/entities.ts` — the windows-1252 character at
0x91, which is that codepoint as DATA rather than as punctuation.

**Whether to quote a UI label is the one case with a real choice in it**, and the
line is what the reader has to do with the string. A **named surface or system
list** stays bare — My List, Archive, Trash, Show All are data
(`sync/system-lists.ts`), a user navigates to them, and the terminology table
already treats them as names rather than as copy. An **option value inside a
control** takes the quotes, because the reader has to find that exact string in a
row of radios and click it: _switch the setting from “Sync” to “Device”_
(`content/faq.tsx`) is right as it stands.

**What holds it is weaker than the apostrophe's guard, deliberately.** A fourth
`no-restricted-syntax` selector covers `JSXText`, where a straight `"` is
unambiguously prose, and the two spec walkers assert it over the exported values
alongside `’`. There is no `Literal` selector, because `"` is real data in this
workspace and such a rule would be per-file disables forever — so a **prose
string in a single-quoted literal** (`'the "Service"'`) is the gap, and this page
is what covers it. `listing-copy.spec.ts` is where that gap matters most:
the two long descriptions, `FULL_DESCRIPTION` and
`BROWSER_EXTENSION_FULL_DESCRIPTION`, are the exports long enough to quote
anything — the second quotes Chrome's permission warning — and both are pasted
into a store console by hand.

#### terminology

The load-bearing pair — bookmark and link — has its own section below. The rest:

| use                                                             | not                                                                       | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"a key your password unlocks"**                               | "a key derived from your password"                                        | the root of an account is a **random DEK**; the password derives only the KEK that unwraps a copy of it, which is how a recovery code opens the same library — so "derived" refutes itself one clause later, beside the sentence promising the recovery code. It reached **eight** surfaces out of one compressed heading before that heading was rewritten ([account.md](./account.md), the callout under _the model_). Two nearby spellings that ARE right and must not be "corrected": the wrapped blobs are "locked with a key derived from your password or recovery code" (that IS the KEK), and "your password is put through Argon2id to derive a key, and that key unlocks the one your library is encrypted with"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **"`api.bracemark.com` never sees your library in plaintext"**  | "the server sees nothing", "only ever sees ciphertext", "the sync server" | one Worker serves auth, sync AND billing, so the same host that cannot read a link holds your username, public key, sessions and subscription row in the clear; only the LIBRARY is ciphertext-only, and there is no separate sync server to narrow the claim onto. An **enumeration that closes** ("nothing else on file") is the same error one step quieter, and a claim about what we SEE rather than what we HOLD is false the moment `bracemark-extractor` is on. `R2` only ever sees ciphertext IS true, and so is "blind sync broker" ([local-first-sync.md](./local-first-sync.md), _the shape of the problem_)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **"end-to-end encrypted"**, and then name what the server holds | "zero-knowledge", "we know nothing", "knowledge-minimized"                | there is no zero-knowledge **proof** anywhere in this stack, so the term is wrong in its own field — on the property whose credibility argument is that you can read the source, that is the most checkable false claim available. On the looser marketing reading it is false three ways over: the identity/billing plane holds your username, public key, sessions and subscription row; `bracemark-extractor` is handed a plaintext URL whenever the opt-in is on ([link-extraction.md](./link-extraction.md), _server extraction_); and R2 accrues object counts, sizes and timestamps. It opened [account.md](./account.md) with its own refutation one colon later ("…also holds your username… in the clear") — the row above this one, spelled with a different word — and had reached five files, none of them user-facing, before anyone read it as a claim rather than a category. **"Knowledge-minimized" is not the fix**: it is accurate and it is a claim about our intent, which _the voice_ bars beside "privacy-focused" wherever a mechanism is available, and here four are — "end-to-end encrypted", "`api.bracemark.com` never sees your library in plaintext", "`R2` only ever sees ciphertext", "blind sync broker". `KEYWORDS` in `listing-copy.ts` keeps `zero,knowledge` and is outside this rule for the reason "vault" is: a comma-list of search terms is not prose, and matching a query is not making a claim |
| **browser extension** / **share extension**                     | "extension", bare                                                         | two unrelated things carry the name; a store listing is read by people who know neither exists ([architecture.md](./architecture.md#apps))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **password**                                                    | "passphrase", in any user-facing copy                                     | the app never prints the other word: `NEW_PASSWORD_COPY` (`react/lib/new-password-copy.ts`) says _password_ on the GENERATED path too ("We generated a strong password for you"), so a surface that says _passphrase_ names a thing the reader will not find in the ceremony. It is the engineering name for the generated default (`crypto/passphrase.ts`) and stays in docs, identifiers and comments — it had leaked into the landing page, the FAQ and the store listing before this row said so ([account.md](./account.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **recovery code**                                               | "backup code", "recovery key"                                             | one name, and it is the one the crypto uses (`crypto/recovery-code.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **sign in / sign out / create account**                         | "log in", "login", "sign up"                                              | already unanimous across both apps; "login" is a noun and never a verb                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **My List, Archive, Trash, Show All**                           | "inbox", "bin", "all items"                                               | these are data (`sync/system-lists.ts`), not copy — never retyped, never translated in prose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Free, Plus, Pro**                                             | "premium", "paid tier"                                                    | `PLAN_LABELS` is the source; see the mechanics table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **list, tag, pin**                                              | "folder", "label", "favourite"                                            | the UI names places and the schema agrees; a synonym in prose teaches a second vocabulary for one feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **the successor to Brace.to**                                   | "the second version", "v2"                                                | the predecessor was renamed AND rebuilt — a decentralised identity stack traded for our own end-to-end encryption — so "second version" names an increment that did not happen, and /about contradicts it two sentences later ("named after a domain nobody could say out loud"). "Successor" is what the repo already calls it everywhere but its public surfaces (`data-lifecycle.md`, `brand/brand.ts`). Not "next generation" either: that fails _mechanical_ above — a reassuring adjective with no content, pointing forward where the claim is a backward-looking track record. It is stated on exactly TWO surfaces, the landing page's _If we disappear_ footnote and /about's _Where it came from_, and they have to agree. Both now carry the YEAR and the LINK, from `PREDECESSOR` in `brand/brand.ts` — an unlinked, undated product name is a track record a reader cannot check, which on this property is the one kind of claim that costs more than it buys, and three readers went looking for something to click. Both also say **and still run today**: a predecessor named only in the past tense reads as churn on the very band arguing we will still be here. That clause is present tense and reports what is running; if the domain ever stops answering, the link comes out of both surfaces and the tense around it is re-read in the same change                                                                 |

And the collection still gets no noun — "vault" and "library" are ruled on in the
next section, which is where the whole terminology argument is made at length.

### the two nouns — bookmark and link

The product has **two words for the thing it stores, and they are not
interchangeable.** Both are correct; each is the best word for a different job,
and using either everywhere breaks something specific.

| word         | job                                                                                    | where it belongs                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bookmark** | the **category** — what kind of product this is, and what it is being compared against | the three brand lines above; `FULL_DESCRIPTION`'s opener; the marketing site's meta description, `/about` and the comparison FAQs; **file formats** (`import/netscape.ts`, `export/netscape.ts`, the "HTML bookmarks" import label) |
| **link**     | the **object** — the thing a user saves, opens, files and acts on                      | every in-app surface: "Add link", "Edit link", "Copy links", "Search links…", "No links saved yet", "Unlimited saved links"; the `/links` route; `LinkQuery`; the `links/` blob namespace                                           |

The marketing site's footer runs both in one breath, and is the pattern in
miniature: _"An end-to-end encrypted bookmark manager. Your links are encrypted
on your device…"_ — category, then object.

**Three reasons the split is load-bearing rather than habitual.**

- **"Bookmark" is the searched word.** Nobody types "link manager". The name
  alone does not say what the product does, so the outward lines have to carry
  the category — and it is the category term the stores index.
- **"Bookmark" is already taken, by the browser.** The sharp one. This app
  _imports_ browser bookmarks, so if our objects were bookmarks too, the import
  copy would read "import an HTML bookmarks file … bookmarks you already have are
  skipped" — theirs or ours? It reads "**links** you already have are skipped",
  and is unambiguous. The same collision is handled deliberately in
  `apps/bracemark-extension/wxt.config.ts`, where declaring Firefox's
  `bookmarksInfo` is rejected because it would tell users we read their bookmark
  _tree_. On that surface the word means the browser's tree; it cannot also mean
  ours.
- **"Link" is what the URL and the schema already say** — `/links`,
  `links/{id}.enc`, `LinkQuery`. An in-app noun matching the path in the address
  bar is consistency for free.

**The collection gets no noun at all — and "vault" and "library" are why that is
a rule.** The UI names **places** (My List, Archive, Trash, Show All); a user
files into a list and never addresses the whole, so there is no slot a container
word could fill. "Vault" is additionally barred by the paragraph above it: it is
a claim about how the product _feels_, in a product whose argument is that
feelings count for nothing beside mechanism. It appears once in the codebase, in
`KEYWORDS` in `listing-copy.ts` — which is a comma-list of search terms, not
prose, and outside this rule. "Library" is serviceable as a **mass noun in
prose** ("bring the library you already have", "someone with a large library")
and is not a label; promoting it to one is the same mistake as "vault".

**A disclosure is named for what is behind it, not for how hard it is.** The
quick-add form's second section reads **"List, tags & note"** — it was "Advanced",
which claimed a novice/expert axis the form does not have (filing a link into a
list is the most ordinary act here; URL is simply the required field and those
three are the optional ones). The word is right one screen over, on advanced
**search**, where a plain text box really does sit opposite the full query grammar.
Two constraints on any replacement: **"More options" is taken** — it is the topbar
overflow button's name in both clients — and **"Details" is spoken for**, by the
link detail view `/links/{id}` is reserved for. Naming the contents also follows
the rule above it: the concrete names beat a container word.
[editors.md](./editors.md) carries the rest.

⚠ **Nothing enforces any of this** — a `<Button>Add bookmark</Button>` type-checks
and lints clean. The check is this page. Related: the first-sync counter says
**"items"**, a third word for a third scope (`sync/status.ts` carries the
reasoning — it counts index blobs across six namespaces, not links), which is the
same instinct one level down and not an exception to the table.

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

**A network inspector is a third thing, and it sits inside the boundary.** Both
halves above are about the SOURCE — what a reader can read, and what reading
cannot settle. A browser's own network inspector is neither: it observes the
behaviour of the build that is actually running, which is precisely what the
source cannot speak to. So it is admissible, and /security carries it once
(_what this page does not prove_), as an OBSERVATION rather than a check that
anything matches anything. Three limits travel with it, and the sentence has to
hold all three at once:

- **It shows what a request contained, not what a key is doing.** Opaque request
  bodies are equally consistent with a key that never leaves and with one
  exfiltrated in a field nobody looked at. Nothing stronger than "you can watch
  your links leave as bytes nobody at our end can read" survives, which is why
  the words _verifiable_ and _transparent_ stay out of it — they are the
  vocabulary this boundary exists to refuse.
- ⚠ **Scope it to the library payload.** The same tab shows the username at
  sign-up, a session token and the R2 host, all readable and all inventoried in
  /privacy — plus the plaintext URL handed to `bracemark-extractor` by anyone who
  turned the `serverExtraction` opt-in on
  ([link-extraction.md](./link-extraction.md), _server extraction_). "Nothing
  readable leaves" is therefore false, and falsifiable in the one place we just
  sent the reader to look, which is the worst available way to lose the argument
  this page is making.
- **Name no tool and no request.** "Your browser's network inspector", never
  Chrome's DevTools: naming a vendor dates the copy and reads Chrome-first for a
  product with four clients. No endpoint, method or request shape either — those
  rot exactly the way a published cap does.

**Why AGPL and not MIT.** A hosted fork is the only real competitive risk, and
the AGPL's network clause is the one that addresses it: run a modified version as
a service, publish the modifications. It does not restrict a user, which is the
audience that matters here.

⚠ **The licence is stated in three places and they have disagreed once already.**
The root `LICENSE` file (AGPL-3.0), the root `package.json` `license` field, and
`SOURCE.license` in `packages/shared/src/brand/brand.ts`.
`package.json` said `MIT` against an AGPL `LICENSE` for the repo's whole first
stretch, which is not cosmetic: a reader may rely on either, and the permissive
one is the one they would rely on. `brand.spec.ts` pins the third copy;
the other two are on you.

**Where it is published, and why each.** The URL and licence come from `SOURCE`
in `brand/brand.ts`, beside `COMPANY`, for the same reason `COMPANY` is there.

| surface                             | what it says                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| marketing site footer, _Company_    | "Source code" — where a developer looks first, on every page |
| the landing page, _If we disappear_ | the repo linked inside the durability argument (below)       |
| /about, _See for yourself_          | the argument and the caveat, in prose, after "Who makes it"  |
| /about, the _Built with_ colophon   | `AGPL-3.0 · github.com/…` as a specimen line                 |
| /faq, privacy group, `source`       | the question as actually asked, before `security-report`     |
| /faq, privacy group, `self-hosting` | what it would actually take, at the end of the group         |
| /privacy, _Security_                | so the policy's claims can be read against the software      |
| Settings → About, both apps         | one row; the only one not pointing at the marketing site     |
| the repo's `README` and `SECURITY`  | the landing surface, and where to send a vulnerability       |

Deliberately **not** on the home page **hero**, and not in the store listings. In
a hero it reads as a developer-audience signal competing with the actual pitch; in
store copy it is a claim that can only be corrected by shipping a build through
review.

The landing page's _If we disappear_ band is the one place on that page it does
belong, and the distinction is the argument around it rather than the page it is
on. The band answers "why should I believe you will still be here", which the
repo is a real part of the answer to — the code outliving the company is a
property, not a promise — and it sits two thirds down, in the argued register,
where a reader has already been given the pitch. Note what the band does **not**
do: it makes no claim about verifying a served bundle, so the boundary above is
untouched. Its durability sentence, "The library does not need us to be
reachable in order to open", is only as true as [sessions.md](./sessions.md)
(nothing wipes) and [offline-mode.md](./offline-mode.md) (something can still
open it) make it. Its link also **carries the prose** — "a single GitHub repository",
not the bare URL beside it — because the two surfaces whose job is to print the
string rather than link it are the footer and /about's colophon, and setting a
40-character URL inside an argued paragraph spends a clause on it.

**The self-hoster is answered in two places, and the split is the point.** They
are the only audience that reads an AGPL notice and asks the obvious next
question, and the silence that used to meet them read as an oversight rather than
a position. The landing band carries the POSITION, in one clause — "we do not
support self-hosting today, but the code does not stop existing when a company
does" — and /faq `self-hosting` carries what it would actually take. The band used
to carry a reason too ("the apps we ship have our server's address compiled into
them"), and that is what moved: ⚠ **naming one obstacle reads as naming the only
one**, and it invites "then make it configurable" — a settings field would leave
both larger obstacles standing, since `bracemark-api` is a Worker wired to
Cloudflare's own D1 and R2, and the mobile and extension builds reach a user
through stores only we can publish to. A true subset presented as the whole is
the same failure the privacy claims were rewritten to avoid
([local-first-sync.md](./local-first-sync.md), _the shape of the problem_), so the FAQ answer names all three and the band names none. What the
FAQ answer must NOT become: a how-to (a half-followed attempt is a support thread
we have just declined to take), or a roadmap entry — "today" describes where
things stand, and this band makes no promises about our future.

### the generated pictures — the card and the store screenshots

**Eight committed PNGs the build reads, and none of them can be checked by
looking.** Four are the social card (`opengraph-image.png` + `twitter-image.png`
in `apps/bracemark-site/src/app/` and `apps/bracemark-web/src/app/`, 1200x630,
with an `.alt.txt` beside each); four are the PWA screenshots in
`apps/bracemark-web/public/` that `manifest.json` lists — `ss-narrow-1/2.png` and
`ss-wide-1/2.png`. They are **artifacts**: produced deliberately, out of the
build, committed, and governed by the contract below rather than by a generator
this repo runs.

⚠ **BOTH FAMILIES SHIPPED BRACE.TO v1 FOR THE PRODUCT'S WHOLE LIFE, AND NOTHING
SAID SO.** The card this repo shipped from `Initial commit` read "Save links to
visit later", named the _predecessor_ in its body copy, claimed "Powered by
Stacks technology", drew the old dotted-square mark, and carried **eleven
third-party wordmarks** — the same smear the hero panel refuses to draw even once
(`page.tsx`, the note above its preview slot, on the endorsement test). The eight
`ss-*.png` were the same picture with a caption on it, and they outlived the card
because this page said in as many words that they were "not brand assets and are
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
below is set in it); the mark changes; a `--color-*` token moves; the links list layout changes shape; the browser extension's popup changes
shape; or a screenshot shows a screen that no longer exists. Nothing else will
tell you — that list _is_ the tripwire, and for the store pictures further down it
is the _only_ thing there is, since those are not stamped.

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
two phone families are the current eight-asset deliverable. If an iPad family is
needed for submission, capture the same four jobs independently in the real iPad
layout at 2064x2752 rather than stretching phone art. The Play size is deliberate
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

### the X account — @bracemarkapp

**The handle is `@bracemarkapp`, and it is not the product name.** `@bracemark`
was already held by someone else when the account was registered, so the name
"Bracemark" appears only in the **display** name, which X owns and this repo
cannot pin. Everything below follows from that gap: no surface retypes the
handle, because a surface that retypes it is a surface that can be wrong about
which account belongs to us.

`SOCIAL` in [`packages/shared/src/brand/brand.ts`](../packages/shared/src/brand/brand.ts)
is the one definition — `handle` (the `@` form) and `url` — beside `COMPANY` and
`SOURCE`, for the reason those are there: more than one origin names it, and
bracemark-web cannot read the marketing site's config.

| surface                           | what it does                                                       |
| --------------------------------- | ------------------------------------------------------------------ |
| `twitter.site`, both root layouts | publishes the handle on every card that unfurls from either origin |
| marketing site footer, _Company_  | the handle as its own label, beside "Source code"                  |
| Settings → About, both apps       | the last row, after "Source code"; the handle as its title         |

⚠ **The failure is a handle that is WRONG, not one that is missing.** Both
layouts left `twitter.site` deliberately unset for the repo's whole first public
stretch, and the comment explaining why named the reason: the value it used to
hold was `@bracedotto`, **Brace.to's** handle, carried over from the predecessor.
A card carrying a stale `@` renders exactly as well as a correct one — no error,
no lint rule, no failing test — while crediting someone else's account to every
person who shares a page. `brand.spec.ts` pins the two halves against each other
(the URL must be the handle, and the handle must keep its `@`, which is what the
meta tag is specified to carry); it cannot pin that either one names an account
we still control.

**Why the footer link is labelled `@bracemarkapp` and not "X".** The letter alone
names nothing when read cold, and — per the paragraph above — the handle is not
derivable from the product name, so a visitor who intends to search for us rather
than click has to be able to read the string we actually hold. It is also the
only link on the marketing site pointing at a property we do not control, which
is why it sits under _Company_ with "Source code" (a fact about who builds this)
rather than under _Product_.

**In Settings → About it is the LAST row, under "Pages", after "Source code"**,
in both apps. Those two are the only rows in that group not pointing at the
marketing site, and they end the list in the footer's order for the footer's
reason: one is a fact about who builds this, the other is the only link on the
surface to a property we do not control. The row is titled with the handle and
described as _"Announcements and release notes, on X."_ — the description is
where "X" is allowed to appear, because by then the reader has the string. It
stops at announcements deliberately, two rows under "Support": see below.

**Not on `/support`.** That page opens _"One address, and a person on the other
end. No ticket queue, no chatbot, no phone tree."_ — a second channel on it makes
that line false, and a public reply is the wrong shape for a product whose
support questions carry usernames. Support is email; the account is for
announcements.
