import * as React from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { shownSecretKeyboardType } from '../../lib/input-keyboard';
import { cn } from '../../lib/utils';

// A password field with a show/hide reveal toggle — the native port of web-ui's
// components/auth/password-input.tsx (see that file for why a reveal toggle
// beats a separate "confirm password" input: same typo protection, half the
// typing, and it composes with the generated-passphrase path). RN differences:
// `secureTextEntry` instead of type=password, and the platform's own
// autofill/keyboard hints (`autoComplete` / iOS `textContentType`) are supplied
// by the caller alongside the rest of the TextInput props. Same caller rule as
// web: never pass `secureTextEntry` back in — `{...props}` spreads last and would
// pin the field masked while the eye keeps flipping its `aria-label`.
//
// No typing hints of its own: exact entry is `Input`'s default, and it holds
// while the value is shown (docs/editors.md, _typing assistance_). What the
// reveal DOES change is the keyboard's view of the field, on Android — see
// lib/input-keyboard.ts.
export function PasswordInput({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof Input> & React.RefAttributes<TextInput>) {
  const [show, setShow] = React.useState(false);
  // THE KEYBOARD TYPE TRAILS THE REVEAL BY ONE COMMIT, and it has to. On Android
  // `secureTextEntry={false}` and `keyboardType="visible-password"` write the
  // same input-type bits (React Native clears `0x90` for the first and sets it
  // for the second), and delivered in ONE update the clear lands last: measured
  // on the Pixel 8 AVD, the field came out `0x80000` — no input class at all —
  // and Gboard went on showing the revealed password in its suggestion strip,
  // exactly as it does with no keyboard type (`0x80001`). One commit later the
  // type stands alone and sticks: `0x80090`, the password keyboard, no strip.
  // Re-hiding needs no such care — `secureTextEntry` on its own settles it
  // (`0x80081`). password-input.spec.tsx pins the order; nothing else would
  // notice.
  const [revealSettled, setRevealSettled] = React.useState(false);
  React.useEffect(() => {
    setRevealSettled(show);
  }, [show]);
  return (
    <View className="relative">
      <Input
        ref={ref}
        secureTextEntry={!show}
        keyboardType={show && revealSettled ? shownSecretKeyboardType() : undefined}
        className={cn('pr-10', className)}
        {...props}
      />
      <Pressable
        role="button"
        onPress={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 justify-center px-3"
      >
        <Icon as={show ? EyeOff : Eye} className="size-4 text-muted-foreground" />
      </Pressable>
    </View>
  );
}
