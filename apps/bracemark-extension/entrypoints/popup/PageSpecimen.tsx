import { hostFromText } from '@stxapps/shared';
import { HostMonogram } from '@stxapps/web-ui/components/links/host-monogram';
import { cn } from '@stxapps/web-ui/lib/utils';

// The one object the popup is about: the page, drawn the way the library draws
// it. A 64x40 preview slot, the title, the address.
//
// It is deliberately the SAME component in the editor and on the complete
// screen, and it does not move between them. Saving a link in this popup used to
// read as submitting a form and being handed a receipt — two screens, two
// headings, nothing visibly in common. Now the page is on screen the whole time
// and the save happens TO it: the surrounding controls change, the specimen
// stays put, and its corner comes off.
//
// THE CORNER IS THE SAVE — on the OBJECT. `corner-cut` (styles/globals.css) takes
// 12px off the slot's top right at 45°: the brand mark's own geometry, the
// turned-down page corner that means a place is being kept. It transitions
// because the two clip paths share a vertex count, and it holds still under
// `prefers-reduced-motion` because the cut is information and the animation is
// not.
//
// It is NOT the whole signal, and this comment claimed it was for a long time
// ("no check badge, no colour, no state word") while the screen around it said
// otherwise: `Complete.tsx` sets the `PopupTitle` to "Saved", names the list the
// link landed in, and replaces the entire form with "Open Bracemark". The same
// is true of bracemark-expo's share sheet, which prints "Saved to <list>". So the
// words carry the state and always did.
//
// What the cut is, precisely: the only part of the confirmation that happens to
// the THING rather than to the chrome around it — which is the whole reason the
// specimen doesn't move across the save. Removing it would cost nothing a user
// could name and would take with it one of the two meanings the fold is allowed
// to carry (docs/brand-assets.md, _the mark_); keeping it costs one CSS pair here
// and one overlay in the RN port. Keep it, and don't re-inflate the claim.
//
// THE TILE'S FALLBACK CHAIN, best first:
//   1. the extracted preview image, once the background's titleImage capture has
//      written it — this is what arrives a beat after the save;
//   2. the LIVE TAB's favicon, which the popup gets free from `tabs.query` (no
//      fetch, no favicon-provider, no host disclosed to anyone) — so unlike a
//      library row, an unsaved page usually has a real icon from the first frame;
//   3. HostMonogram (web-ui), the same letter-on-hue tile bracemark-web falls back
//      to, so a site that reaches neither of the above is recognisable by the
//      same mark in the popup as in the library.
//
// The last one FILLS the slot (`ratio={16 / 10}`), where the favicon sits small
// and centred on the muted plate. That split is deliberate, and it is an
// escalation rather than an inconsistency: the plate stays quiet while there is a
// real mark to show, and the hue field only appears when the monogram is the ONLY
// identity left — which is exactly when it should be doing the most work. It also
// means the cut always bites a filled rectangle, in all three states, which is
// what makes a turned-down corner read as a turned-down corner.
//
// THE SLOT IS THE LIBRARY ROW'S, 64x40. It was a 44px SQUARE until the four
// surfaces that draw this object were measured against each other: bracemark-web's
// list row and its skeleton (`_layouts/list-layout.tsx`, `shared/layout-chrome.tsx`),
// bracemark-expo's row (`features/links/link-row.tsx`) and this. Three of the four
// were `h-10 w-16` and only the specimens were square — so the one component whose
// job is to show "the page, as the library will draw it" was the one drawing it
// differently. 16:10 is also the shape of the thing that eventually lands in the
// slot: a page's og:image is a landscape capture, and a square box cropped it
// harder here than the library crops the same bytes.
//
// What that costs is the width. The popup is `w-90` with `p-4` (Shell.tsx), so
// 64 + gap-3.5 leaves ~250px for a `line-clamp-2` title where the square left
// ~270. Two lines of 15px absorb it; the fixed slot is worth more than the 20px.
//
// The rest of the proportions — 15px title, gap-3.5 — are shared with the
// marketing site's hero panel, which depicts exactly this: a saved bookmark as
// the user sees it, above the ciphertext the server gets. The hero is a drawing
// of this component; they should measure the same, and it moved to 64x40 in the
// same change (bracemark-site `app/page.tsx`, HeroPanel).

// The address, minus the noise: `https://` reads on every row and distinguishes
// nothing, and a trailing slash is not part of what anyone recognises. Everything
// else stays — `www.` and the path included, since dropping either would show an
// address that isn't the one being saved. The full URL rides along as the title
// attribute for the cases where truncation hides the part that matters.
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function PageSpecimen({
  title,
  url,
  imageUrl,
  iconUrl,
  saved = false,
}: {
  title?: string;
  url: string;
  // The extracted preview image as an object URL, when there is one.
  imageUrl?: string;
  // The active tab's own favicon, straight from `browser.tabs.query`.
  iconUrl?: string;
  saved?: boolean;
}) {
  const host = hostFromText(url);
  const address = displayUrl(url);

  return (
    <div className={cn('flex items-start gap-3.5')}>
      {/* `mt-0.5` for the same reason list-layout's slot carries it: `items-start`
          aligns this box to the TEXT BOX's top, but the title's glyphs start ~1.5px
          below that edge, so a flush image reads as sitting high. */}
      <div
        className={cn(
          'mt-0.5 h-10 w-16 shrink-0 overflow-hidden rounded bg-muted',
          // The ring is this surface's, not the row's. A library row sits in a
          // list of rows whose borders already bound it; this one is a lone object
          // on an otherwise empty popup, and the ring is what makes the SQUARE
          // corner legible as a corner — which is half of what the cut says.
          'ring-1 ring-border ring-inset',
          'transition-[clip-path] duration-300 ease-out motion-reduce:transition-none',
          saved ? 'corner-cut' : 'corner-square',
        )}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" className={cn('size-full object-cover')} />
        ) : iconUrl ? (
          // object-contain and centred, not full-bleed: a favicon is a BITMAP,
          // usually 16 or 32px, so it letterboxes rather than crops (the rule
          // link-media follows) and it is not scaled past the pixels it has.
          // `size-6` rather than the row's `size-4` — a row has a second favicon
          // beside its host line, so its slot isn't carrying identity alone; here
          // it is the only mark on the surface.
          <div className={cn('flex size-full items-center justify-center')}>
            <img src={iconUrl} alt="" className={cn('size-6 object-contain')} />
          </div>
        ) : (
          // Full-bleed, because it is a VECTOR and because it is the last thing
          // left to identify the page with. `ratio` must match the slot's 16:10
          // (host-monogram.tsx has the contract); `rx={0}` because this slot
          // already clips to `rounded`, and the field's own scaled 7.5px corners
          // inside that 4px clip would leave a sliver of plate at each corner.
          <HostMonogram host={host} ratio={16 / 10} rx={0} className={cn('size-full')} />
        )}
      </div>

      <div className={cn('min-w-0 flex-1')}>
        <p className={cn('line-clamp-2 text-[0.9375rem] leading-snug font-medium')}>
          {title || host || address}
        </p>
        <p className={cn('mt-1 truncate text-xs text-muted-foreground')} title={url}>
          {address}
        </p>
      </div>
    </div>
  );
}
