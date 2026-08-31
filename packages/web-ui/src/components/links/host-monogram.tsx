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
// SVG, not a styled div, so ONE component serves every call site's box — the
// viewBox scales the letter with the tile, where a Tailwind text size would have
// to be passed in per caller and kept in step with it. Today both boxes are the
// same 64x40 preview slot, filled: bracemark-web's image-less list row
// (link-media.tsx's PreviewFallbackIcon) and bracemark-extension's popup
// specimen.
//
// `ratio` is what lets it be that last one. The viewBox was a fixed `0 0 16 16`,
// so the tile could only ever be SQUARE: dropped into a 16:10 box it letterboxed,
// leaving 12px of plate down each side, and the alternative — stretching it — puts
// the letter on a diet. Widening the viewBox instead keeps the letter round and
// centred while the hue field fills the box, which is what a slot whose only
// content is this mark wants.
//
// PASS THE BOX'S OWN ASPECT. `ratio` is width ÷ height of the box `className`
// sizes, and nothing checks the two agree — this is the one way to hold the
// component wrong. It fails softly, though: `preserveAspectRatio` still defaults
// to `meet`, so a mismatch letterboxes visibly (the state the default `ratio: 1`
// was always in) rather than deforming anything.
//
// `rx` is in the same viewBox units, so it SCALES with the box: the default 3 is
// 3/16 of the height, which is ~3px on a `size-4` tile and 7.5px on a 40px-tall
// one. Pass `rx={0}` when the parent already clips (the specimen's slot is
// `overflow-hidden rounded`) — otherwise the field's rounder corners sit inside
// the parent's tighter ones and leave a sliver of plate at each corner.
//
// The letter size is a CONSTANT fraction of the short edge — `FONT_SIZE`, half of
// it, the usual monogram-avatar ratio — which is what lets the viewBox do all the
// scaling. It was a per-caller `fontSize` prop while a third call site existed:
// link-media.tsx's `Favicon` drew this tile at the 14-16px chip beside a host
// line, where half the height is a ~5px cap, under the size a glyph is reliably
// identifiable at white on a mid-hue field, so it passed 10. That call site is
// gone — the chip falls back to a quiet plate now, because beside the host STRING
// the letter only restated it and doubled the slot's own mark (link-media.tsx's
// `Favicon` carries the argument). Every box this is drawn in is a 64x40 slot
// again, so the knob went with it. Bring it back only for a caller that stands
// this tile in a box small enough for half its height to be illegible.
//
// Not to be confused with link-media.tsx's PreviewFallbackPanel, which is the
// CARD's image-less banner: same hue family, but its letter is a fixed `text-4xl`
// rather than a fraction of the box, because a 12:7 banner 230px tall would draw
// a 115px letter under this component's rule.

import { hueFromHost, initialFromHost } from '@stxapps/shared';

// The letter's size in viewBox units — i.e. half the box's SHORT edge, since the
// viewBox is anchored to a height of 16. See the header for why this is a
// constant again rather than a prop.
const FONT_SIZE = 8;

export function HostMonogram({
  host,
  className,
  ratio = 1,
  rx = 3,
}: {
  host: string;
  className?: string;
  // Width ÷ height of the box `className` sizes. See the header — it must match,
  // and a mismatch letterboxes rather than distorts.
  ratio?: number;
  // Corner radius in viewBox units (3/16 of the height by default), so it scales
  // with the box. `0` when the parent clips.
  rx?: number;
}) {
  const letter = initialFromHost(host);
  const hue = hueFromHost(host);
  // The viewBox is anchored to a height of 16 and widened, never the other way
  // round, which is what keeps `FONT_SIZE` and `rx` reading against the SHORT edge
  // at any aspect — the letter is then the same fraction of the tile's height in
  // a 16:10 slot as in a square one.
  const width = 16 * ratio;

  return (
    <svg viewBox={`0 0 ${width} 16`} className={className} aria-hidden>
      <rect width={width} height="16" rx={rx} fill={`hsl(${hue} 45% 45%)`} />
      <text
        x={width / 2}
        // Below centre, not at it: `central` centres the EM box, not the cap, so a
        // capital reads high without the nudge. The correction is proportional to
        // the letter size — 0.5 was tuned against a size of 10 — so it stays
        // spelled as that ratio rather than as the constant it now works out to,
        // and it survives a future caller moving `FONT_SIZE`.
        y={8 + FONT_SIZE / 20}
        textAnchor="middle"
        dominantBaseline="central"
        // PINNED ACROSS APPS, with nothing to enforce it. bracemark-expo can't use
        // this component (it's RN, not SVG), so two files there hard-code the pixel
        // size this rule works out to in their own boxes, and both go quietly out of
        // step if the numbers here move — which breaks "same site, same mark" across
        // the share sheet, the browser extension's popup and the library. Both are
        // now the one size, 8/16 of a 40px-tall slot, spelled `text-xl`:
        //
        //   features/share/share-specimen.tsx
        //   features/links/link-media.tsx — `HostMonogram`'s default, taken by
        //                                   PreviewFallbackIcon (its host chip
        //                                   drew a `text-[10px]` tile until that
        //                                   fell back to a plate — see `Favicon`)
        fontSize={FONT_SIZE}
        fontWeight="600"
        fill="#fff"
      >
        {letter}
      </text>
    </svg>
  );
}
