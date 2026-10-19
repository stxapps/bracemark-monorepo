import { type LayoutChangeEvent, Platform, TextInput } from 'react-native';
import { useUniwind } from 'uniwind';

import { allowsFontScaling, MAX_FONT_SIZE_MULTIPLIER } from '../../lib/font-scale';
import { ellipsizePlaceholder } from '../../lib/placeholder-ellipsis';
import { cn } from '../../lib/utils';

// react-native-reusables `input` (uniwind variant), copied from the registry —
// see docs/setup.md for why the copy is manual (the CLI needs tsconfig path
// aliases; this app uses relative imports). Local changes vs upstream: imports
// rewritten to relative; `font-sans` added to the base classes — RN has no CSS
// cascade, so Inter must be applied where text renders (same reason as the
// `Text` base variant); and the `placeholderClassName` destructure dropped —
// that's NativeWind's prop name, which Uniwind neither types nor reads — with
// the placeholder colour moved to Uniwind's own `placeholderTextColorClassName`
// (below); `maxFontSizeMultiplier`
// defaulted — this is the second of the two font-scale-cap chokepoints (the
// first is `text.tsx`; lib/font-scale.ts carries the rationale), set before the
// `{...props}` spread so a call site can still override it; `allowFontScaling`
// asked rather than left to RN's `true`, since scaling is BROKEN in the iOS
// share-extension process and a typed character there renders at zero point
// (lib/font-scale.ts owns that story — the pickers' fields are the sites it
// saves); `keyboardAppearance` bound to the active theme (below); the line
// height unset on an iOS single-line field (below); and the
// radius raised to `rounded-4xl` from the registry's `rounded-md`, which is
// web-ui's shape system (docs/theme.md, _the radius scale_).
// The fill and the shadow moved with it: `bg-input/30` in BOTH themes, as web
// has it, rather than `bg-background` with a dark-only override, and no
// `shadow-sm shadow-black/5` — web-ui puts no shadow on any control
// (docs/theme.md, _the two kits_).
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
// trigger is a `Text` at that same default, and TagsCommand, ListCommand and both
// share pickers open with this Input at the top of the panel.
//
// It would also not sit STILL. Uniwind resolves a breakpoint against the window
// and re-resolves on every `Dimensions` change, so a ported step would re-type
// the controls as an iPad Split View divider crosses 768, and on rotation. The
// HEIGHT had the same question and now has the same answer: the registry's
// `sm:h-9` here, and Button's and DropdownMenu's `sm:` steps, were the same web
// answer — past 640px the pointer is probably a mouse — and they fired on
// exactly the screens that are all touch (a tablet, an unfolded foldable, a
// phone on its side), shrinking the target where there was MORE room for it.
// They went with the tablet layout: one height at every width
// (docs/safe-area.md, _wide windows on native_).
//
// The one native control below it is the advanced-search WordField's
// filter box (`h-8 py-0 text-sm`, features/links/search-bar.tsx) — dense on purpose,
// and the one place the two clients now differ: its web twin takes the step
// (`h-8 text-base md:h-7 md:text-sm`), because there it is a field a phone can
// zoom. Same 32px box on a phone either way; only the type differs, and only
// because one runtime has a browser under it.
// ON iOS A SINGLE-LINE FIELD GETS NO LINE HEIGHT, whatever it is passed.
// RN hands a TextInput's lineHeight to UITextField as a bare paragraph style,
// with none of the baseline compensation `Text` gets (RCTApplyBaselineOffset
// runs only on the attributed-string path; `defaultTextAttributes` skip it), so
// every point the line box has over the font's natural one (Inter: 1.21×)
// pushes the glyphs down by that much. Measured on the iPhone 17 Pro sim, caps
// against the 40pt border: `text-base leading-5` +0.50pt low; `text-sm`, which
// tailwind-merge lets a call site swap in with its own 20pt leading (the
// search-bar filter box) +3.17pt; `text-base` bare (24pt) +4.50pt; unset
// +0.17pt, which is half a device pixel, the floor. Unsetting it in `style`
// rather than in classes is what makes it hold at every call site: no Tailwind
// size step comes without a leading, and `leading-[normal]` reaches RN as the
// string "normal", which Fabric only survives by throwing. A later `undefined`
// in the style array is RN's own spelling of "not set", and it goes LAST, after
// the call site's `style` too: no lineHeight is right here — its only effect is
// the drop — so the call site doesn't get to win this one (a nudge is padding's
// job). It holds across re-renders (ReactNativeAttributePayload lets a later
// `undefined` override an earlier key that changed) but not across a Fast
// Refresh that ADDS it to a field already on screen, where there is nothing
// to override yet — relaunch before measuring it. Android centres the
// line box itself (docs/theme.md, _a leading tighter than the font_), and a
// multiline field (`Textarea`) needs the leading to space its lines.
const IOS_SINGLE_LINE_STYLE = { lineHeight: undefined };

