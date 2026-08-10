'use client';

// The deterministic identity tile for a host — its first alphanumeric on a hue
// derived from the host string, so the same site always draws the same letter on
// the same colour. It's the stand-in wherever a real favicon isn't there to show:
// while a fetch is in flight, for a site with no reachable icon, and (by design)
// for every site when the serverExtraction opt-in is off.
//
// It lives here rather than in either app because BOTH now draw it: bracemark-web's
// link rows and card panels (link-media.tsx), and bracemark-extension's popup
// specimen, which paints the active tab before it has been saved and therefore
// before there is a LinkView to hand to link-media at all. The derivations
// themselves (initialFromHost / hueFromHost) already sat in @stxapps/shared for the
// same reason one level down — bracemark-expo is their third consumer — so what
// was left duplicated was only the markup, and "same site, same tile" has to hold
// across the popup and the library it saves into or the recognition cue is worth
// nothing.
//
// SVG, not a styled div, so ONE component serves every call site's box (size-4 in
// the rows, size-6 in the preview slot, size-11 in the popup specimen) — the
// viewBox scales the letter with the tile, where a Tailwind text size would have
// to be passed in per caller and kept in step with it.

import { hueFromHost, initialFromHost } from '@stxapps/shared';

export function HostMonogram({ host, className }: { host: string; className?: string }) {
  const letter = initialFromHost(host);
  const hue = hueFromHost(host);

  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <rect width="16" height="16" rx="3" fill={`hsl(${hue} 45% 45%)`} />
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="10"
        fontWeight="600"
        fill="#fff"
      >
        {letter}
      </text>
    </svg>
  );
}
