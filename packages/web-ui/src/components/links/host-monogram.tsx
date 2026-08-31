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
// to be passed in per caller and kept in step with it. Today: `size-4` beside a
// host, `size-4` in the list row's preview slot, and the popup specimen's whole
// 64x40 slot.
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
// `fontSize` is per-caller for the same reason `rx` is, and it is the one knob
// the single-component design could not carry as a constant. The letter is a
// FRACTION of the short edge, so one number has to serve boxes two decades
// apart: the 40px-tall preview slot, where 8/16 (the default, the usual
// monogram-avatar ratio) is right, and the 14-16px chip beside a host line,
// where that same 8 draws a ~5px cap — under the size a glyph is reliably
// identifiable at, white on a mid-hue field. link-media.tsx's `Favicon` passes
// 10 for exactly that; nothing else should need to.
//
// Not to be confused with link-media.tsx's PreviewFallbackPanel, which is the
// CARD's image-less banner: same hue family, but its letter is a fixed `text-4xl`
// rather than a fraction of the box, because a 12:7 banner 230px tall would draw
// a 115px letter under this component's rule.

import { hueFromHost, initialFromHost } from '@stxapps/shared';

export function HostMonogram({
  host,
  className,
  ratio = 1,
  rx = 3,
  fontSize = 8,
}: {
  host: string;
  className?: string;
  // Width ÷ height of the box `className` sizes. See the header — it must match,
  // and a mismatch letterboxes rather than distorts.
  ratio?: number;
  // Corner radius in viewBox units (3/16 of the height by default), so it scales
  // with the box. `0` when the parent clips.
  rx?: number;
  // Letter size in viewBox units, i.e. a fraction of the box's SHORT edge. The
  // default 8 is half of it. Raise it for a box small enough that half its height
  // is an illegible cap — see the header.
  fontSize?: number;
}) {
  const letter = initialFromHost(host);
  const hue = hueFromHost(host);
  // The viewBox is anchored to a height of 16 and widened, never the other way
  // round, which is what keeps `fontSize` and `rx` reading against the SHORT edge
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
        // the font size — 0.5 was tuned against a fontSize of 10 — so it is spelled
        // as that ratio rather than as the constant 8.5 it used to be, and it stays
        // right as callers move `fontSize`.
        y={8 + fontSize / 20}
        textAnchor="middle"
        dominantBaseline="central"
        // PINNED ACROSS APPS, with nothing to enforce it. bracemark-expo can't use
        // this component (it's RN, not SVG), so two files there hard-code the pixel
        // size this rule works out to in their own boxes, and both go quietly out of
        // step if the numbers here move — which breaks "same site, same mark" across
        // the share sheet, the extension popup and the library:
        //
        //   features/share/share-specimen.tsx — `text-xl`, i.e. 8/16 x its 40px slot
        //   features/links/link-media.tsx     — `Monogram`'s two sizes, the row
        //                                       slot's `text-xl` (8/16 x 40) and the
        //                                       host chip's `text-[10px]`, which
        //                                       tracks `Favicon`'s fontSize={10}
        //                                       against a 16px tile
        fontSize={fontSize}
        fontWeight="600"
        fill="#fff"
      >
        {letter}
      </text>
    </svg>
  );
}
