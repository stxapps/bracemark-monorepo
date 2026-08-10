'use client';

// The row's icon/image presentation chain: the site Favicon, which falls back to
// the shared HostMonogram, and the LinkPreviewImage slot, which falls back to
// either a small favicon (list) or a full-bleed hue panel (card). Shared by both
// link layouts.

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

// The site's favicon, keyed by DISPLAY HOST (`hostFromText`, so it matches the
// host string rendered beside it) — cached per host in Dexie and fetched at most
// once per host per device through the extractor's image proxy (useFaviconUrl /
// favicon-provider). This replaces the old Google s2/favicons call, which
// disclosed every rendered link's host to Google and was the last third-party leak
// in the app.
//
// Falls back to the monogram whenever there are no bytes to show — while the fetch
// is in flight, for a host with no reachable favicon, and (by design, not failure)
// for every host when the serverExtraction opt-in is off. So the fallback is a
// steady state, not just a loading state.
export function Favicon({ host, className }: { host: string; className: string }) {
  const url = useFaviconUrl(host);
  if (!url) return <HostMonogram host={host} className={className} />;
  // object-contain, not cover: a favicon is a whole mark, so it letterboxes rather
  // than crops (unlike the preview image, which is a photo being filled into a box).
  return <img src={url} alt="" className={`object-contain ${className}`} />;
}

// The image-less card fallback: a full-bleed panel painted with the host's hue
// (same hsl family as the Monogram tile), so an image-less card reads as an
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
// all — the slot shows a fallback keyed by `fallback`: the small site favicon on
// a muted background (`icon`, the list's compact h-10 slot) or the full-bleed hue
// panel (`panel`, the card's tall h-28 slot). Either way the placeholder still
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
  return (
    <div className={`flex items-center justify-center bg-muted ${className}`}>
      <Favicon host={host} className={iconClassName ?? ''} />
    </div>
  );
}
