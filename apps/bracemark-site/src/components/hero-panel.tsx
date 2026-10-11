import { SIGNATURE } from '@stxapps/shared';
import { HostMonogram } from '@stxapps/web-ui/components/links/host-monogram';
import { cn } from '@stxapps/web-ui/lib/utils';

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
//
// THE TWO HALVES' STRINGS ARE `SIGNATURE`, in shared `brand/brand.ts` — the
// eyebrows, the chip on the seam, the path, the size, the timestamp, the
// ciphertext block, and the sentence under them that says the panel in words.
// This panel is no longer the only drawing of the object, and a value retyped
// here is a value the other drawing does not get.

// The specimen's host, and the one constant behind BOTH halves of its identity:
// the line under the title, and the monogram's letter and hue. `hueFromHost` is
// keyed on this exact display string (shared `url/host-identity`), so splitting
// them would let the tile drift from the host printed beside it — "same site,
// same mark" is the whole point of that tile, and this panel is where a visitor
// meets it first.
const SPECIMEN_HOST = 'wikihow.com';

// TWO PAGES DRAW IT, which is why it is a file of its own: the landing page's
// hero (app/page.tsx), which it was written for, and /docs' "How encryption and
// search work", through `<SignaturePanel />` in mdx-components.tsx. The notes
// below were written on the landing page and still speak from it — "the figure
// below", "the hero paragraph beside it" are that page's. One component rather
// than a second drawing for the reason `SIGNATURE` is one constant: the record
// is an inventory, and a copy keeps whichever inventory was current the day it
// was made (docs/brand-assets.md, on the signature panel). It has no width of
// its own; each caller caps it.
export function HeroPanel() {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border bg-card shadow-sm')}>
      {/* Plaintext half — the only place the accent carries real content. The
          extra bottom padding keeps the tag row clear of the AES chip below. */}
      <div className={cn('p-5 pb-8 sm:p-6 sm:pb-9')}>
        <p className={cn('eyebrow text-signal')}>{SIGNATURE.deviceLabel}</p>
        <div className={cn('mt-4 flex gap-3.5')}>
          {/* The preview slot, filled the way the library will really fill it
              for a link like this one: `HostMonogram`, the deterministic
              letter-on-hue tile that stands in wherever there is no extracted
              image — which is what a web-only account shows while server
              previews remain off. It was an empty accent-tinted
              block, defended as "a diagram, not a screenshot"; what it actually
              read as was a hole, in the one artefact a visitor studies, exactly
              where the product's own subject belongs.

              WHY THE MONOGRAM AND NOT A REAL PREVIEW IMAGE — and the honest
              answer is NOT the one this comment used to give. It said the slot is
              64x40 and a social card is ~1200x630, so any cover centre-cropped
              into it is a colour swatch. That is true of a LOGO CARD and false in
              general, and the product's own pictures are the refutation: the
              figure below this band renders seven covers at exactly this size —
              a handshake, a blood-pressure monitor, a Friedrich painting, a tray
              of lasagne, Stonehenge, an office chair, a palace interior — and
              every one of them reads. A photograph survives this crop. Do not
              re-derive the old claim from the old wording.

              TWO REASONS SURVIVE, and they are about what this panel IS.
              First, it draws the WEB-ONLY DEFAULT. Server previews are off until
              the user opts in, so a visitor who signs up on the web and saves
              from the web sees monograms, not covers. A free phone with Link
              previews set to All links can still fill those rows after sync; that
              is why this is a surface default rather than a plan limit. The figure
              below shows a filled library and its caption carries that split.

              Second, and decisively: this panel is a DRAWING, not a capture. Every
              cover in the screenshots is there because a camera was pointed at the
              running product — nominative use, the same as the hostname beside it.
              Putting one HERE means either hotlinking a third party's CDN from our
              apex or committing their artwork into this repo, and for this
              specimen that artwork is CC BY-NC-SA: attribution required, and a
              non-commercial clause on a page that sells a subscription. The
              monogram is ours, it is a VECTOR sized to the box, and it costs
              nobody's licence.

              THIS specimen's own og:image is the one thing on this panel that is
              NOT a faithful drawing — a real browser-extension save of this link
              would show a picture, because the extension reads the live DOM and
              this page has one. What that image IS: a 3200x2400 step illustration
              of two people shaking hands, drawn for this article. It would crop
              into this slot perfectly well; the figure below proves it, since the
              same illustration is the first row down there. So the slot is NOT
              drawing the fallback because a cover would fail here. It is drawing
              it for the two reasons above — the free-plan default, and whose
              asset it would be.

              What this image is NO LONGER is somebody else's mark. The previous
              specimen was a site-wide masthead, and it failed the endorsement test
              below on top of everything else; the library behind every published
              picture is now picked so that no row fails that way. That the browser
              extension's popup and the expo share sheet both END their fallback
              chains on this tile rather than beginning there is unchanged.

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
                you are reading, buying, worrying about, and working on" is a
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

                THE PAGE IS
                https://www.wikihow.com/Prepare-for-a-Job-Interview, and the URL
                is written down here because for a long stretch it was not written
                down anywhere. The panel stores the HOST and the TITLE — which is
                all it renders — so the citation could be read but not checked,
                and the one thing this slot has already been wrong about is a
                citation.

                THIS SLOT USED TO CITE askamanager.org, and what moved it was not
                the copy but the PICTURES. One library now feeds every published
                image — the figure below, the social card, the PWA screenshots and
                four store listings — so it is built for a store reviewer rather
                than for this page, and that host serves a site-wide masthead as
                its og:image on every post. Which this panel had already worked
                out for itself, at this size, for the reason two paragraphs up;
                the store frame is where the same fact stopped being a question
                about a 64x40 slot. e2e/shot/library.ts carries the rule.

                RE-VERIFYING IT DOES NOT WORK FROM AN ORDINARY SHELL, and the trap
                is worse than the one it replaces. wikiHow answers a plain `curl`
                with a 3KB bot-challenge page AT STATUS 200 — not a 403, not an
                error, just a document with no og:title and no og:image in it — so
                a script reads a live page as one that has lost its metadata, and
                reads it that way intermittently, because the challenge engages
                after the first few requests. A 403 announces itself; this does
                not. Two routes that do work: `bracemark-extractor`, which is
                itself a Worker (POST /v1/extract on extractor.bracemark.com), and
                the Wayback `id_` snapshot, which serves the raw markup.

                THE AMPERSAND AND THE CAPITALISATION ARE THEIRS, and this string
                is the extractor's answer BYTE FOR BYTE — checked, not assumed.
                There is no suffix trimmed off it, which is worth saying because
                the neighbouring wikiHow rows do carry one ("How to Repot a Plant:
                14 Steps (with Pictures) - wikiHow"): this page's `<title>` and its
                og:title happen to agree and neither is branded. So unlike the
                specimen before it, the panel and a real save print the same
                characters, and `npm run shot:preflight` is what re-checks that. */}
            <p className={cn('text-[0.9375rem] leading-snug font-medium')}>
              How to Prepare for a Job Interview & Answer Common Questions
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
          {SIGNATURE.cipher}
        </span>
      </div>

      {/* Ciphertext half — inverted, because this is the side we live on.

          THE ALPHAS ON THIS GROUND ARE SET BY APCA, NOT BY THE WCAG RATIO, and
          every one of them was raised once already for that reason. docs/theme.md
          (_contrast — dark mode, where the ratio lies_) is explicit that WCAG 2.x
          is polarity-blind and OVERRATES light-on-dark at low luminance, which is
          precisely what `text-background/*` on `bg-foreground` is in light mode —
          so this surface is the one place on the site where the ratio is actively
          misleading. It is not a small gap: `/60` here measures a comfortable
          7.3:1 and Lc 49, and `/45` measures 4.5:1 and Lc 31, which is APCA's
          spot-reading floor — text that passes AA and is genuinely hard to read.
          That is theme.md's own warning verbatim ("will pass the ratio long before
          it is comfortable to read"), and it went unnoticed here for the same
          reason it does everywhere: nothing lints contrast, and the numbers that
          get checked by hand are the numbers that say it is fine.

          The ladder, measured in LIGHT mode because that is the worse surface for
          this polarity (the band inverts in dark, where every value scores ~15-25
          Lc higher):
            /80  Lc 77 — anything that must be READ: the eyebrow (11px uppercase
                 mono at 0.18em tracking, which wants MORE than body copy, not
                 less) and both caption paragraphs.
            /75  Lc 70 — supporting metadata beside a full-opacity sibling: the
                 size, the timestamp.
            /55  Lc 43 — the ciphertext block alone. It is texture rather than
                 text (`select-all`, never read as prose), so it is deliberately
                 below the body floor; the point of raising it from `/45` was to
                 clear the invisible threshold, not to make it competitive with
                 the path above it.
          Use this ladder for anything new here rather than picking an alpha that
          looks right in whichever theme the browser happened to open in. */}
      <div className={cn('bg-foreground px-5 pt-7 pb-6 text-background sm:px-6')}>
        <p className={cn('eyebrow text-background/80')}>{SIGNATURE.serverLabel}</p>
        <div className={cn('mt-4 flex items-baseline justify-between gap-4 font-mono text-xs')}>
          <span className={cn('truncate')}>{SIGNATURE.path}</span>
          <span className={cn('shrink-0 text-background/75')}>{SIGNATURE.size}</span>
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
        <p className={cn('mt-1 font-mono text-xs text-background/75')}>{SIGNATURE.changed}</p>
        <p
          className={cn(
            'mt-3 font-mono text-[0.6875rem] leading-5 break-all text-background/55 select-all',
          )}
        >
          {SIGNATURE.ciphertext}
        </p>
        {/* "no key to open", not the compressed "no key for". The clause is
            the panel's whole payoff — the hero paragraph beside it has just
            said the key is one your password unlocks on the device, and this
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
        <p className={cn('mt-5 text-sm leading-6 text-background/80')}>{SIGNATURE.caption}</p>
        {/* Named by us, in one clause, rather than left for a reader to derive
            and then distrust us for omitting. It is the cheapest credibility on
            the page: the truthful version is more impressive than the
            overclaim, because a team that volunteers its own residual leak is
            one you can believe about the leaks you cannot see. */}
        {/* Same weight as the line above it, not a dimmer footnote. Dimming it
            would stage the concession as fine print, which is the exact move
            this paragraph exists to refuse. It is the caption's second half, so
            it is set as the caption's second half — the two move together, and
            they moved together to `/80` in the APCA pass described above. (This
            note used to argue from `/50` being "roughly 4.4:1, under AA", which
            was the right conclusion off the wrong instrument: on this ground the
            WCAG figure is the one that flatters, not the one that bites.) */}
        {/* "It is the whole of what we can infer" was the one sentence in this
            panel a reader could disprove from the panel itself — the size is
            printed three lines up, and a size is an inference the closing clause
            said was not on the list. The move that buys the most here is
            volunteering a residual; a CLOSED enumeration is the one way to spend
            that credit and end up behind, because the reader who checks is
            exactly the reader this paragraph was written to win.
            So the list now names the size it was omitting, and then stops
            claiming to be a list: it ends at the inventory instead of standing in
            for one, which is what `Our blindness` in the claim band already does
            and the reason that entry survived every reading this one failed.
            The concession itself is untouched and stays at the caption's weight —
            see the note above. */}
        <p className={cn('mt-3 text-sm leading-6 text-background/80')}>
          What that shape still tells us: how many files you keep, how big each one is, and when
          they change. We would rather say it than have you work it out — and the privacy policy
          inventories every field we hold.
        </p>
      </div>
    </div>
  );
}
