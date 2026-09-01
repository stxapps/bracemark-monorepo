import Link from 'next/link';

import {
  APP_STORE_URL,
  BRAND,
  CHROME_WEB_STORE_URL,
  entitlementsOf,
  FIREFOX_ADDONS_URL,
  PLAN_LABELS,
  PLAN_USD_PER_YEAR,
  PLAY_STORE_URL,
  TRIAL_DAYS,
} from '@stxapps/shared';
import { AppStoreIcon } from '@stxapps/web-ui/components/icons/app-store-icon';
import { ChromeWebStoreIcon } from '@stxapps/web-ui/components/icons/chrome-web-store-icon';
import { FirefoxAddonsIcon } from '@stxapps/web-ui/components/icons/firefox-addons-icon';
import { PlayStoreIcon } from '@stxapps/web-ui/components/icons/play-store-icon';
import { HostMonogram } from '@stxapps/web-ui/components/links/host-monogram';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../components/glyphs';
import { CREATE_ACCOUNT_URL, SOURCE } from '../lib/site';

// Moved here from bracemark-web when the apex became this app. Two things changed
// with the move, both consequences of the site being a different origin from the app:
//   - the `AuthedHomeRedirect` that bounced signed-in visitors to /links is gone —
//     this origin has no session to read. bracemark-web's own `/` handles that now.
//   - every account CTA is a cross-origin <a> to app.bracemark.com, not a next/link.
//
// THE COPY RULE, the same one the pricing page follows: only promise what ships.
// Numbers — the free link cap, the Plus price, the trial length — are read from
// `@stxapps/shared` rather than typed, so this page can't quote a cap the app
// doesn't enforce.
//
// THE DESIGN, in one line: achromatic except for a single petrol accent
// (`text-signal`, defined in globals.css), because "the server can't read your
// library" is easier to feel on a page that shows almost nothing. (Not "the server
// sees nothing" — it sees your username and your plan; the copy on this page says
// so now, and the rationale should not keep the version the copy dropped.) The one thing it does show
// is the hero panel below.

const FREE_LINKS = entitlementsOf('free').maxLinks;

// --- the signature: what you see, and what we store ------------------------
// The whole product argument as one object. The top half is a bookmark the way
// the app renders it; the bottom half is everything that reaches our storage — a
// path, a size, a timestamp, and bytes. Illustrative rather than a screenshot,
// but not invented: `links/{id}.enc` is the real path shape (shared
// `sync/paths`), those three fields are exactly what /privacy inventories, and
// the server really does hold nothing else about a link.
//
// The residual metadata is stated in the panel's own closing lines rather than
// denied — see the note beside them. That is the single change here that a
// technically-inclined reader notices, and the one this panel most needed.
//
// Static, deliberately. An animated encrypt/decrypt toggle was the obvious move
// and it is the wrong one — it turns the product's central claim into a toy, and
// it would need a client component on an otherwise fully static export.
const CIPHERTEXT =
  'k7QpV0sZ4mL8xR1cGf9tYb2NwJ3hD6aE5uT0iO8pA1sD4fG7hJ2kL5nM8qR3tV6x' +
  'Z9yB2nM5kJ8hG1fD4sA7pO0iU3tE6rW9qY2xC5vB8nM1kL4jH7gF0dS3aP6oI9uY' +
  '2tR5eW8qA1zX4cV7bN0mK3jH6gF9dS2aP5oI8uY1tR4eW7qZ0xC3vB6nM9kJ2hG5';

// The specimen's host, and the one constant behind BOTH halves of its identity:
// the line under the title, and the monogram's letter and hue. `hueFromHost` is
// keyed on this exact display string (shared `url/host-identity`), so splitting
// them would let the tile drift from the host printed beside it — "same site,
// same mark" is the whole point of that tile, and this panel is where a visitor
// meets it first.
const SPECIMEN_HOST = 'askamanager.org';

// --- the one picture of the product ---------------------------------------
// There was no screenshot on any page of this site. The only depiction of a
// saved link was the hero panel, whose preview slot draws an identity tile
// rather than a cover — so the section headed "A private library is still a
// library" was proving a visual product with six lines of text, and a visitor
// who came for the wall of covers filled the gap with the one visual we had
// given them.
//
// Not next/image: `images.unoptimized` is on for the static export, so the
// component would add a wrapper and a dependency and emit the same <img>.
// Explicit `width`/`height` reserve the box so the band below it doesn't jump,
// and the frame crops with object-cover, so the real capture only has to be
// roughly 16:10.
//
// Not `next-image-export-optimizer` either, which is the usual answer to that
// first sentence and was declined deliberately — the trade is argued in
// `tools/scripts/make-image-variants.sh`, which is what we do instead: generate
// `<stem>-<width>.webp` once per asset, by hand, and commit the files. Three of
// them and a `srcSet` is less machinery than a custom loader, a build step that
// writes into `public/`, and two more runtime dependencies, for a site with one
// screenshot on it.
//
// TO REPLACE: capture at 2200px wide or more, then
//
//   tools/scripts/make-image-variants.sh <capture> \
//     apps/bracemark-site/public/screenshots/library-cards
//
// point `src` at `/screenshots/library-cards-1600.webp`, paste the `widths` the
// script prints, and delete `library-cards.svg` — a labelled placeholder, drawn
// to be obvious in production rather than to pass as the real thing.
const SCREENSHOT = {
  // What a browser loads if it ignores `srcSet` — and, while this is still the
  // vector placeholder, the whole of it.
  src: '/screenshots/library-cards.svg',
  // The variant path without its `-<width>.webp` suffix, and the widths that
  // exist on disk. Empty here because an SVG is resolution-independent: a
  // srcSet over one would be three descriptors pointing at the same file.
  stem: '/screenshots/library-cards',
  widths: [] as number[],
  // Width descriptors are only half the instruction. Without `sizes` the
  // browser assumes the image fills the viewport and over-fetches on every
  // phone; with it, the choice folds in layout width as well as pixel ratio,
  // which is the whole reason these are `w` descriptors and not `@1x`/`@2x`.
  // The values trace the figure's real box: the band's inner div is
  // `max-w-6xl` (1152px) inside `lg:px-8`, so 1088px is the cap, and below that
  // it is the viewport less that band's own gutter (`md:px-6` → 3rem total,
  // `px-4` → 2rem). Approximate is fine — the browser rounds up to the next
  // variant — which is why the `px-safe` insets are not modelled here.
  sizes: '(min-width: 1024px) 1088px, (min-width: 768px) calc(100vw - 3rem), calc(100vw - 2rem)',
  // Written for the capture this becomes, not for the placeholder: a screen
  // reader gets the same account of the product a sighted visitor does.
  alt: 'The card layout in Bracemark: a grid of saved links, each with its preview image, title and host, beside a sidebar of lists.',
  caption: 'The card layout. Previews come from the device that saved the link.',
};

// Undefined rather than an empty string while `widths` is empty, so the
// placeholder ships a plain <img> instead of an `srcSet=""` the browser has to
// parse and discard.
const SCREENSHOT_SRCSET =
  SCREENSHOT.widths.map((w) => `${SCREENSHOT.stem}-${w}.webp ${w}w`).join(', ') || undefined;

