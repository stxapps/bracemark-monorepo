import { type ColorValue, Switch as RNSwitch, type SwitchProps } from 'react-native';
import { useCSSVariable } from 'uniwind';

// The ONE hand-written component in this folder — NOT a react-native-reusables
// registry copy like its siblings, and deliberately not the registry's `switch`.
// Do NOT "restore" this file from the registry.
//
// That copy sits on `@rn-primitives/switch`, which on native is a `Pressable`
// wrapping a `View`: the thumb position is a `translate-x-*` class and its
// `transition-transform` is a NO-OP on RN 0.81.5 (React Native has no CSS
// transitions at this version — Uniwind passes `transitionProperty` through and
// RN ignores it), so the thumb snaps with no slide and no drag gesture, and the
// control measures ~18x32pt with no `hitSlop` (unlike the registry's checkbox,
// which sets one). The platform `Switch` keeps the UISwitch/Material spring, the
// drag, the 44pt target, and the OS accessibility announcements — so the only
// thing the registry copy would have bought us is the palette, and that is what
// this wrapper borrows instead.
//
// React Native takes switch colors as PROPS, not classNames, so the tokens come
// from the active Uniwind theme via `useCSSVariable` — the same per-`@variant`
// vars `global.css` declares, re-read when `Uniwind.setTheme` fires (see
// components/theme-provider.tsx). Reading them here rather than hardcoding hexes
// is what keeps this in sync with `global.css`, and reading them from Uniwind
// rather than our own `useTheme()` keeps this folder free of app contexts (every
// sibling imports nothing but `../../lib/utils`; `useTheme` also throws without
// its provider, which would drag the settings data layer into any spec that
// renders a switch).
//
// The four token names mirror web-ui's `ui/switch.tsx` — track: `primary` when
// on, `input` when off; thumb: `primary-foreground` when on, `background` when
// off. Because each token already flips per theme, there is no light/dark branch
// here. Only a native build proves they resolve: jest mocks `uniwind`, and the
// hook returns `undefined` (RN then falls back to its own defaults) for any var
// missing from the generated theme.

function Switch({ value, ...props }: SwitchProps) {
  const [primary, input, primaryForeground, background] = useCSSVariable([
    '--color-primary',
    '--color-input',
    '--color-primary-foreground',
    '--color-background',
  ]);

  return (
    <RNSwitch
      value={value}
      // `ios_backgroundColor` as well as `trackColor.false`: on iOS the off-track
      // shows through mid-animation unless both are set.
      trackColor={{ false: asColor(input), true: asColor(primary) }}
      ios_backgroundColor={asColor(input)}
      thumbColor={asColor(value ? primaryForeground : background)}
      // Spread last so a call site can still override a color for a one-off.
      {...props}
    />
  );
}

// `useCSSVariable` is typed `string | number | undefined` because on native
// Uniwind can hand back an already-processed color int — RN accepts that at
// runtime, but `ColorValue` (string | OpaqueColorValue) doesn't admit it.
const asColor = (value: string | number | undefined) => value as ColorValue | undefined;

export { Switch };
