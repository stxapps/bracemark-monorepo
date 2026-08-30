import { Platform, TextInput } from 'react-native';
import { useUniwind } from 'uniwind';

import { allowsFontScaling, MAX_FONT_SIZE_MULTIPLIER } from '../../lib/font-scale';
import { cn } from '../../lib/utils';

// react-native-reusables `input` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative; `font-sans` added to the base classes — RN has no CSS
// cascade, so Inter must be applied where text renders (same reason as the
// `Text` base variant); and the `placeholderClassName` destructure dropped —
// that's NativeWind's prop name, which Uniwind neither types nor reads (its
// equivalent is `placeholderTextColorClassName`, already covered by the
// `placeholder:` variant in the classes below); `maxFontSizeMultiplier`
// defaulted — this is the second of the two font-scale-cap chokepoints (the
// first is `text.tsx`; lib/font-scale.ts carries the rationale), set before the
// `{...props}` spread so a call site can still override it; `allowFontScaling`
// asked rather than left to RN's `true`, since scaling is BROKEN in the iOS
// share-extension process and a typed character there renders at zero point
// (lib/font-scale.ts owns that story — the pickers' fields are the sites it
// saves); and `keyboardAppearance` bound to the active theme (below).

// THE `md:text-sm` IN THE WEB BRANCH IS UPSTREAM'S CONTROL TYPE STEP, AND IT IS
// DELIBERATELY NOT PORTED. The reason is PROVENANCE, not width. web-ui runs that
// step across five controls — Input, Textarea, both combobox triggers and
// CommandInput — 16px below `md`, 14px at or above (its input.tsx carries the
// argument), and the two halves are not a type scale with a breakpoint in it:
// `text-sm` is the kit's real control size, and `text-base` is a CONCESSION to
// iOS Safari, which zooms the page when a field under 16px takes focus. Port it
// and a browser bug's shape decides the native type scale. (Same reading, other
// direction, as bracemark-extension pinning all five back to 14px: `md:` there
// is a proxy for "touch phone", never for how much room there is.)
//
// Asked on its own terms instead, the native answer is 16 AT EVERY WIDTH. iOS
// puts body at 17pt and Material puts a text field's value at 16sp, and neither
// steps type by device class — a size class governs layout, not type — so 16
// here is the platform's number and not the phone's leaking onto a tablet. A
// tablet is also as touch-only as a phone, which makes a step whose premise is
// "this device is not touch" exactly backwards there. Hence a flat `text-base`,
// which the counterpart controls inherit rather than restate: ListSelect's
// trigger is a `Text` at that same default, and TagsField, ListCommand and both
// share pickers open with this Input at the top of the panel.
//
// It would also not sit STILL. Uniwind resolves a breakpoint against the window
// and re-resolves on every `Dimensions` change, so a ported step would re-type
// the controls as an iPad Split View divider crosses 768, and on rotation once
// the app is not portrait-locked. Related and NOT settled: the `sm:h-9` below,
// and Button's and DropdownMenu's `sm:` steps, are the same registry's answer to
// the same web question and they DO fire on a large screen — shrinking touch
// targets on a device that is entirely touch. They are invisible today only
// because iOS is `supportsTablet: false` and Android is portrait-locked. Settle
// those with the tablet layout; this file's answer is the type only. The one native control below it is the advanced-search WordField's
// filter box (`h-8 text-sm`, features/links/search-bar.tsx) — dense on purpose,
// and the one place the two clients now differ: its web twin takes the step
// (`h-8 text-base md:h-7 md:text-sm`), because there it is a field a phone can
// zoom. Same 32px box on a phone either way; only the type differs, and only
// because one runtime has a browser under it.
function Input({
  className,
  ...props
}: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) {
  // iOS renders the system keyboard LIGHT regardless of the app's appearance
  // unless asked — the rest of the app themes itself through Uniwind's CSS
  // variables, which the native keyboard obviously can't read, so this is the
  // one place the theme has to be lifted back into JS. `useUniwind()` is the
  // reader for that (uniwind resolves `hasAdaptiveThemes` against the device
  // setting, so this follows a system light/dark switch). No-op on Android,
  // where the keyboard follows the system theme on its own.
  const { theme } = useUniwind();
  return (
    <TextInput
      className={cn(
        'flex h-10 w-full min-w-0 flex-row items-center rounded-md border border-input bg-background px-3 py-1 font-sans text-base leading-5 text-foreground shadow-sm shadow-black/5 sm:h-9 dark:bg-input/30',
        props.editable === false &&
          cn(
            'opacity-50',
            Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' }),
          ),
        Platform.select({
          web: cn(
            'transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground md:text-sm',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
          ),
          native: 'placeholder:text-muted-foreground/50',
        }),
        className,
      )}
      allowFontScaling={allowsFontScaling()}
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      keyboardAppearance={theme === 'dark' ? 'dark' : 'light'}
      {...props}
    />
  );
}

export { Input };