function HeroPanel() {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border bg-card shadow-sm')}>
      {/* Plaintext half — the only place the accent carries real content. The
          extra bottom padding keeps the tag row clear of the AES chip below. */}
      <div className={cn('p-5 pb-8 sm:p-6 sm:pb-9')}>
        <p className={cn('eyebrow text-signal')}>On your device</p>
        <div className={cn('mt-4 flex gap-3.5')}>
          {/* The preview slot, filled the way the library will really fill it
              for a link like this one: `HostMonogram`, the deterministic
              letter-on-hue tile that stands in wherever there is no extracted
              image — which on the free plan is most links, since previews come
              from the device that saved them. It was an empty accent-tinted
              block, defended as "a diagram, not a screenshot"; what it actually
              read as was a hole, in the one artefact a visitor studies, exactly
              where the product's own subject belongs.

              WHY THE MONOGRAM AND NOT A REAL PREVIEW IMAGE. This was tried with
              a genuine og:image and the answer is measurement, not taste: the
              slot is 64x40 and every social card is ~1200x630, so any of them
              centre-cropped in here is a colour swatch — a smear of somebody
              else's brand colour, sometimes landing a few degrees off
              `--color-signal` and reading as our own accent misprinted. The
              tile is a VECTOR sized to the box, so it is the one thing that
              stays legible at this size.

              THIS specimen's own og:image makes the case twice over, and it is
              the one thing here that is NOT a faithful drawing — a real
              browser-extension save of this link would show a picture, because
              the extension reads the live DOM and this page has an og:image.
              What that image IS: a 480x480 site-wide Ask a Manager logo card,
              the same one on every post, not art for this article. Cropped to
              16:10 it is a band of olive and orange with a third party's
              wordmark sliced through the middle — a smear by the measurement
              above, and by the endorsement test below (which is what rules out
              vendors and advocacy orgs) somebody else's mark in our hero. So
              the slot draws the FALLBACK deliberately, not this link's real
              preview. That is the same reason the browser
              extension's popup and the expo share sheet both END their fallback
              chains on it rather than beginning there.

              64x40, because this panel is a DRAWING of a real component and has
              to measure the same as it: bracemark-web's list row
              (`_layouts/list-layout.tsx`), bracemark-extension's popup specimen
              (`popup/PageSpecimen.tsx`) and bracemark-expo's share specimen all
              draw this object in an `h-10 w-16` slot. It was `size-11` here
              while two of those were square; they all moved together.

              `ratio` must match the slot's 16:10 and `rx={0}` because the slot
              already clips to `rounded` — host-monogram.tsx carries the contract
              for both, and holding either wrong fails softly (letterboxing, or a
              sliver of plate at each corner) rather than loudly. The ring is
              `border` now rather than the accent it used to be: the tile fills
              the box, so a petrol hairline around a hue field is the accent
              spent on nothing, and globals.css rations it to what is genuinely
              yours or genuinely on. */}
          <div
            className={cn(
              'mt-0.5 h-10 w-16 shrink-0 overflow-hidden rounded ring-1 ring-border ring-inset',
            )}
            aria-hidden="true"
          >
            <HostMonogram host={SPECIMEN_HOST} ratio={16 / 10} rx={0} className={cn('size-full')} />
          </div>
          <div className={cn('min-w-0')}>
            {/* NOT `text-body`, though it is the same 15px. This line is a
                SPECIMEN TITLE — the same string, size and leading as
                bracemark-extension's `popup/PageSpecimen.tsx` and
                bracemark-expo's `features/share/share-specimen.tsx`, which is
                what lets this panel claim to be a drawing of them. `text-body`
                is this site's prose pairing (15/28) and would set it on a
                28px line; the specimen is `leading-snug` in all three ports.
                Two roles, one size, and only the prose one has a token.

                A REAL ARTICLE, and two separate repairs got it here. The first
                pass invented "Local-first sync: the hard parts" on
                martin.kleppmann.com — a real person's real domain, no such piece
                on it — so the panel a visitor is invited to study opened with a
                false citation. The replacement was real and wrong a second way:
                a paper on Bloom filters and hash-graph sync, tagged
                `crdt`/`offline`/`databases`, is a link about OUR OWN machinery,
                it cast the fictional user as a distributed-systems engineer, and
                it argued against the hero paragraph beside it — nobody needs a
                public CS paper encrypted.

                WHAT THE SLOT WANTS: a link that implies an ACT, not a TASTE.
                Taste says what kind of person you are; an act says what you are
                about to do, and the hero's "a fairly complete picture of what
                you are reading, buying, worrying about and working on" is a
                claim about circumstances. Interview prep is something you are
                doing on Thursday and have not told your manager about —
                ordinary, non-medical, and still nobody's business. Sensitive
                specimens (illness, debt) were considered and declined twice
                over: they argue by making the reader anxious, which is the
                privacy-by-fear register this brand refuses, and they trade the
                AGGREGATE claim for a weaker "some links are secrets" that has an
                easy exit — then I won't save those here.

                It must stay somebody's ACTUAL INTEREST and not a link about us.
                A page about privacy or tracking in this slot makes the panel
                self-referential — the product demonstrating itself with a link
                to its own pitch — and an advocacy org's page reads as an
                endorsement we do not have. So does a VENDOR, which is what rules
                out the topic that scores highest on everything above: every
                therapy candidate sits on a host selling therapy.

                THE LOWERCASE IS THEIRS. Ask a Manager styles every headline
                lowercase; this is the title as published, minus the
                " - Ask a Manager" suffix a person trims. Sentence-casing it
                falsifies the citation, which is the one thing this slot has
                already been wrong about once. Re-verifying it does NOT work from
                an ordinary shell: the zone answers Cloudflare's interstitial with
                a 403 to curl and to any server-side fetcher off Cloudflare, so a
                script reads as though the page were gone. Two routes that do
                work — `bracemark-extractor`, which is itself a Worker and gets a
                200 out of the same zone (POST /v1/extract on
                extractor.bracemark.com), and the Wayback `id_` snapshot, which
                serves the raw markup. Don't record the 403 as the page's own
                verdict: our extractor reads this URL fine.

                THE APOSTROPHE IS `’` ON PURPOSE, and the page publishes it BOTH
                ways — the rendered headline (`.entry-title`) carries `&#8217;`,
                while `<title>` and `og:title` carry `&#039;`, so an extraction
                (and the extension's `document.title`) yields the straight one.
                This slot quotes the HEADLINE a reader sees, not the metadata,
                and the root eslint.config.mjs `no-restricted-syntax` rule
                requires `’` in JSXText regardless — matching the extractor byte
                for byte would need a disable comment for no gain, and the string
                is already a drawing rather than a capture (the suffix above is
                trimmed the way a person trims it). */}
            <p className={cn('text-[0.9375rem] leading-snug font-medium')}>
              here’s a step-by-step guide to preparing for a job interview
            </p>
            <p className={cn('mt-1 font-mono text-xs text-muted-foreground')}>{SPECIMEN_HOST}</p>
            <div className={cn('mt-2.5 flex flex-wrap gap-1.5')}>
              {/* No `Reading list` here any more. Two words of set dressing were
                  advertising a category this product deliberately isn't in — a
                  read-it-later app — and they were doing it in the one artefact a
                  visitor studies. Plain topical tags make the same point about
                  what a tag IS without steering the category.

                  `thursday` is not topical, and it is the reason the row is here
                  at all. Tags are the one part of a saved link the USER writes,
                  so a day in among them is more revealing than the headline above
                  it: two topic words and a date, and the reader assembles an
                  interview on Thursday out of parts, none of which is a secret.
                  That is the hero paragraph's argument — a picture, not a
                  confession — drawn rather than asserted. Single words, like
                  every other tag specimen in the repo; nothing enforces it. */}
              {['work', 'interview', 'thursday'].map((tag) => (
                <span
                  key={tag}
                  className={cn(
                    'rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground',
                  )}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* The seam. The chip names the mechanism rather than describing it. */}
      <div className={cn('relative border-t border-border')}>
        <span
          className={cn(
            'absolute -top-2.5 left-5 rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[0.625rem] tracking-wider text-muted-foreground uppercase sm:left-6',
          )}
        >
          AES-256-GCM
        </span>
      </div>

      {/* Ciphertext half — inverted, because this is the side we live on. */}
      <div className={cn('bg-foreground px-5 pt-7 pb-6 text-background sm:px-6')}>
        <p className={cn('eyebrow text-background/60')}>What our servers store</p>
        <div className={cn('mt-4 flex items-baseline justify-between gap-4 font-mono text-xs')}>
          <span className={cn('truncate')}>links/01JD7QK2X8N4WYB3F0.enc</span>
          <span className={cn('shrink-0 text-background/50')}>2.1 KB</span>
        </div>
        {/* The third field, and the reason this panel is now truthful. /privacy
            has always said we hold the path, the size AND when the file last
            changed; the panel showed two of the three and the caption then
            claimed there was nothing else there. A reader who can do the
            arithmetic — one file per link, so the file count IS the link count,
            and the timestamps are an activity log — caught it every time, and
            an overclaim in the one place we ask to be checked costs more than
            the fact does. Relative rather than a date: an illustration with a
            hard-coded 2026 stamp reads as abandoned by 2028. */}
        <p className={cn('mt-1 font-mono text-xs text-background/50')}>
          last changed 2 minutes ago
        </p>
        <p
          className={cn(
            'mt-3 font-mono text-[0.6875rem] leading-5 break-all text-background/45 select-all',
          )}
        >
          {CIPHERTEXT}
        </p>
        {/* "no key to open", not the compressed "no key for". The clause is
            the panel's whole payoff — the hero paragraph beside it has just
            said the key is derived from your password on the device, and this
            is where that lands — but stranded on "for" it asks the reader to
            invert it themselves, and the one who doesn't reads four nouns with
            no claim attached. Completing the verb is how the idiom is spelled
            everywhere else it appears (the footer's "no key that opens it",
            /about, /privacy, the FAQ). Keep the INABILITY: "bytes we must hold
            to operate" and its kin describe the path, the size and the
            timestamp equally well, so they say nothing about this fourth item
            and quietly drop the only sentence on the page that R2's
            ciphertext-only guarantee actually earns us
            (docs/brand-assets.md, _the voice_ — mechanical). */}
        <p className={cn('mt-5 text-sm leading-6 text-background/70')}>
          A path, a size, a timestamp, and bytes we hold no key to open. Not the title, not the
          address, not the tags — there is nowhere for them to be.
        </p>
        {/* Named by us, in one clause, rather than left for a reader to derive
            and then distrust us for omitting. It is the cheapest credibility on
            the page: the truthful version is more impressive than the
            overclaim, because a team that volunteers its own residual leak is
            one you can believe about the leaks you cannot see. */}
        {/* Same weight as the line above it, not a dimmer footnote. `/50` on
            this ground is roughly 4.4:1 — under AA for body text — and dimming
            it would stage the concession as fine print, which is the exact move
            this paragraph exists to refuse. It is the caption's second half,
            so it is set as the caption's second half. */}
        <p className={cn('mt-3 text-sm leading-6 text-background/70')}>
          What that shape still tells us: how many files you keep and when they change. It is the
          whole of what we can infer, and we would rather say it than have you work it out.
        </p>
      </div>
    </div>
  );
}

// --- band scaffolding ------------------------------------------------------
// Sections are separated by a full-width hairline and named by a mono eyebrow.
// One component, so the rhythm is set once instead of re-spaced per section.
//
// `px-safe` on the <section> and the numeric gutter on the inner div: the tint
// reaches the physical edge, the type stays clear of a landscape notch. Every
// full-bleed section on this page is built this way (docs/safe-area.md).
function Band({
  label,
  title,
  lede,
  children,
  className,
}: {
  label: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('band px-safe', className)}>
      <div className={cn('mx-auto max-w-6xl px-4 py-20 md:px-6 md:py-24 lg:px-8')}>
        <p className={cn('eyebrow')}>{label}</p>
        <h2
          className={cn(
            'mt-4 max-w-2xl font-display text-3xl leading-[1.1] font-semibold tracking-tight text-balance md:text-4xl',
          )}
        >
          {title}
        </h2>
        {lede && (
          <p className={cn('mt-4 max-w-xl text-lg leading-8 text-muted-foreground')}>{lede}</p>
        )}
        <div className={cn('mt-12')}>{children}</div>
      </div>
    </section>
  );
}