// THE PLACEHOLDER'S COLOUR IS A PROP ON NATIVE, NOT A VARIANT. The registry's
// native branch said `placeholder:text-muted-foreground`, and on this side that
// class is EMPTY: Tailwind emits it as a nested `&::placeholder` rule, and
// Uniwind's processor keeps only the nested selectors it has a runtime answer
// for (theme, `active`, `focus`, `disabled`, `data-*`) — a pseudo-element is
// dropped with its declarations, silently (the probe in docs/theme.md,
// _extending_, prints `[{}]` for it). So no colour was ever set and each
// platform drew its own default hint: UIKit's `placeholderText`, a 30% alpha
// that reads Lc 16 on the dark field and 30 on the light one, and AppCompat's
// hint at 39 / 50 — against the Lc 62 / 70 this token gives and that web's
// fields already wear. Uniwind's lever is `placeholderTextColorClassName`,
// which resolves an `accent-*` utility to RN's `placeholderTextColor` and
// re-resolves it on a theme change. The token goes on whole — no `/NN`
// (docs/theme.md, _contrast_).
const PLACEHOLDER_COLOR_CLASS = 'accent-muted-foreground';

// AND ITS LENGTH IS A NATIVE CALL ON ANDROID, NOT A PROP AT ALL. A placeholder
// longer than a single-line field mounts on one line there and then WRAPS — the
// first time it changes, or the field is typed in and cleared — onto a second
// line the fixed-height box cuts in half, pushing the first one off-centre
// (modules/bracemark-input's Kotlin header has the two layout paths that
// disagree). Any field can do it; the one that did is the link editor's Title,
// whose placeholder is the page's extracted title and arrives after mount. The
// fix is an ellipsize mode on the native EditText, which React Native sets
// itself from 0.88 and has no prop for on 0.81, so it goes through the local
// module — and from HERE, so every field gets it and no call site has to know.
// iOS needs nothing: UITextField truncates its placeholder on its own.
//
// Off `onLayout` because that event is the first moment the native view is
// certain to exist (an effect can run before Fabric mounts it), and because its
// payload already carries the view's tag — React Native's Android layout event
// puts `target` beside `layout`, and its TypeScript type simply doesn't say so.
// The setting sticks to the view, so the repeat on a later layout is a no-op.
// Multiline fields are asked too and the native side declines them; a Textarea
// wraps on purpose.
const onAndroidLayout = (event: LayoutChangeEvent) => {
  const { target } = event.nativeEvent as { target?: number };
  if (typeof target === 'number') ellipsizePlaceholder(target);
};

function Input({
  className,
  style,
  onLayout,
  autoComplete = 'off',
  autoCapitalize = 'none',
  autoCorrect = false,
  spellCheck = false,
  smartInsertDelete = false,
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
        'flex h-10 w-full min-w-0 flex-row items-center rounded-4xl border border-input bg-input/30 px-3 py-1 font-sans text-base leading-5 text-foreground',
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
        }),
        className,
      )}
      placeholderTextColorClassName={PLACEHOLDER_COLOR_CLASS}
      style={[style, Platform.OS === 'ios' && !props.multiline && IOS_SINGLE_LINE_STYLE]}
      allowFontScaling={allowsFontScaling()}
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      keyboardAppearance={theme === 'dark' ? 'dark' : 'light'}
      // Off unless the field says what it is — web-ui's input.tsx has the
      // argument, and this is its native half. There is no browser form history
      // here; what there is, is the OS's autofill: left unset, Android offers
      // any field to the autofill service and iOS guesses at its purpose, so a
      // password manager can offer to SAVE a link's URL or a list-lock password
      // as if it were this app's login. React Native turns `off` into "not
      // important for autofill" on Android and `textContentType="none"` on iOS.
      // The credential fields name themselves (`username`, `current-password`,
      // `new-password`) and override this default. What this does not
      // reach is the keyboard's own learning, which belongs to the keyboard.
      autoComplete={autoComplete}
      // Exact entry, independent of autofill. iOS smartInsertDelete can adjust
      // spaces during paste/cut/delete, so it is off here too. Textarea and the
      // Title fields opt into prose assistance (docs/editors.md).
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      spellCheck={spellCheck}
      smartInsertDelete={smartInsertDelete}
      onLayout={
        Platform.OS === 'android'
          ? (event) => {
              onAndroidLayout(event);
              onLayout?.(event);
            }
          : onLayout
      }
      {...props}
    />
  );
}

export { Input };
