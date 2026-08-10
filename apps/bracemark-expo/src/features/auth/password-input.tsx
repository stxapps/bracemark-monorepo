import * as React from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';

// A password field with a show/hide reveal toggle — the native port of web-ui's
// components/auth/password-input.tsx (see that file for why a reveal toggle
// beats a separate "confirm password" input: same typo protection, half the
// typing, and it composes with the generated-passphrase path). RN differences:
// `secureTextEntry` instead of type=password, and the platform's own
// autofill/keyboard hints (`autoComplete` / iOS `textContentType`) are supplied
// by the caller alongside the rest of the TextInput props.
export function PasswordInput({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof Input> & React.RefAttributes<TextInput>) {
  const [show, setShow] = React.useState(false);
  return (
    <View className="relative">
      <Input
        ref={ref}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        className={cn('pr-10', className)}
        {...props}
      />
      <Pressable
        onPress={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 justify-center px-3"
      >
        <Icon as={show ? EyeOff : Eye} className="size-4 text-muted-foreground" />
      </Pressable>
    </View>
  );
}
