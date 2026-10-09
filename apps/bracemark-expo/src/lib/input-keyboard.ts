import type * as React from 'react';
import { Platform, type TextInput } from 'react-native';

// What a field asks of the KEYBOARD, as opposed to what it tells autofill
// (ui/input.tsx owns that default). Two answers live here because each has more
// than one call site and neither is visible when it is missing — no lint error,
// no type error, and jest draws no keyboard (docs/editors.md, _typing
// assistance_).

// RETURN ON A FIELD THAT HAS A NEXT ONE GOES TO IT. A single-line field's
// default is `'blurAndSubmit'`, so Return on a username put the keyboard away
// and the password under it cost a tap to reach — on a form whose whole job is
// two fields in a row. Three props, and they only work together: the key says
// "next"; `submitBehavior="submit"` is what keeps the keyboard up (without it
// the field blurs first and the focus below re-raises a keyboard that had just
// started to fall); and the handler moves the focus. Web needs none of this — a
// browser walks a form's fields itself.
//
// The field this is spread on has thereby given up Return as a way to DISMISS,
// which docs/soft-keyboard.md (_dismissal_, 1) requires another path for. Every
// host today is a KeyboardAwareScrollView that persists taps and dismisses on
// drag (auth-screen.tsx, settings/scroll-host.tsx); check that before adding one.
export function advanceTo(next: React.RefObject<TextInput | null>) {
  return {
    returnKeyType: 'next',
    submitBehavior: 'submit',
    onSubmitEditing: () => next.current?.focus(),
  } as const;
}

// A SECRET SHOWN IN THE CLEAR IS STILL A SECRET TO THE KEYBOARD. Measured on
// the Pixel 8 AVD with Gboard: a revealed password is an ordinary text field
// (`0x80001`) and the keyboard shows what was typed in its suggestion strip.
// `keyboardType="visible-password"` is React Native's Android spelling for a
// password the user asked to see; with it the same field reads `0x80090`, and
// Gboard switches to its password keyboard — a number row, no strip, no
// microphone. The recovery code, which is never masked, gets the same
// (`0x81090`) and KEEPS its `autoCapitalize="characters"`: the keys come up
// in capitals.
//
// Android only: iOS has no such type, React Native maps the value to the default
// keyboard there, and the hints ui/input.tsx already sets are what iOS reads.
// A function, not a constant, so a spec can ask it as either platform.
//
// ⚠ Two things nothing reports:
//  - What React Native sets is the VARIATION without the text class (`0x90`,
//    where Android's own constant pairing is `0x91`). Gboard honours it; another
//    keyboard is free not to. This is a hint, like every other one here.
//  - On a field that also toggles `secureTextEntry`, it must not arrive in the
//    same update as the un-masking — features/auth/password-input.tsx carries
//    the measurement and the one-commit delay that answers it. A field that is
//    never masked (the recovery code) can simply pass it.
export function shownSecretKeyboardType() {
  return Platform.OS === 'android' ? ('visible-password' as const) : undefined;
}
