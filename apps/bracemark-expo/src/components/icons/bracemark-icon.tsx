import { type ColorValue } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useCSSVariable } from 'uniwind';

// The bracemark mark — the RN port of web-ui's `components/icons/bracemark-icon.tsx`
// (byte-identical path + viewBox: a solid B with its top-right corner cut away
// like a turned page). Read that file for what the shape is doing and why the
// two counters are evenodd holes in the same path rather than filled discs.
//
// Kept in-app (not a package) since bracemark-expo is the only expo surface, like
// the react-native-reusables copies. Defaults to web's `h-6` render size (24px
// tall), preserving the 38:44 viewBox aspect.
//
// react-native-svg takes the fill as a PROP, not a className, so `currentColor`
// — which is all the web copy needs — has nothing to resolve against here; the
// colour comes from the active Uniwind theme via `useCSSVariable`, the same
// mechanism and the same reasoning as `components/ui/switch.tsx`. It re-reads
// when `Uniwind.setTheme` fires (components/theme-provider.tsx), and reading the
// var beats a `useTheme()` branch over hardcoded hexes, which would duplicate
// global.css and drag the settings data layer into any spec that renders the
// mark. It is `--color-foreground` rather than a brand-owned token on purpose:
// every call site puts the mark in foreground-coloured text, so this matches
// web's `currentColor` exactly. Only a native build proves it resolves — jest
// mocks `uniwind`, and the hook returns undefined there.
export function BracemarkIcon({ height = 24 }: { height?: number }) {
  const [foreground] = useCSSVariable(['--color-foreground']);

  return (
    <Svg width={(height * 38) / 44} height={height} viewBox="0 0 38 44" fill="none">
      <Path
        d="M4 0H22L33 11V16A5 5 0 0 1 28 21A9 11.5 0 0 1 28 44H4A4 4 0 0 1 0 40V4A4 4 0 0 1 4 0ZM9 6H21A5.5 5.5 0 0 1 21 17H9ZM9 25H24.5A6.5 6.5 0 0 1 24.5 38H9Z"
        fillRule="evenodd"
        fill={asColor(foreground)}
      />
    </Svg>
  );
}

// `useCSSVariable` is typed `string | number | undefined` because on native
// Uniwind can hand back an already-processed color int — RN accepts that at
// runtime, but `ColorValue` (string | OpaqueColorValue) doesn't admit it. The
// same cast as `components/ui/switch.tsx`.
const asColor = (value: string | number | undefined) => value as ColorValue | undefined;
