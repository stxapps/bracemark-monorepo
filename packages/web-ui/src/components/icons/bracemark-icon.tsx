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
// Geometry lives on a 38×44 grid: 9-wide stem, 6-wide bars, an 11-unit corner
// cut. Keep the viewBox if you retouch it — `bracemark-expo`'s port copies these
// numbers, and the icon PNGs are rendered from this path.
export function BracemarkIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="38"
      height="44"
      viewBox="0 0 38 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M4 0H22L33 11V16A5 5 0 0 1 28 21A9 11.5 0 0 1 28 44H4A4 4 0 0 1 0 40V4A4 4 0 0 1 4 0ZM9 6H21A5.5 5.5 0 0 1 21 17H9ZM9 25H24.5A6.5 6.5 0 0 1 24.5 38H9Z"
        fillRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}
