'use client';

// The row's icon/image presentation chain: the site Favicon, which falls back to
// a quiet plate, and the LinkPreviewImage slot, which falls back to a small
// favicon escalating to the shared HostMonogram (list) or to a full-bleed hue
// panel (card). Shared by both link layouts.
//
// ONE identity escalation per row, and the SLOT owns it. Both halves resolve the
// same host's favicon independently, so for a while both ran the escalation
// locally and both took it — see `Favicon` for what that painted and why the chip
// beside the host line is the half that yields.

// The letter/hue derivations (initialFromHost/hueFromHost) live in
// @stxapps/shared (url/host-identity.ts): bracemark-expo's card panel is a second
// consumer, and the same host must paint the same letter on the same hue on
// every surface. They stay free functions (not buried in HostMonogram) so the
// full-bleed panel below can paint the hue as its own background without
// drawing a nested tile.
//
// The monogram MARKUP moved to web-ui alongside them once bracemark-extension's
// popup specimen became its third consumer — see host-monogram.tsx.
import { hostFromText, hueFromHost, initialFromHost } from '@stxapps/shared';
import { type LinkView, useFaviconUrl, useImageFileUrl } from '@stxapps/web-react';
import { HostMonogram } from '@stxapps/web-ui/components/links/host-monogram';

// The quiet plate both fallbacks below paint: an alpha toward the FOREGROUND, not
// `bg-muted`. A plate sits on an ITEM, and a selected item is `bg-muted` itself —
// so a muted plate stepped 0 off it and was simply gone for as long as the user
// was picking links. That is the tag chips' mechanism (link-tag-chips.tsx carries
// the arithmetic) but not their tone, and the alpha is per theme because one
// number serves neither: `/4` lands on the old muted plate exactly on a plain
// light row, where the chips' `/6` read too heavy; `/8` in dark, where `/6` read
// too faint.
const PLATE_CLASS = 'bg-foreground/4 dark:bg-foreground/8';

// The site's favicon, keyed by DISPLAY HOST (`hostFromText`, so it matches the
// host string rendered beside it) — cached per host in Dexie and fetched at most
// once per host per device through the extractor's image proxy (useFaviconUrl /
// favicon-provider). This replaces the old Google s2/favicons call, which
// disclosed every rendered link's host to Google and was the last third-party leak
// in the app.
//
// With no bytes to show it falls back to a QUIET PLATE — while the fetch is in
// flight, for a host with no reachable favicon, and (by design, not failure) for
// every host while the serverExtraction opt-in is off, which is the DEFAULT. So
// the fallback is a steady state rather than a loading state, and on a library
// that never opted in it is the ONLY state.
//
// It used to draw the monogram here, and that put the mark on the row twice. The
// tile's letter is `initialFromHost` of the very string rendered ~6px to its
// right, so beside the host text it only restates what the reader is already
// reading — and with no image either, PreviewFallbackIcon below fills its 64x40
// slot with that same letter on that same hue, ~12px away. (The quieter half of
// the same duplication was always there: a row with a favicon and no image drew
// that one favicon twice, once per box.)
//
// The rule is unchanged — it is PreviewFallbackIcon's own: the hue field appears
// only where the monogram is the last identity left. What changed is that it is
// now applied once per ROW instead of once per component. Beside a host string
// the monogram is never the last identity left, and the slot is the box with the
// stronger claim: 64x40 with nothing else in it, against 14px with the host name
// spelled out alongside. bracemark-extension's PageSpecimen keeps its escalation
// for exactly that reason — the popup prints no host chip, so its slot really
// does stand alone.
//
// A plate rather than NOTHING, so the host strings keep one left edge. Dropped
// outright, the chip's ~20px would come back only on the rows that lack an icon,
// and a mixed list would run ragged — list-layout.tsx makes the same argument for
// top-aligning the thumbnail rail.
export function Favicon({ host, className }: { host: string; className: string }) {
  const url = useFaviconUrl(host);
  // `rounded-sm` here rather than at the call sites: they size the box and nothing
  // else shaped it, because the monogram used to bring its own `rx`.
  if (!url) return <span aria-hidden className={`rounded-sm ${PLATE_CLASS} ${className}`} />;
  // object-contain, not cover: a favicon is a whole mark, so it letterboxes rather
  // than crops (unlike the preview image, which is a photo being filled into a box).
  return <img src={url} alt="" className={`object-contain ${className}`} />;
}