// --- the capture surfaces --------------------------------------------------
// Ordered by how good the extraction is, which is also the order we want people
// to adopt them in: the extension and the phone read the page the device is
// already holding, so the preview comes from the user's own browser and free
// accounts get it (docs/link-extraction.md, _who extracts_). The web app can't —
// CORS — which is the honest reason server extraction is a Plus opt-in.
const CAPTURE = [
  {
    name: 'Browser extension',
    where: 'Chrome · Firefox',
    // "One click" was false, not merely loose. The toolbar action opens the
    // popup; `entrypoints/popup/Editor.tsx` then requires an explicit Save, and
    // there is no shortcut past it — bracemark-extension registers no
    // `commands`, no `contextMenus` and no `action.onClicked`, so two clicks is
    // the floor on every path. The claim does not need inflating: two clicks
    // with NOTHING to type, on a preview the browser already has, is the best of
    // the four, and a reader can check this one against their own toolbar in
    // about four seconds. Same correction in packages/shared/src/stores/
    // listing-copy.ts, which shipped it to both extension stores.
    body: 'Click the icon on the tab you are already reading, then Save. The extension takes the title and preview image from your own browser, so nothing has to fetch the page on your behalf.',
  },
  {
    name: 'Phone and tablet',
    where: 'iOS · Android',
    // NOT "same capture" as the extension card above it. The share sheet gets what
    // the SHARING APP hands over — a URL and whatever title it chose to attach —
    // and nothing else: it cannot read the page, because it is not the browser
    // showing it (docs/link-extraction.md, _capability tiers_: title+image is
    // ⚠ host-provided there, and read mode, screenshot and page copy are all ❌).
    // The real fetch happens later, in the app's own foreground drain. The
    // encryption half WAS accurate and stays: the save is written and sealed on
    // the handset at the moment you share.
    //
    // The three examples are all one part of speech on purpose — a KIND OF APP,
    // not a situation. "A group chat" sat here and was the odd one out; "a social
    // app" is the same shape as the two beside it and covers where a shared link
    // actually comes from. "Itself" is load-bearing and not a filler word: the
    // app does that fetch, NOT our server, which is the entire difference between
    // this card and the web-app card next to it.
    body: 'Share into Bracemark from any app — a browser, a podcast player, a social app. It saves what that app hands over, sealed on the handset before it syncs. The app fills in the title and preview image itself the next time you open it.',
  },
  {
    name: 'The web app',
    where: 'Any browser',
    // "Won’t let a web page fetch another site" is the FAQ's wording verbatim
    // (content/faq.tsx, `no-title-image`) — the same fact is stated on two
    // surfaces and they now read as one voice. Keep the actor as the web PAGE:
    // the same-origin policy binds the document running in the browser, not
    // sites, and a server fetching another site is exactly what the rest of the
    // sentence sells (docs/link-extraction.md, _server extraction_) — so
    // "a web site can't fetch another web site" would refute its own next clause.
    body: `Paste a URL and it is saved. Browsers won’t let a web page fetch another site, so previews for web saves are the one thing that needs a server — opt-in, on ${PLAN_LABELS.plus}.`,
  },
  {
    name: 'Import',
    where: 'One file',
    // The over-cap sentence is the answer to the question this card raises and
    // the free tier contradicts — a library bigger than the cap was the one
    // thing the invitation didn't cover. It offers the two answers rather than
    // narrating the gate that asks for them (docs/data-lifecycle.md, _the
    // import's quota gate_): the imperative pair IS the ask, so spelling out
    // "it counts them first and asks" described what the next clause already
    // demonstrated, and cost the card a fifth line — which the 2-col grid spends
    // as dead space under the web-app card beside it, since a row stretches to
    // its taller cell. What the cut gives up is "nothing is written until you
    // answer"; the second person keeps the user as the one choosing, so it still
    // reads as a route and not a wall.
    //
    // No sentence about the file staying local, deliberately. "It is read on your
    // device, so the file never uploads" was true of the .html/.csv and
    // misleading about everything the reader cares about — the LINKS in it sync
    // like any other save, so the line reads as a promise the next device
    // immediately falsifies (docs/brand-assets.md — a narrow true claim that
    // sounds like precision is the expensive kind). The band's lede already
    // covers the real fact for every surface including this one: encrypted on
    // the device before it syncs.
    body: `Bring the library you already have: a browser bookmarks export, a Raindrop CSV, or a plain list of URLs. Bringing more than ${FREE_LINKS} links? Take the first ${FREE_LINKS} now, or start the ${TRIAL_DAYS}-day trial and bring it all.`,
  },
];

