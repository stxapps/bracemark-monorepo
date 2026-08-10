import { type ReactNode, useState } from 'react';
import { type ColorValue, type LayoutChangeEvent, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useCSSVariable } from 'uniwind';

// The auth card, with its top-right corner taken off at 45° — the brand mark's
// own gesture (a page corner turned down to keep a place; see
// components/icons/bracemark-icon.tsx) performed at screen scale. It is the RN
// port of bracemark-web's `(auth)/layout.tsx` `DogEaredCard`, and everything that
// file decides is inherited rather than re-argued: the fold is the ONE memorable
// thing on these two screens and everything around it stays plain, because a
// sign-in box that reaches for two ideas reads as a phishing page rather than a
// designed one.
//
// SIZE. 24px (web's 1.5rem), and it is set against the card rather than against
// the mark's own 29% ratio: a step above the 16px corner radius it sits beside,
// so it can't be misread as a heavier rounding, and level with the 24px padding
// it aligns to. The mark's ratio only reads as a silhouette on ~40px objects
// (docs/brand-assets.md, _the mark_); at card scale it would be a shape, not a fold.
//
// WHY AN SVG AND NOT A CLIPPED VIEW. Web draws this as two stacked elements
// sharing a `clip-path` — a 1px sheet of the ring colour with the card inset
// into it — because `clip-path` erases the ring along with everything else. RN
// has no clip-path at all, so the usual native trick is a rotated square in the
// PAGE colour laid over the corner. That trick cannot carry a hairline: the
// diagonal would be the only one of the card's five edges with no border, which
// is exactly the edge the whole device is about. So the card's outline is one
// filled-and-stroked path instead, sized from the content's measured box. One
// element, a real hairline the whole way round, and the fold is a property of
// the shape rather than something painted over it.
//
// NO SHADOW, deliberately, where web has a weak `drop-shadow`. Web needs it
// because `clip-path` erases a box-shadow and because a white card on `--muted`
// is a 3% step there; RN's `shadow-*` would paint the shadow of the CONTENT
// BOX — a plain rectangle — so the fold would sit inside a rectangular halo and
// read as a chipped corner rather than a turned one. Web's own note says the
// shadow doesn't show in dark and that the card separates by lightness there;
// on native the stroked hairline does that job in both themes.
//
// Colours come from the active Uniwind theme via `useCSSVariable`, the same
// mechanism and reasoning as the mark itself: react-native-svg takes fill and
// stroke as PROPS, so there is no `currentColor` and no className to resolve
// against. They re-read when `Uniwind.setTheme` fires (components/theme-provider).

const RADIUS = 16; // rounded-2xl, matching the Card the rest of the app uses
const CUT = 24; // the fold — one step above RADIUS (see SIZE above)
const HAIRLINE = 1;

// The card's outline as one closed path: three rounded corners and, at the top
// right, a straight 45° chamfer where the fourth would be. Inset by half the
// stroke so the hairline lands fully inside the viewport instead of being
// clipped down to half a pixel on every edge.
function outlinePath(width: number, height: number): string {
  const i = HAIRLINE / 2;
  const right = width - i;
  const bottom = height - i;

  return [
    `M ${i + RADIUS} ${i}`,
    `L ${right - CUT} ${i}`, // top edge, stopping short of the fold
    `L ${right} ${i + CUT}`, // the fold itself
    `L ${right} ${bottom - RADIUS}`,
    `A ${RADIUS} ${RADIUS} 0 0 1 ${right - RADIUS} ${bottom}`,
    `L ${i + RADIUS} ${bottom}`,
    `A ${RADIUS} ${RADIUS} 0 0 1 ${i} ${bottom - RADIUS}`,
    `L ${i} ${i + RADIUS}`,
    `A ${RADIUS} ${RADIUS} 0 0 1 ${i + RADIUS} ${i}`,
    'Z',
  ].join(' ');
}

export function DogEaredCard({ children }: { children: ReactNode }) {
  // The outline is drawn to the CONTENT's measured box, so the shape can't
  // disagree with what it wraps: a taller step of the create-account ceremony
  // simply re-lays out and the next frame redraws the path. Zero until the
  // first layout, which renders no path at all — one frame of bare content on a
  // screen that is already behind a guard, rather than a wrongly-sized outline.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  };

  const [card, border] = useCSSVariable(['--color-card', '--color-border']);

  return (
    <View onLayout={onLayout}>
      {box.width > 0 && box.height > 0 && (
        <View className="absolute inset-0" style={{ pointerEvents: 'none' }}>
          <Svg width={box.width} height={box.height}>
            <Path
              d={outlinePath(box.width, box.height)}
              fill={asColor(card)}
              stroke={asColor(border)}
              strokeWidth={HAIRLINE}
            />
          </Svg>
        </View>
      )}

      {/* The content sits ON the outline, inset to the same 24px the fold is cut
          at — so nothing can land in the missing corner, and the top-right of
          the card is empty by construction rather than by each caller
          remembering to leave it alone. */}
      <View className="p-6">{children}</View>
    </View>
  );
}

// `useCSSVariable` is typed `string | number | undefined` because on native
// Uniwind can hand back an already-processed colour int — RN accepts that at
// runtime, but `ColorValue` doesn't admit it. The same cast as the mark's.
const asColor = (value: string | number | undefined) => value as ColorValue | undefined;