// The image-less ROW fallback: the site favicon on a quiet plate, and — when
// there is no favicon either — the monogram FILLING the slot.
//
// The plate is `PLATE_CLASS` rather than `bg-muted`, and this is the slot where
// that cost most: on a selected row a muted plate is the row's own fill, which
// left a 16px favicon marooned in an invisible 64x40 — the picture the
// escalation below was written to get rid of.
//
// That escalation is PageSpecimen's (bracemark-extension), and this is the same
// 64x40 box, so it now follows the same rule: the plate stays quiet while there
// is a real mark to show, and the hue field appears only when the monogram is the
// last identity left, which is exactly when it should be doing the most work. It
// used to centre a `size-4` monogram on the muted plate in that last state — 16px
// marooned in a 64x40 rectangle, which reads as an image that failed to load
// rather than as the site's mark.
//
// It is also the row's ONLY escalation now — `Favicon` above stopped taking the
// same one beside the host line, where it drew this letter on this hue a second
// time, ~12px away.
//
// It resolves the favicon ITSELF rather than delegating to `Favicon` (which
// renders a bare plate in this state): the slot is what has to know whether there
// are bytes, because that is what decides between a small centred mark and a
// full-bleed field. PreviewFallbackPanel below is built the same way, for the
// same reason.
//
// `ratio={16 / 10}` is the slot's own aspect — the fixed 64x40 that four surfaces
// share (PageSpecimen.tsx names them). Hard-coded rather than taken from a prop
// because that shared shape IS the contract; a caller that ever sizes this slot
// differently has to bring the ratio with it, or the field letterboxes.
// `overflow-hidden` because `rx={0}` leaves square corners for the caller's
// `rounded` to clip — the popup's slot carries it already, this one never needed
// it while the child was a small centred image.
function PreviewFallbackIcon({
  host,
  className,
  iconClassName,
}: {
  host: string;
  className: string;
  iconClassName?: string;
}) {
  const url = useFaviconUrl(host);
  if (!url) {
    return (
      <div className={`overflow-hidden ${className}`}>
        <HostMonogram host={host} ratio={16 / 10} rx={0} className="size-full" />
      </div>
    );
  }
  // object-contain, not cover — `Favicon`'s rule above, same bitmap argument.
  return (
    <div className={`flex items-center justify-center ${PLATE_CLASS} ${className}`}>
      <img src={url} alt="" className={`object-contain ${iconClassName ?? ''}`} />
    </div>
  );
}

// The image-less card fallback: a full-bleed panel painted with the host's hue
// (same hsl family as the HostMonogram tile), so an image-less card reads as an
// intentional colored block rather than a tiny icon lost on grey. The real favicon,
// when present, sits centered on a white chip (its own light background, so it never
// clashes with the panel hue); with no favicon — the default when serverExtraction
// is off — the panel carries a large centered letter instead.
function PreviewFallbackPanel({ host, className }: { host: string; className: string }) {
  const url = useFaviconUrl(host);
  const hue = hueFromHost(host);
  return (
    <div
      className={`flex items-center justify-center ${className}`}
      style={{ backgroundColor: `hsl(${hue} 45% 45%)` }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="size-12 rounded-md bg-white/95 object-contain p-1.5 shadow-sm"
        />
      ) : (
        <span aria-hidden className="text-4xl font-semibold text-white/95 select-none">
          {initialFromHost(host)}
        </span>
      )}
    </div>
  );
}

// The link's preview-image slot. The resolved bytes are local-first: `imageId`
// is the row's override-wins image ref (LinkView), read from Dexie and fetched
// on demand by useImageFileUrl the moment the row mounts (rows are virtualized,
// so mounted = displayed). Until bytes exist — or when the link has no image at
// all — the slot shows a fallback keyed by `fallback`: the site favicon on a quiet
// plate, escalating to the full-bleed monogram when there is no favicon
// either (`icon`, the list's compact 64x40 slot), or the full-bleed hue panel
// (`panel`, the card's 12:7 banner). Either way the placeholder still
// identifies the link and the geometry never shifts — both call sites pass a
// FIXED-size `className` (the layouts' row estimates depend on it).
export function LinkPreviewImage({
  link,
  className,
  iconClassName,
  fallback = 'icon',
}: {
  link: LinkView;
  className: string;
  iconClassName?: string;
  fallback?: 'icon' | 'panel';
}) {
  const url = useImageFileUrl(link.imageId);

  if (url) {
    return <img src={url} alt="" className={`object-cover ${className}`} />;
  }

  const host = hostFromText(link.url);
  if (fallback === 'panel') {
    return <PreviewFallbackPanel host={host} className={className} />;
  }
  return <PreviewFallbackIcon host={host} className={className} iconClassName={iconClassName} />;
}
