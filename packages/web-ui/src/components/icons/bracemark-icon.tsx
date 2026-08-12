import * as React from 'react';

// The brand mark: a solid geometric B whose top-right corner is cut away at 45°,
// the way a page corner is turned down to keep a place. That cut is the whole
// job of the shape — "B" alone is a letter, and every bookmark app in the
// category owns a ribbon; a dog-eared B says letter and bookmark at once, and it
// is the only feature of the silhouette that is still legible at 16px.
//
// ONE path, ONE colour. The two counters are subpaths of the same `d` and are
// knocked out by `fill-rule="evenodd"`, so they are genuine holes rather than
// background-coloured discs. Two consequences worth keeping:
//
//   - the mark composes on ANY surface — a card, a coloured tile, the inverted
//     band on the marketing site — instead of only on `--background`;
//   - `currentColor` is then enough to theme it. The three call sites (both
//     sidebars, the site header/footer) render it inside foreground-coloured
//     text, so light and dark both come out right with no token, no `.dark`
//     override, and no `useTheme()` subscription. It still server-renders, and
//     its markup is identical in both themes, so hydration can't disagree.
//
// The earlier artwork needed a `--brand-mark`/`--brand-mark-dot` token pair for
// exactly the reason this one doesn't: its four dots were opaque white, so a
// near-black body on a dark background left four floating dots. Those tokens are
// gone from styles.css — don't reintroduce them.
//
// Geometry lives on a 428×512 grid — 512 is the size the largest icon PNG
// renders at, so the path is authored at raster scale and the numbers stay
// whole-ish: a 103-wide stem, bars 66–93 deep, a 128-unit corner cut (exactly
// 45°, 30% of the width), and a 48-unit radius on the three corners that are not
// cut. The two bowls bulge past the stem's grid as free cubics, while the
// counters they enclose are exact circular caps (r=64 upper, r=76 lower) — so
// the outer silhouette is drawn by eye and the holes are drawn by compass; don't
// "regularise" the outer curves to match the inner ones.
//
// Aspect is 428:512 ≈ 0.836 — every call site sizes by height (`h-5 w-auto`, or
// the `height` prop on native), so the width follows from the viewBox and no
// call site has to know that number. Keep the viewBox if you retouch it —
// `bracemark-expo`'s port copies these numbers, and the icon PNGs are rendered
// from this path.
export function BracemarkIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="428"
      height="512"
      viewBox="0 0 428 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M254.101 0L382.101 128C385.101 168 360.1 223.5 324.101 241C458.6 248.001 466.6 502.499 324.101 512H48C21.4903 512 0 490.51 0 464V48C0 21.4903 21.4903 0 48 0H254.101ZM103.101 443H286.101C328.074 443 362.101 408.973 362.101 367C362.101 325.027 328.074 291 286.101 291H103.101V443ZM103.101 198H245.101C280.447 198 309.101 169.346 309.101 134C309.101 98.6539 280.447 70.0003 245.101 70H103.101V198Z"
        fillRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}
