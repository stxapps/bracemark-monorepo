import { type ColorValue, Platform, Switch as RNSwitch, type SwitchProps } from 'react-native';
import { useCSSVariable, useUniwind } from 'uniwind';

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
// contexts/theme-provider.tsx). Reading them here rather than hardcoding hexes
// is what keeps this in sync with `global.css`, and reading them from Uniwind
// rather than our own `useTheme()` keeps this folder free of app contexts (every
// sibling imports nothing but `../../lib/utils`; `useTheme` also throws without
// its provider, which would drag the settings data layer into any spec that
// renders a switch).
//
// On iOS the token names mirror web-ui's `ui/switch.tsx` — track: `primary` when on,
// `input` when off; thumb: `primary-foreground` when on, and when off
// `background` in light but `foreground` in dark. That last one is the only
// light/dark branch, and web carries it too (`dark:data-[state=unchecked]:
// bg-foreground`): the off thumb has to stay LIGHT in both themes, and no single
// token is. `background` alone — what this file used first — flips to near-black
// in dark, so the thumb was the page's own color and read as a hole in the track.
//
// ANDROID takes a different mapping, because its switch is a different shape. RN
// renders `SwitchCompat` there: a thin track with a thumb LARGER than it, so most
// of the thumb is drawn over the page, not over the track. The mapping above
// contrasts the thumb with the track — right for iOS and web, where the thumb
// sits inside it — and on Android that left a dark-mode thumb in `background` /
// `primary-foreground`, i.e. near-black on a near-black page, in both states. So
// Android follows the platform's own convention instead: the THUMB carries the
// on color (`primary`) and the on track drops back to a mid grey (`ring`). Off,
// the thumb is a light grey that still reads against the page — `input` in light,
// `muted-foreground` in dark. `background` was tried for light and washed out on
// a device: a white disc on a white page, held only by the drawable's baked-in
// shadow. The off track is `input` only in dark, for the same reason — in light
// it is a pale grey that vanished beside that thumb — so light takes `ring` there
// too, and on/off is told by the thumb (near-black vs pale) and its side, as on a
// stock Material switch.
//
// Only a native build proves the tokens resolve: jest mocks `uniwind`, and the
// hook returns `undefined` (RN then falls back to its own defaults) for any var
// missing from the generated theme.

function Switch({ value, ...props }: SwitchProps) {
  const { theme } = useUniwind();
  const [primary, input, primaryForeground, background, foreground, ring, mutedForeground] =
    useCSSVariable([
      '--color-primary',
      '--color-input',
      '--color-primary-foreground',
      '--color-background',
      '--color-foreground',
      '--color-ring',
      '--color-muted-foreground',
    ]);
  const dark = theme === 'dark';
  const { trackOn, trackOff, thumbOn, thumbOff } =
    Platform.OS === 'android'
      ? {
          trackOn: ring,
          trackOff: dark ? input : ring,
          thumbOn: primary,
          thumbOff: dark ? mutedForeground : input,
        }
      : {
          trackOn: primary,
          trackOff: input,
          thumbOn: primaryForeground,
          thumbOff: dark ? foreground : background,
        };

  return (
    <RNSwitch
      value={value}
      // `ios_backgroundColor` as well as `trackColor.false`: on iOS the off-track
      // shows through mid-animation unless both are set.
      trackColor={{ false: asColor(trackOff), true: asColor(trackOn) }}
      ios_backgroundColor={asColor(trackOff)}
      thumbColor={asColor(value ? thumbOn : thumbOff)}
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
