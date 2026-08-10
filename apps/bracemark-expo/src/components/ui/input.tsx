import { Platform, TextInput } from 'react-native';
import { useUniwind } from 'uniwind';

import { MAX_FONT_SIZE_MULTIPLIER } from '../../lib/font-scale';
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
// `{...props}` spread so a call site can still override it; and
// `keyboardAppearance` bound to the active theme (below).

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
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      keyboardAppearance={theme === 'dark' ? 'dark' : 'light'}
      {...props}
    />
  );
}

export { Input };
