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
// tall), preserving the 428:512 viewBox aspect.
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
    <Svg width={(height * 428) / 512} height={height} viewBox="0 0 428 512" fill="none">
      <Path
        d="M254.101 0L382.101 128C385.101 168 360.1 223.5 324.101 241C458.6 248.001 466.6 502.499 324.101 512H48C21.4903 512 0 490.51 0 464V48C0 21.4903 21.4903 0 48 0H254.101ZM103.101 443H286.101C328.074 443 362.101 408.973 362.101 367C362.101 325.027 328.074 291 286.101 291H103.101V443ZM103.101 198H245.101C280.447 198 309.101 169.346 309.101 134C309.101 98.6539 280.447 70.0003 245.101 70H103.101V198Z"
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
