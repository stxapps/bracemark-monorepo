import { hostFromText } from '@stxapps/shared';
import { HostMonogram } from '@stxapps/web-ui/components/links/host-monogram';
import { cn } from '@stxapps/web-ui/lib/utils';

// The one object the popup is about: the page, drawn the way the library draws
// it. A 44px identity tile, the title, the address.
//
// It is deliberately the SAME component in the editor and on the complete
// screen, and it does not move between them. Saving a link in this popup used to
// read as submitting a form and being handed a receipt — two screens, two
// headings, nothing visibly in common. Now the page is on screen the whole time
// and the save happens TO it: the surrounding controls change, the specimen
// stays put, and its corner comes off.
//
// THE CORNER IS THE SAVE. `corner-cut` (styles/globals.css) takes 11px off the
// tile's top right at 45° — the brand mark's own geometry, the turned-down page
// corner that means a place is being kept. That is the entire "saved" signal:
// no check badge, no colour, no state word competing with the title. It
// transitions because the two clip paths share a vertex count, and it holds
// still under `prefers-reduced-motion` because the cut is information and the
// animation is not.
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
// The proportions — size-11 tile, 15px title, gap-3.5 — are lifted from the
// marketing site's hero panel, which depicts exactly this: a saved bookmark as
// the user sees it, above the ciphertext the server gets. The hero is a drawing
// of this component; they should measure the same.

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
      <div
        className={cn(
          'size-11 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10 ring-inset',
          'transition-[clip-path] duration-300 ease-out motion-reduce:transition-none',
          saved ? 'corner-cut' : 'corner-square',
        )}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" className={cn('size-full object-cover')} />
        ) : iconUrl ? (
          // object-contain, not cover: a favicon is a whole mark, so it
          // letterboxes rather than crops — the same rule link-media follows.
          <div className={cn('flex size-full items-center justify-center')}>
            <img src={iconUrl} alt="" className={cn('size-6 object-contain')} />
          </div>
        ) : (
          <HostMonogram host={host} className={cn('size-full')} />
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