// What the library does once things are in it. Deliberately unglamorous — these
// are the daily-loop basics, and every one is free.
// The Plus levers get one honest footnote instead of four asterisks.
//
// Lists, tags and pins are ONE entry because they are one idea — where a link
// sits: which list it is filed in, what it is labelled, and what is held at the
// top. That is the grouping /pricing's comparison row already ships ("Lists,
// tags, pins, notes & layouts"), so the two surfaces now cut the concept the same
// way. It is a merge rather than a trim for a second reason: seven entries
// orphaned a card on the last row at BOTH breakpoints — 2+2+2+1 at sm, 3+3+1 at
// lg — and six is the only count near it that fills each grid exactly.
//
// Notes stays its own entry and must not be folded into either neighbour: it is
// the one line in this band that makes a per-feature encryption claim, and it is
// content the user writes rather than a place they file into.
//
// What the merge cost, stated because the next person to reorder this needs it.
// The old comment justified the order by keeping Notes two rows clear of Search,
// since BASIC search matches the URL and the title only (`textMatches`, web-react
// data/queries.ts) — reaching a note takes the Plus editor's "Note contains" field
// (docs/search.md), a paid rung with no business widening a free-tier list. At six
// cells that separation no longer exists: nothing is more than one cell from
// anything, and the order below buys only that the two never share a row. So
// Search's own wording is now the whole of the guard — "Across titles, addresses
// and hosts" is the sentence that stops a reader assuming their notes are in
// there, and it has to stay exactly that literal.
const LIBRARY: [string, string][] = [
  [
    'Lists, tags and pins',
    'Save a link to a list, tag it, and find it later. Pin a few of them to the top.',
  ],
  [
    'Notes',
    `A line to yourself, whatever you want in it — encrypted, and searchable with ${PLAN_LABELS.plus}.`,
  ],
  [
    'Card and list layouts',
    'A wall of preview images, or a dense list. Choose one per device, if you like.',
  ],
  [
    'Search',
    `Across titles, addresses and hosts, every link. The ${PLAN_LABELS.plus} editor adds more fields.`,
  ],
  // The old line was true and quietly left out the half a switcher cares about:
  // a link no device fetched gets nothing. Until now that fact existed on one
  // surface, as the word "Opt-in" in a /pricing table cell — and for anyone
  // arriving with a library to import it is the single biggest practical
  // difference between what they have and what they would get. The trade band
  // below argues it at length; this is the bullet a scanner actually reads, so
  // it names the two cases and stops.
  [
    'Previews',
    `Titles and images, pulled by the device that saved it. Web saves and imports need ${PLAN_LABELS.plus}.`,
  ],
  // "In formats other apps read" appeared three times across the site and never
  // named one, which reads exactly like a company that doesn't export well. The
  // count and the round-trip claim go here; the four format names go in the
  // durability band below, where the export is load-bearing rather than a
  // feature bullet, so the list is stated once.
  ['Export', 'Four formats, one a complete backup that restores everything. Free on every plan.'],
];

// --- the trade -------------------------------------------------------------
// The comparison question was answered well and answered four clicks away:
// `content/faq.tsx`'s product group asks "How is this different from Raindrop,
// Pocket or my browser's bookmarks?" and a visitor deciding between them never
// gets there. The page's only acknowledgement that the competition exists was
// two words inside the Import card ("a Raindrop CSV"), which is also the single
// detail a switcher is most likely to notice — naming somebody's actual file
// format is how you say "we thought about you".
//
// Three decisions, none of them cosmetic:
//
// NO FEATURE TABLE WITH BRAND COLUMNS. A checkmark grid against named products
// is wrong out of the gate and wronger every release: it dates the moment either
// side ships anything, it invites a trademark conversation with nothing to gain,
// and it is the opposite of the register the FAQ answer sets ("most of them mean
// well"). The brands are named ONCE, in prose, in the lede. The grid underneath
// argues the CATEGORY — a hosted manager, any of them — which is the honest unit
// anyway, since the trade is identical whichever one you are leaving.
//
// THE LEFT COLUMN IS GENEROUS ON PURPOSE. Each row says WHY a hosted manager can
// do the thing — their server can read your library, so of course search runs
// there. Stated as carelessness it would be false, and the whole page loses if
// this band reads as a swipe: a reader who catches us being unfair about a
// competitor has no reason to trust us about ourselves.
//
// EVERY ROW IS A REAL LOSS, WORST FIRST. Nothing goes in here that we win
// outright. That argument belongs to the claim band immediately below, and it
// lands harder for following an honest tally than for replacing one.
const TRADE: { aspect: string; hosted: string; ours: string }[] = [
  {
    aspect: 'Search',
    hosted:
      'Runs on their servers, over your titles and addresses in readable form. That is what makes it possible.',
    ours: 'Runs on your device, across titles, addresses and hosts — every link, on every plan, with no index of your library anywhere else.',
  },
  {
    aspect: 'Previews',
    hosted: 'Their servers fetch every page you save, and keep what they find.',
    ours: `The device that saved the link pulls the title and image, so nothing fetches the page on your behalf. The links no device fetched — imports, and saves made in the web app — need a server, and that is the one opt-in ${PLAN_LABELS.plus} feature.`,
  },
  {
    // The row that does a second job. The no-reset fact and its answer used to
    // sit five sections apart — the cost in the claim band, the recovery code
    // only in the closer — and the link out of the claim band sent a worried
    // reader off the page to calm down. Here they arrive in the same sentence,
    // early and plainly, which lets the claim band keep the starker version as a
    // deliberate reprise rather than as the first time anyone hears it.
    aspect: 'A forgotten password',
    hosted: 'They can mail you a reset, because they can read the library either way.',
    ours: 'Your recovery code opens the account instead. It is generated at signup beside the passphrase, and it is the only other way in — there is no third one we could open for you.',
  },
];

const GUARANTEES: [string, string][] = [
  [
    'Your key',
    'Derived from your password on your device, with Argon2id. The password never leaves the device, and neither does the key it unlocks.',
  ],
  // The same repair as the hero panel's caption, in the same voice, because the
  // same reader checks both: "it cannot index your library" is the one claim in
  // this section a knowledgeable visitor can falsify, and the falsification is
  // trivial — one file per link means the file count is the link count. Naming
  // the residual ourselves converts the section's only soft spot into its
  // strongest move, in front of the people most likely to check and most likely
  // to tell others what they found.
  // Second pass, same argument one step further out. The entry already conceded
  // the residual it leaks about the LIBRARY (file count, change times). What it
  // still implied by omission was that the library is all we hold — "that is the
  // end of the list" under a heading reading `Our blindness` invites exactly that
  // total reading, and it is wrong: `bracemark-api` is one Worker over a username
  // directory, an accounts shard, a sessions DB and a purchases table, so the
  // same host that cannot read a link can read your name and whether you pay.
  // /privacy and the FAQ have always said so; this section, which is the loudest
  // claim on the property, did not. Naming it here costs a clause and closes the
  // gap between our proudest surface and our most careful one.
  //
  // "The sync server" is deliberately gone with it: there is no separate sync
  // server to name, and inventing one to carry a narrower claim is the move this
  // section exists to refuse.
  //
  // Third pass, and the one that retires "that is the end of the list". The entry
  // had conceded the residual about the LIBRARY and then named TWO of the account
  // fields — username and subscription — under a sentence claiming the enumeration
  // was complete. It is not: `bracemark-api` also holds the PUBLIC KEY a sign-in
  // signature is checked against and a SESSIONS row per signed-in device
  // (apps/bracemark-api/wrangler.jsonc; /privacy has always inventoried both). A
  // reader who opens the policy this page sends them to finds two fields the
  // loudest claim on the property said were not there, which costs more than
  // either field does. The closing sentence now points AT that inventory instead
  // of standing in for it — a list we can be wrong about is replaced by an address
  // where the whole list lives.
  [
    'Our blindness',
    'For each thing you save we hold a path, a size, a timestamp and an encrypted blob — we cannot index your library, search it, or hand it to anyone in a readable form. What we can read is the account around it: your username, the public key your sign-ins are checked against, the sessions that keep your devices signed in, and your subscription if you buy one. The privacy policy inventories every field of it.',
  ],
  [
    'Your exit',
    'Export everything, in open formats, on every plan, forever. Charging you to leave would defeat the point of building it this way.',
  ],
];

