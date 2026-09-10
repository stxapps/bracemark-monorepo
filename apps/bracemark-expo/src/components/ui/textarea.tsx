import { cn } from '../../lib/utils';
import { Input } from './input';

// The multi-line control — web-ui's `textarea.tsx` ported, and the ONLY file in
// this folder with no react-native-reusables original behind it: the registry
// ships no textarea, so the "local changes vs upstream" list its siblings carry
// is this header, against `packages/web-ui/src/components/ui/textarea.tsx` as
// the source of truth (docs/theme.md, _the two kits_ — that section's list of
// web primitives with no native twin is one shorter for this file).
//
// IT WRAPS `Input` RATHER THAN RENDERING ITS OWN `TextInput`, which is the one
// place this kit's shape differs from web-ui's on purpose. web has two copies
// because the DOM has two elements; RN has one, and that one is a CHOKEPOINT —
// `input.tsx` is the second of the two font-scale caps (lib/font-scale.ts owns
// that story) and the single place the theme is lifted back into JS for
// `keyboardAppearance`. A second TextInput render site would be a third thing
// for the cap to cover and a second copy of the theme lift, both silent when
// they drift. So everything here is an OVERRIDE of four values, and every other
// property of a text field on this platform comes from one file.
//
// The four:
//   `rounded-xl` — docs/theme.md, _the radius scale_: the row for "any control
//     too tall to be a pill" already names textarea, and it is the same 12 web
//     spells. The corner-overlap rule that makes Input's `rounded-4xl` read as a
//     pill at 40pt does NOT fire on a box this tall, which is the whole reason
//     the scale has two entries. (Both call sites drew a 32px pill before this
//     file existed, having hand-rolled the control from Input at the call site —
//     the failure that section marks ⚠.)
//   `h-auto sm:h-auto min-h-16` — web's `field-sizing-content min-h-16`, value
//     for value: a floor of 64 that GROWS with the text. `min-h-*` alone would
//     not do it. `cn` is tailwind-merge, which drops Input's `h-10` for a
//     conflicting `h-*` but leaves `sm:h-9` standing — a different variant
//     scope is not a conflict — so the cancel has to be spelled at BOTH scopes
//     or a long note collapses to 36pt the day a screen is wide enough to match
//     `sm:`. Invisible today for input.tsx's reason (iOS `supportsTablet:
//     false`, Android portrait-locked) and therefore exactly the kind of thing
//     that ships. All three classes were run through the Uniwind probe
//     (docs/theme.md, _extending_): `h-auto` reaches RN as `height: "auto"`,
//     which is a valid DimensionValue, and the floor as a plain `minHeight`.
//     Growth itself is Fabric's: the TextInput shadow node measures its own
//     content and re-measures as it changes, so nothing here counts lines.
//   `py-3` — web's, and it belongs to the floor rather than to the type: 64
//     minus 24 of padding and 2 of border leaves 38 against a 20pt line, so the
//     resting box reads as most of two lines and the second one grows it. The
//     `h-20 py-2` this replaces was a FIXED box that scrolled inside itself
//     instead.
//   `textAlignVertical: 'top'` — Android centres multiline text in its box
//     otherwise. It stays an inline style: it is the real lever for text inside
//     a TextInput (Input's own `flex-row items-center` does not reach it), and
//     Tailwind's `align-*` compiles to `vertical-align`, a different property.
//
// The kit's "one step taller than web" rule (docs/theme.md, _the two kits_) is
// not in play here and the floor is web's own number: that step buys touch
// targets, and 64 clears any of them by half again — what this value decides is
// how many lines you see before typing, which is not a platform question.
function Textarea({ className, style, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      multiline
      className={cn('h-auto min-h-16 rounded-xl py-3 sm:h-auto', className)}
      style={[{ textAlignVertical: 'top' }, style]}
      {...props}
    />
  );
}

export { Textarea };