// --- what happens if we stop ------------------------------------------------
// "Why should I believe you'll still be here in two years" was the objection
// that stalled every reader who liked the pitch, and the site had no answer on
// it — the parts of one were scattered across three pages and a footer, and
// readers who cared enough assembled it themselves and then noted that we never
// had. It is worth a band of its own because it is not a promise we could make
// even if we wanted to: it is three properties of the build, and properties can
// be checked in a way intentions cannot.
//
// The three are ordered by how little they depend on us — the device copy needs
// nothing from us at all, the export needs the app to run once more, the source
// needs only that GitHub outlive us.
//
// The self-hosting sentence is here because an AGPL repository containing the
// sync server raises exactly one question from the only audience that reads
// AGPL notices, and saying nothing reads as an oversight rather than a
// position. "Not configurable" is a fact about the build, not a policy: the API
// origin is baked at build time (see lib/site.ts), so a shipped client cannot
// be pointed anywhere else.
//
// Two rules from docs/brand-assets.md, _the source_, that this band is written
// against:
//   - THE CLAIM BOUNDARY. The code being public means it can be READ, and that
//     it outlives us. It does not mean a visitor can verify the bundle they
//     were served — there is no reproducible build — and no line here implies
//     it.
//   - THE PLACEMENT. "Not the home page hero" still holds, and this is not the
//     hero: in a hero the repo reads as a developer-audience signal competing
//     with the pitch, which is the objection, and none of it applies to an
//     argued band two thirds down whose subject is what survives us. The
//     placement table in that doc now carries this row.
const DURABILITY: [string, React.ReactNode][] = [
  [
    'It is already on your device',
    'Bracemark is local-first: the copy you open, search and edit is held on the machine in front of you, and syncing is how your other devices catch up. The library does not need us to be reachable in order to open.',
  ],
  [
    'Export is free, on every plan',
    'Four formats — a complete backup that restores everything, a browser bookmarks file, a CSV, and a plain list of URLs. Charging you to leave would undo the point of building it this way, so we never will.',
  ],
  [
    'The code is public',
    // Linked, not just named. The audience this entry is written for reads AGPL
    // notices and then goes looking for the repository; sending them to the
    // footer to find it is most of the way to saying nothing. This is the first
    // time the repo appears on the landing page and the placement is deliberate
    // — see the note above DURABILITY for why the band, and not the hero, is
    // where it belongs.
    <>
      Both apps, the browser extension, the server they sync to and the one that fetches link
      previews are a single repository under the {SOURCE.license}:{' '}
      <a
        className={cn(
          'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
        )}
        href={SOURCE.url}
        rel="noreferrer"
      >
        {SOURCE.label}
      </a>
      . We do not support self-hosting today — the apps we ship have our server’s address compiled
      into them — but the code does not stop existing when a company does.
    </>,
  ],
];

const STORES = [
  { href: PLAY_STORE_URL, label: 'Google Play', Icon: PlayStoreIcon, width: 'w-6' },
  { href: APP_STORE_URL, label: 'App Store', Icon: AppStoreIcon, width: 'w-6' },
  { href: CHROME_WEB_STORE_URL, label: 'Chrome Web Store', Icon: ChromeWebStoreIcon, width: 'w-6' },
  { href: FIREFOX_ADDONS_URL, label: 'Firefox Add-ons', Icon: FirefoxAddonsIcon, width: 'w-7' },
];

export default function Page() {
  return (
    <>
      {/* --- hero --------------------------------------------------------
          The hero has no background of its own, so unlike the bands below it
          gains nothing from bleeding — the wrapper exists purely because
          `px-safe` and the section's own `px-4` are the same two longhands and
          cannot share an element (docs/safe-area.md). */}
      <div className={cn('px-safe')}>
        <section className={cn('mx-auto max-w-6xl px-4 pt-16 pb-20 md:px-6 md:pt-24 lg:px-8')}>
          <div className={cn('grid items-center gap-14 lg:grid-cols-12 lg:gap-16')}>
            <div className={cn('lg:col-span-7')}>
              <p className={cn('eyebrow')}>End-to-end encrypted · Local-first</p>
              <h1
                className={cn(
                  'mt-5 font-display text-[2.75rem] leading-[0.98] font-semibold tracking-tight text-balance sm:text-6xl lg:text-[4.25rem]',
                )}
              >
                {BRAND.tagline}.
              </h1>
              {/* Three deliberate changes from the noun list this replaced, all
                  of them the same sentence doing more work:

                  - It opens with the STAKES rather than the feature. "A fairly
                    complete picture of what you are reading, buying, worrying
                    about and working on" is the one line on the property that
                    describes the reader's situation instead of the product's
                    architecture, and it was stranded on /about, which is not in
                    the nav. The hero explained beautifully HOW we can't read
                    your links and never said why a list of them is worth
                    protecting.
                  - It no longer states a RETRIEVAL BOUNDARY, and that removal is
                    the deliberate part. "Keeps the addresses, not copies of the
                    pages" was true when it was written, but it is a PROMISE
                    rather than a description: read mode, screenshot and page
                    copy are all planned (docs/link-extraction.md, _capability
                    tiers_; /pricing's note on the unpublished byte quota says
                    the same), and the day the first of them ships this sentence
                    is false above the fold. Withdrawing a negative promise costs
                    more than never having made it, so the same clause came out
                    of /about, /terms and the FAQ's offline answer in this change
                    — it was standing in four places at once. What replaces it is
                    the ENCRYPTION inventory, which is true now and stays true
                    when page copy lands: a `files/{id}.enc` blob is encrypted
                    exactly like the address beside it.
                    The cost, stated because it is real: the hero no longer
                    disqualifies a read-it-later reader in ten seconds. That job
                    falls to the capture and trade bands, which describe what a
                    save actually captures — a weaker signal, and the right trade
                    against publishing a boundary we intend to move.
                  - "A key derived from your password", not "a key only you can
                    derive". The old phrasing is false as written — anyone
                    holding the password derives it, which is the entire point
                    of the recovery-code paragraphs further down.

                  WHY "THAT KEY NEVER REACHES US" EARNS ITS FOUR WORDS, and why
                  nothing longer belongs here. The outcome a reader wants — only
                  you can open it — is already the h1 above in `lg:text-[4.25rem]`
                  ("can’t read your bookmarks") and the panel beside it at
                  `lg:col-span-5` ("bytes we hold no key to open"), both in the
                  same viewport on desktop. So this sentence must not RESTATE the
                  outcome; it adds the one fact neither of those carries, which is
                  where the key isn’t (/terms says the same: neither the password
                  nor the key it produces is ever sent to us). A fuller version —
                  "only you hold the key, only you can decrypt, we never touch it"
                  — says the same thing a fourth time in the weakest type of the
                  four, and drifts back toward the "only you can derive" overclaim
                  retired directly above.

                  KEEP "undo". "A thing we can’t turn back into text" was the
                  considered alternative and is worse on three counts: the
                  antecedent of "a thing" is the ENCRYPTION, which is what you
                  can’t undo, whereas only CIPHERTEXT can be turned back into
                  text — so the two halves of the dash stop sharing a referent;
                  "text" understates a payload that is also images, screenshots
                  and page copy (`files/{id}.enc`); and the balance is the point,
                  because these two clauses are `BRAND.slogan` compressed ("We
                  don’t promise not to look. We built it so we can’t."), where
                  "undo" is what mirrors "can’t". The ambiguity it was meant to
                  fix — "undo" as reverse-a-decision rather than reverse-the-
                  encryption — is what the new third sentence already settles, by
                  putting the reader on keys one clause earlier. */}
              <p className={cn('mt-6 max-w-xl text-lg leading-8 text-muted-foreground')}>
                What you save is a fairly complete picture of what you are reading, buying, worrying
                about and working on. Bracemark encrypts every part of it on your device before it
                syncs — the address, the title, the tags, whatever you write about it — with a key
                derived from your password. That key never reaches us. Not a promise we make — a
                thing we can’t undo.
              </p>

              <div className={cn('mt-9 flex flex-wrap items-center gap-3')}>
                <Button asChild size="lg">
                  <a href={CREATE_ACCOUNT_URL}>
                    Create your account
                    <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
                  </a>
                </Button>
                <Button asChild size="lg" variant="ghost">
                  <Link href="/pricing">See pricing</Link>
                </Button>
              </div>

              {/* Two doors, twice over, and both halves are repairs.

                  The offer half: the page courted the switcher in the Import
                  card and then addressed nobody but the empty-handed everywhere
                  else. "Start empty, or bring the library you already have" is
                  now the shape of both this line and the closer, so the two
                  ends of the scroll say the same thing.

                  The account half: "no email address" is framed as a gift and
                  reads as the announcement that there is no safety net. The
                  mechanism stays — it is the honest reason — but the railing
                  now arrives in the same breath as the cliff rather than four
                  sections later in grey. The recovery code is named here, in
                  the claim block's footnote and in the closer; those are the
                  three places that used to state the risk with only one of the
                  two secrets in view. */}
              <p className={cn('mt-5 max-w-md text-sm leading-6 text-muted-foreground')}>
                Free for your first {FREE_LINKS} links — start empty, or bring the library you
                already have. No card, and no email address, because the account has nowhere to put
                one: the two doors into it are your password and a recovery code, and you save both
                at sign-up.
              </p>

              <div className={cn('mt-10 flex items-center gap-5')}>
                <span className={cn('eyebrow')}>Also on</span>
                <ul className={cn('flex items-end gap-4')}>
                  {STORES.map(({ href, label, Icon, width }) => (
                    <li key={label}>
                      {/* Desaturated at rest, true colour on hover. Three brand
                          marks in full colour are the loudest thing on an
                          otherwise achromatic page, and they are recognised by
                          silhouette anyway — the colour is there when a hand is
                          actually on them.

                          THREE, not four, and `AppStoreIcon` is why the row
                          needs `text-muted-foreground` as well as the filter. It
                          is the Apple mark drawn in `currentColor` + white — the
                          only one of the four with no brand colour to
                          desaturate — so `grayscale` is a NO-OP on it and it
                          renders at whatever the page's ink is. Measured on the
                          rendered row (mean luminance of each mark's own ink,
                          0–255): Play 162, Chrome Web Store 181, Firefox 139,
                          and Apple 18. Eight times the depth of its neighbours,
                          over twice their ink coverage, and in dark mode the
                          same fault inverted — the three brand marks desaturate
                          to a fixed grey that does NOT move with the theme
                          (135/157/179 there, unchanged), while an Apple mark on
                          `--foreground` swings to 242 and is the brightest thing
                          in the row. `text-muted-foreground` lands it at 116
                          light / 177 dark, inside the band at both ends, and
                          `hover:text-foreground` gives it the same resolve-on-
                          hover the other three get from `grayscale-0`. Nothing
                          else in the row reads `currentColor`, so a colour on
                          the shared anchor reaches this mark and only this mark.

                          IT IS NOT A "COMING SOON" GREY, and it must not become
                          one. The resting state used to stack `opacity-80` on
                          top of the filter; desaturated AND dimmed is the pair
                          that reads disabled, so the opacity is gone. Opacity is
                          also the wrong instrument for the Apple mark
                          specifically — `opacity-80` on it measures 65, still
                          twice the depth of the darkest neighbour, and the
                          amount that WOULD match differs per theme because the
                          value it is fading from does. Set the colour, not the
                          alpha. Whatever this row says about availability should
                          be said in words.

                          The colour ELSEWHERE on the page is not an
                          inconsistency to reconcile with this: the hero panel's
                          monogram is a hue field (askamanager.org hashes to 107,
                          a green) and the capture below the library band will be
                          a wall of real previews. Both sit INSIDE a bordered
                          frame and are the product's own content — someone
                          else's site, drawn as the app draws it. This row is
                          page chrome on the bare ground, four inches under the
                          primary CTA. Colour that is depicted is not colour that
                          is spent, which is the line globals.css rations the
                          petrol accent along too.

                          The hover reveal is MOUSE-ONLY by construction and that
                          is accepted, not a bug to fix: Tailwind v4 compiles
                          `hover:` inside `@media (hover: hover)`, so a phone
                          never fires it, not even on tap. A `pointer-coarse:`
                          escape hatch exists and is declined — it would hand the
                          three-in-colour-plus-black-Apple row to exactly the
                          visitors who cannot see it resolve on hover.
                          `focus-visible` gets the reveal as well as the ring, so
                          a keyboard reaches the same state a pointer does. */}
                      <a
                        className={cn(
                          'block rounded-sm text-muted-foreground grayscale transition duration-200 hover:text-foreground hover:grayscale-0 focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:grayscale-0 focus-visible:outline-none',
                        )}
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon className={cn(width)} aria-label={label} />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* The width cap sits here rather than on HeroPanel's own root,
                because below `lg` this grid is a single column and the panel
                would stretch to the full 1088px band — twice the size the same
                drawing is at `lg`, where `col-span-5` puts it at about 416px.
                `max-w-md` is the nearest token to that, so it reads at roughly
                one size across the whole range.

                Capping at the call site keeps ONE owner of the width per
                breakpoint: the grid above `lg`, this line below it. It is also
                how every other cap on this page is applied — the lede's
                `max-w-xl`, Band's `max-w-2xl`, /pricing's plan card — while a
                cap inside the component would apply at `lg` too, where the
                grid already decides. `lg:max-w-none` is not load-bearing
                today (448px is wider than the column already), and is there so
                a later change to `max-w-6xl` or to the gap cannot quietly make
                this the constraint up there. */}
            <div className={cn('mx-auto w-full max-w-md lg:col-span-5 lg:max-w-none')}>
              <HeroPanel />
            </div>
          </div>
        </section>
      </div>

      {/* --- the three things a sceptic checks first --------------------- */}
      <section className={cn('band bg-muted/40 px-safe')}>
        <div className={cn('mx-auto max-w-6xl px-4 md:px-6 lg:px-8')}>
          <dl
            className={cn('grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0')}
          >
            {[
              // The investor clause is the second half of the sentence and it
              // was on /about, which is where the strongest writing on the
              // property kept ending up. "No ads" is a policy; "no investor
              // waiting for us to change that" is the reason the policy can
              // hold, and it is the half a reader who has watched this promise
              // break before is actually listening for.
              //
              // No pronoun to resolve, which is half of the second pass here.
              // "No investor is expecting a second one to appear later" asked
              // the reader to carry "one" back across a comma to "business
              // model", and the nearest noun it could land on was "investor" —
              // a second investor, appearing later, which is not the claim. A
              // reassurance that has to be parsed twice is not reassuring. The
              // same pronoun was doing the same damage in the /about section
              // this clause came from ("one of those") and in the store
              // listing's closing line ("either"); all three now end on "change
              // that", where the antecedent is the whole sentence before it.
              //
              // The cost clause is the other half, and it is the answer to the
              // objection a reader actually has. "Subscriptions are the only
              // model" invites "yes, until the money runs out" — so the cell
              // names WHY one revenue line is enough: the same architecture the
              // rest of the page is about leaves us storing bytes and doing no
              // work on them. /about argues it at length ("a fraction of a cent
              // a year"); this is that argument at the width of a cell.
              //
              // NOT the word "sustainable", which was the obvious way to say it.
              // It is a self-assessment a reader cannot check, and it is the
              // register of a company that is about to be acquired. The fact
              // underneath it is checkable and says more.
              [
                'No ads, ever',
                'The subscription is the whole business model, and a server that cannot read your library is cheap to run. No investor is waiting for us to change that.',
              ],
              // The carve-out is not a weakening, it is the difference between a
              // claim and a slogan. /privacy and the FAQ's `trackers` answer both
              // name the one third-party script we load — Paddle's, on Settings →
              // Subscription — and this cell, the loudest and shortest version of
              // the same claim, was the only one that did not. A reader who meets
              // that script after reading an absolute here has caught us, over a
              // checkout nobody would have objected to.
              //
              // "No ad networks" came out of the list, and not because the term
              // above already says "No ads": an ad network's pixel is an OUTSIDE
              // SCRIPT, so the sentence that follows denies it absolutely and by
              // construction, where the enumeration only denied it by name. It
              // was the one item earning nothing, in the cell that ran a line
              // longer than either of its neighbours.
              [
                'No trackers',
                'No analytics, no fingerprinting. The only outside script we load is our payment provider’s, on the one screen where you subscribe.',
              ],
              // The local copy, not the format list. Lock-in is answered hardest
              // by the data already being on the machine — an export is a copy
              // you make, not a request you file — and that fact was left
              // entirely to the durability band, seven screens further down,
              // while this cell sat at one line against three and four.
              //
              // The four format names stay in that band and are stated once
              // (see the note over LIBRARY's Export entry). And what must not go
              // in here at any length: "imports straight into other apps". Our
              // half of that is a bookmarks HTML file and a CSV; whether
              // somebody else's importer reads them is their promise to keep,
              // not ours to make on a landing page.
              [
                'No lock-in',
                'Full export on every plan, including the free one. The library is already on your device, so leaving is a copy you make rather than a request you file.',
              ],
            ].map(([term, detail]) => (
              <div key={term} className={cn('py-8 sm:px-8 sm:first:pl-0 sm:last:pr-0')}>
                <dt className={cn('font-display text-lg font-semibold tracking-tight')}>{term}</dt>
                <dd className={cn('mt-1.5 text-sm leading-6 text-muted-foreground')}>{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* --- capture ------------------------------------------------------ */}
      {/* The lede says "before it syncs", NOT "before anything leaves the
          device", and the difference is the difference between true and false.
          Two of the four cards below — the web app and Import — reach
          `bracemark-extractor` when the opt-in Plus setting is on, and that
          request carries the URL in PLAINTEXT by construction: a server that
          fetches a page for you has to be told which page (docs/link-extraction.md,
          _server extraction_). The old universal ("whichever surface you use …
          anything") was contradicted by the card sitting directly under it.
          Encryption-before-sync is the claim the architecture actually supports,
          and it is the same scoping the hero, the footer and every store listing
          use.

          The first sentence describes the act now rather than asserting a law
          about it. It read "Saving has to be faster than not saving, or the
          library never happens", which inverts the moment anyone checks it —
          not saving takes no time at all — on a page whose whole authority is
          that its sentences survive being read closely. What that line was
          reaching for is kept: friction is what decides whether a link gets
          saved. It is now stated at the size of one save, in the second person,
          which is also what sets up the title above it and the four cards
          below.

          The title used to answer it with "all of them one gesture", and no
          reading of "gesture" makes that true: the extension is icon-then-Save,
          the share sheet is share-pick-Save, the web app is Add-link-paste-submit
          (links/_components/link-add-surface.tsx), and Import is Settings → Data
          → Import, a file picker, and possibly the over-cap question. Import is
          the one that cannot be defended even loosely — the card directly beneath
          the title DESCRIBES a decision point ("take the first N now, or start
          the trial"), so the claim was refuted by its own grid. What survives the
          check is the typing, which is the actual friction the lede names: none
          of the four asks you for the link itself. Anything here that counts
          clicks, taps or gestures has to be walked through all four first. */}
      <Band
        label="Getting links in"
        title="Four ways in, and none of them ask you to type the link."
        lede="A save you have to stop and think about is a save you skip. Whichever surface you use, the link is encrypted on the device before it syncs."
      >
        {/* Rules, not a box — the same shape as the sceptic grid above and the
            library grid below, which is this page's idiom (the only real panels
            on it, the two screenshot frames, are image frames). This carried
            `overflow-hidden rounded-xl` and a uniform `p-7 md:p-8`, which reads
            as an enclosed card and never rendered as one: `.band` has no fill
            (globals.css, `.band` is border-t and nothing else), the page wrapper
            is `bg-background` (app/layout.tsx) and the cells are `bg-background`
            too — the same token — so the whole construction drew a 1px cross
            between the four cells and nothing at the perimeter. With no visible
            edge there was nothing for the inset to be inside of, and it pushed
            all four outer edges off the band's text column: the eyebrow, the h2
            and the lede sit flush at `max-w-6xl px-4/md:px-6/lg:px-8`, and the
            left column's copy started 28-32px to the right of them.

            So padding goes on the divider-facing sides only, which is the
            sceptic grid's `sm:px-8 sm:first:pl-0 sm:last:pr-0` adapted to two
            columns — `first`/`last` are the top-LEFT and bottom-RIGHT cells in a
            2×2 and would zero the wrong pair, where `odd`/`even` track the
            columns exactly at any item count. Below `sm` this is one column, so
            it takes no horizontal padding at all and is flush by construction.
            `gap-px` + `bg-border` stays as the hairline technique: `divide-x`
            puts a left border on every child but the first, which in two columns
            means a spurious one down the middle of item 3. */}
        <ul className={cn('grid gap-px bg-border sm:grid-cols-2')}>
          {CAPTURE.map(({ name, where, body }) => (
            <li
              key={name}
              className={cn('bg-background py-7 sm:px-8 sm:odd:pl-0 sm:even:pr-0 md:py-8')}
            >
              <div className={cn('flex items-baseline justify-between gap-4')}>
                <h3 className={cn('font-display text-xl font-semibold tracking-tight')}>{name}</h3>
                <span className={cn('shrink-0 font-mono text-xs text-muted-foreground')}>
                  {where}
                </span>
              </div>
              <p className={cn('mt-3 text-body text-muted-foreground')}>{body}</p>
            </li>
          ))}
        </ul>
      </Band>

      {/* --- the library -------------------------------------------------- */}
      <Band
        label="Finding them again"
        title="A private library is still a library."
        lede="Encryption is the part you don’t see. This is the part you use every day — and most of it is on the free plan."
      >
        {/* The picture goes above the list, not beside it: the band's claim is
            that the library looks like a library, and a wall of covers makes
            that argument in less time than six bullets can. The caption is the
            mono instrument voice, and it does a second job — previews coming
            from the saving device is the one thing a grid of covers cannot show
            and the thing that decides whether a free web-only visitor sees any. */}
        <figure className={cn('mb-16')}>
          <div className={cn('overflow-hidden rounded-2xl border border-border bg-card shadow-sm')}>
            {/* `loading="lazy"`: this figure sits several screens down and
                there is no image in the hero, so nothing here is the LCP
                element — the bytes are better spent after first paint.
                `width`/`height` stay as the ratio hint beside `aspect-16/10`
                and describe the shape, not any one variant. */}
            <img
              src={SCREENSHOT.src}
              srcSet={SCREENSHOT_SRCSET}
              sizes={SCREENSHOT_SRCSET ? SCREENSHOT.sizes : undefined}
              alt={SCREENSHOT.alt}
              width={1600}
              height={1000}
              loading="lazy"
              decoding="async"
              className={cn('block aspect-16/10 w-full object-cover object-top')}
            />
          </div>
          {/* Not `.eyebrow`, despite being the small mono-ish line under a
              figure. An eyebrow is uppercase at 0.18em tracking because it is a
              two-word LABEL naming a band; a full sentence set that way is hard
              to read and shouts. This matches the band's other secondary line —
              the Plus footnote below the grid — which is what it is. */}
          <figcaption className={cn('mt-4 max-w-2xl text-sm leading-6 text-muted-foreground')}>
            {SCREENSHOT.caption}
          </figcaption>
        </figure>

        <ul className={cn('grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3')}>
          {LIBRARY.map(([name, body]) => (
            <li key={name} className={cn('border-t border-border pt-5')}>
              <h3 className={cn('text-base font-semibold')}>{name}</h3>
              <p className={cn('mt-2 text-body text-muted-foreground')}>{body}</p>
            </li>
          ))}
        </ul>
        <p className={cn('mt-10 max-w-2xl text-sm leading-6 text-muted-foreground')}>
          Nested lists, hidden lists, the app lock, the structured search editor and previews from
          our server are {PLAN_LABELS.plus}. Everything else above is free.
        </p>
      </Band>

      {/* --- the trade -----------------------------------------------------
          Between the library band and the claim, and the order is the argument.
          Reading down: here is what you do with your links, here is what that
          costs you against a hosted manager, and here is the architecture that
          bought it. The claim band answers all three losses with one mechanism,
          so it lands on a reader who has just been told the bill.

          The other way round — claim first, then trade — stacks two consecutive
          blocks of bad news directly in front of the price, which is the one
          place on the page that cannot afford them. */}
      <Band
        label="Compared with"
        title="What we gave up to get here."
        lede="Raindrop, Pocket and your browser’s bookmarks hold your titles and addresses in readable form — that is what makes their server-side features possible in the first place. Bracemark gives those up for a server with nothing to read. Here is the whole trade."
      >
        {/* One `dt` and two `dd`s per row: one term, two descriptions, which is
            what a definition list is for and what makes this survive being
            linearised. Each `dd` carries its own eyebrow, so a screen reader
            hears "A hosted manager …" then "Bracemark …" rather than two
            unattributed paragraphs (docs/accessibility.md).

            The trade is carried by CONTRAST, not colour: the loss is muted, what
            you get is foreground. `text-signal` on the right-hand eyebrow is the
            tempting one-line change and it is declined — globals.css rations the
            accent to what is genuinely yours or genuinely on, and three more
            marks here would double the page's accent count to make a point the
            weight difference already makes. */}
        <dl className={cn('grid divide-y divide-border border-y border-border')}>
          {TRADE.map(({ aspect, hosted, ours }) => (
            <div
              key={aspect}
              className={cn('grid gap-x-10 gap-y-5 py-9 md:grid-cols-12 md:gap-y-0')}
            >
              <dt className={cn('font-display text-xl font-semibold tracking-tight md:col-span-3')}>
                {aspect}
              </dt>
              <dd className={cn('md:col-span-4')}>
                <p className={cn('eyebrow')}>A hosted manager</p>
                <p className={cn('mt-2.5 text-body text-muted-foreground')}>{hosted}</p>
              </dd>
              <dd className={cn('md:col-span-5')}>
                <p className={cn('eyebrow text-foreground')}>{BRAND.name}</p>
                <p className={cn('mt-2.5 text-body')}>{ours}</p>
              </dd>
            </div>
          ))}
        </dl>
      </Band>

      {/* --- the claim -----------------------------------------------------
          The one loud moment on the site, and it is loud with nothing but type
          on an inverted ground. Everything it asserts is architecture, which is
          why the three columns underneath are mechanisms, not values. */}
      <section className={cn('bg-foreground px-safe text-background')}>
        <div className={cn('mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32 lg:px-8')}>
          <p
            className={cn(
              'font-display text-3xl leading-[1.15] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl',
            )}
          >
            We don’t promise not to look.
            <br />
            <span className={cn('text-background/55')}>We built it so we can’t.</span>
          </p>
          <dl className={cn('mt-20 grid gap-10 md:grid-cols-3 md:gap-12')}>
            {GUARANTEES.map(([term, detail]) => (
              <div key={term} className={cn('border-t border-background/20 pt-5')}>
                <dt className={cn('eyebrow text-background/60')}>{term}</dt>
                <dd className={cn('mt-3 text-body text-background/85')}>{detail}</dd>
              </div>
            ))}
          </dl>
          {/* Back to the stark version, deliberately, now that the trade band
              exists. The reassurance was briefly bolted on here — the cost had
              been landing with no hand held out, and this was the beat a nervous
              reader stopped scrolling. The trade band's third row now does that
              job three sections earlier and more gently, in the same breath as
              the fact, which is where it belongs.

              So this paragraph goes back to being what it is best at: the
              concession, unhedged, at the moment the page is proudest. Softening
              it twice would spend the one thing that makes the rest believable
              (docs/brand-assets.md — _states its own costs, unprompted_: "the
              concession is load-bearing"). It now reads as the reprise of a fact
              the reader already met, which is the only reason the starker
              wording is affordable here. */}
          <p className={cn('mt-14 max-w-2xl text-sm leading-6 text-background/60')}>
            The honest cost of building it this way: lose your password and your recovery code, and
            nobody — us included — can get the library back.{' '}
            <Link className={cn('text-background underline underline-offset-4')} href="/faq">
              How the account works
            </Link>
            .
          </p>
        </div>
      </section>

      {/* --- durability ----------------------------------------------------
          Placed between the claim block and the price on purpose: this is the
          objection a reader raises in the beat after being convinced and before
          being asked to pay, and answering it anywhere else means answering it
          too late. */}
      <Band
        label="If we disappear"
        title="The library outlives the company."
        lede="Every subscription should have to answer this, and ours cannot answer it with a promise about our future. Three properties of how it is built, none of which we can revoke later."
      >
        <dl className={cn('grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3')}>
          {DURABILITY.map(([term, detail]) => (
            <div key={term} className={cn('border-t border-border pt-5')}>
              <dt className={cn('text-base font-semibold text-balance')}>{term}</dt>
              <dd className={cn('mt-2 text-body text-muted-foreground')}>{detail}</dd>
            </div>
          ))}
        </dl>
        {/* The lineage, in the footnote slot the library band uses for its Plus
            line. It is the strongest longevity fact we own and it was on the
            fourth page a visitor reaches, behind the objection it answers. Kept
            as a footnote rather than a fourth column because it is a track
            record, not a property — the section's whole argument is that the
            other three hold whether or not you believe this one. */}
        <p className={cn('mt-10 max-w-2xl text-sm leading-6 text-muted-foreground')}>
          For whatever a track record is worth: Bracemark is the second version of Brace.to, a
          bookmark manager we have run for years. Same team, same job — this version keeps the
          promise and drops the prerequisite.{' '}
          <Link
            className={cn(
              'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
            )}
            href="/about"
          >
            Where it came from
          </Link>
          .
        </p>
      </Band>

      {/* --- pricing teaser ----------------------------------------------- */}
      <Band
        label="Pricing"
        title="Free until your library outgrows free."
        lede={`Start with ${FREE_LINKS} links and no card. Upgrade when the cap starts to pinch — on day one if you are arriving with a library, later if you are starting fresh — with a ${TRIAL_DAYS}-day trial, and the same encryption, sync and export on both plans.`}
      >
        <div className={cn('flex flex-wrap items-end gap-x-16 gap-y-8')}>
          <div>
            <p className={cn('eyebrow')}>{PLAN_LABELS.free}</p>
            <p className={cn('mt-2 font-display text-4xl font-semibold tracking-tight')}>$0</p>
            {/* "No time limit", not "forever" — the twin of /pricing's Free card,
                where the reasoning lives. The sharper half of it is here: FREE_LINKS
                is interpolated precisely so this page can never quote a cap the app
                does not enforce, and "forever" put the promise back. Drop the cap to
                100 one day and this line renders "100 links, forever" — truthful
                about the number, and false to everyone who signed up under the old
                one. */}
            <p className={cn('mt-1 text-sm text-muted-foreground')}>
              {FREE_LINKS} links, no time limit
            </p>
          </div>
          <div>
            <p className={cn('eyebrow text-signal')}>{PLAN_LABELS.plus}</p>
            <p className={cn('mt-2 font-display text-4xl font-semibold tracking-tight')}>
              ${PLAN_USD_PER_YEAR.plus}
              <span className={cn('text-lg font-normal text-muted-foreground')}>/year</span>
            </p>
            {/* "Advanced search" was the one overclaim on an otherwise literal
                page. Every reader arriving from a competitor decoded it as
                full-text search inside saved pages — which the band two
                sections up has just told them it isn't ("Across titles,
                addresses and hosts") — so the teaser was quietly contradicting
                the product. These are the comparison table's own row labels,
                which were accurate all along, and they restore nested lists:
                the one Plus feature a switcher with folders actually needs, and
                the one the old line left out. */}
            <p className={cn('mt-1 text-sm text-muted-foreground')}>
              Unlimited links, nested lists, app lock, search editor
            </p>
          </div>
          {/* Two actions, not one. There is a primary CTA in the hero and
              another in the closer with SEVEN bands between them, and the only
              thing to press in that whole stretch used to be "Compare plans" —
              a lateral move to another page, offered at the exact moment the
              price is on screen and the reader has just been told the free tier
              costs nothing. That is the conversion point on this page, and it
              was the one place with no way to convert.

              A third band just for a button would be the obvious fix and the
              wrong one on a page already nine sections long. This costs no
              structure: the pair mirrors the hero's own primary + secondary, so
              the page opens and closes its argument with the same gesture, and
              "Compare plans" keeps its place for the reader who is not ready. */}
          <div className={cn('flex flex-wrap items-center gap-3')}>
            <Button asChild size="lg">
              <a href={CREATE_ACCOUNT_URL}>
                Create your account
                <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
              </a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/pricing">Compare plans</Link>
            </Button>
          </div>
        </div>
      </Band>

      {/* --- close --------------------------------------------------------- */}
      <section className={cn('band px-safe')}>
        <div className={cn('mx-auto max-w-6xl px-4 py-24 text-center md:px-6 md:py-28 lg:px-8')}>
          <h2
            className={cn(
              'mx-auto max-w-2xl font-display text-3xl leading-[1.1] font-semibold tracking-tight text-balance md:text-5xl',
            )}
          >
            Start empty, or bring the library you already have.
          </h2>
          {/* Two doors on purpose. The old closer named only the empty one,
              which dismissed the switcher the Import card had just courted —
              the last line on the page addressed to a person who has no
              library. Both secrets are named here too: the passphrase and the
              recovery code are what the account rests on, and the closer is the
              last place before the ceremony to say so. */}
          <p className={cn('mx-auto mt-5 max-w-lg text-lg leading-8 text-muted-foreground')}>
            Pick a username, save the passphrase we generate for you and the recovery code beside
            it, and save your first link a minute later.
          </p>
          <Button asChild size="lg" className={cn('mt-9')}>
            <a href={CREATE_ACCOUNT_URL}>
              Create your account
              <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
            </a>
          </Button>
        </div>
      </section>
    </>
  );
}
