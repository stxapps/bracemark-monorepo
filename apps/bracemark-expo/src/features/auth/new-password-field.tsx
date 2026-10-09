import * as React from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';

import { type FieldMessage, NEW_PASSWORD_COPY, newPasswordMessage } from '@stxapps/react';
import { canonicalizePassword, generatePassphrase, NEW_PASSWORD_MIN_LENGTH } from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { PasswordInput } from './password-input';
import { MESSAGE_TONE, PasswordStrengthMeter, usePasswordStrength } from './password-strength';
import { ShowOnceSecret } from './show-once-secret';

// CHOOSING A NEW PASSWORD — the native port of web-ui's
// components/auth/new-password-field.tsx. Read that file for the argument (why the
// generated passphrase is the default, why this is a hook plus a component, and why
// one component rather than the near-verbatim copy each of the two surfaces used to
// carry). Both surfaces here are the same two: create-account's setup step and
// Settings → change password. The words come from `NEW_PASSWORD_COPY` in
// `@stxapps/react`, which is the same module the web pair reads, so all four surfaces
// print one set of strings.
//
// Its two field labels are `text-sm` with the weight left unset, matching web's
// `FieldLabel` and the other two auth twins — sign-in-form.tsx carries the why.
// Both surfaces render this one component, so a weight typed back in here moves
// create-account and Settings → change password together.
//
// RN differences from the web file: a lazy state initializer instead of the
// generate-on-mount effect (that dance exists so SSR and hydration agree, and native
// has no SSR — hence no `passphrase !== ''` in the gate, the value is never empty);
// plain `Text` labels rather than the Field kit; `editable` rather than `disabled`;
// and the invalid border is spelled as a CLASS, not `aria-invalid` — expo's Input
// only wires `aria-invalid:` styles on the web platform (components/ui/input.tsx), so
// the settings copy of this block, which passed only the attribute, drew no
// destructive border on a phone at all. Both are set here: the class paints, the
// attribute announces.

export type NewPasswordControl = {
  mode: 'generated' | 'own';
  setMode: (mode: 'generated' | 'own') => void;
  passphrase: string;
  passphraseSaved: boolean;
  setPassphraseSaved: (saved: boolean) => void;
  ownPassword: string;
  setOwnPassword: (password: string) => void;
  regenerate: () => void;
  displayScore: number | null;
  message: FieldMessage;
  password: string;
  ok: boolean;
};

export function useNewPassword({
  username,
}: { username?: string | null } = {}): NewPasswordControl {
  const [mode, setMode] = React.useState<'generated' | 'own'>('generated');
  const [passphrase, setPassphrase] = React.useState(() => generatePassphrase());
  const [passphraseSaved, setPassphraseSaved] = React.useState(false);
  const [ownPassword, setOwnPassword] = React.useState('');

  // Strength only matters on the typed path — the generated passphrase is ~77 bits by
  // construction. Score the CANONICAL form, the exact string the KEK derives from.
  const { guessesLog10, displayScore } = usePasswordStrength(
    mode === 'own' ? canonicalizePassword(ownPassword) : '',
    username ? [username] : [],
    NEW_PASSWORD_MIN_LENGTH,
  );
  const message = newPasswordMessage(ownPassword, guessesLog10);

  const regenerate = React.useCallback(() => {
    setPassphrase(generatePassphrase());
    setPassphraseSaved(false);
  }, []);

  return {
    mode,
    setMode,
    passphrase,
    passphraseSaved,
    setPassphraseSaved,
    ownPassword,
    setOwnPassword,
    regenerate,
    displayScore,
    message,
    password: mode === 'generated' ? passphrase : ownPassword,
    ok: mode === 'generated' ? passphraseSaved : message.tone === 'ok',
  };
}

export function NewPasswordField({
  control,
  copy: which,
  disabled,
  // Called on every change to the new password — typing, either mode switch,
  // regenerate. Settings hangs its "Incorrect password." reset off this; nothing on
  // create-account needs it.
  onEdit,
  inputRef,
}: {
  control: NewPasswordControl;
  copy: 'create' | 'change';
  disabled?: boolean;
  onEdit?: () => void;
  // The typed-password field, for a host whose previous field hands Return on to
  // it (lib/input-keyboard.ts). There is nothing to point at in generated mode —
  // no field is shown — so a host checks `control.mode` before it advances.
  inputRef?: React.Ref<TextInput>;
}) {
  const copy = NEW_PASSWORD_COPY[which];
  const {
    mode,
    setMode,
    passphrase,
    passphraseSaved,
    setPassphraseSaved,
    ownPassword,
    setOwnPassword,
    regenerate,
    displayScore,
    message,
  } = control;

  // Only in typed mode: `invalid` is a claim that the value the user TYPED is
  // rejected, and in generated mode there is no typed value (the ladder is scoring an
  // empty string). See field-messages.ts on what `error` promises.
  const invalid = mode === 'own' && message.tone === 'error';

  if (mode === 'generated') {
    return (
      <View className="gap-2">
        <Text className="text-sm">{copy.label}</Text>
        <Text className="text-sm text-muted-foreground">{copy.generatedHelp}</Text>
        <ShowOnceSecret
          secret={passphrase}
          label={copy.secretLabel}
          saved={passphraseSaved}
          onSavedChange={setPassphraseSaved}
          confirmLabel={copy.confirmLabel}
          // Both change WHICH password you end up with, so they ride in the panel's
          // `actions` slot — under the value, above Copy. Regenerate also clears the
          // saved checkbox below; sitting above it is what makes that reset read as
          // cause and effect.
          actions={
            <View className="flex-row items-center justify-between">
              <Pressable
                role="button"
                disabled={disabled}
                onPress={() => {
                  regenerate();
                  onEdit?.();
                }}
                className={cn('flex-row items-center gap-1.5 py-1', disabled && 'opacity-50')}
              >
                <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">{copy.regenerate}</Text>
              </Pressable>
              <Pressable
                role="button"
                onPress={() => {
                  setMode('own');
                  onEdit?.();
                }}
                className="py-1"
              >
                <Text className="text-sm text-muted-foreground underline">{copy.chooseOwn}</Text>
              </Pressable>
            </View>
          }
        />
      </View>
    );
  }

  return (
    <View className="gap-2">
      {/* RN has no <label for>, so the input is named directly rather than by the
          Text above it. */}
      <Text className="text-sm">{copy.label}</Text>
      <PasswordInput
        ref={inputRef}
        aria-label={copy.label}
        aria-invalid={invalid}
        autoComplete="new-password"
        className={cn(invalid && 'border-destructive')}
        editable={!disabled}
        value={ownPassword}
        onChangeText={(text) => {
          setOwnPassword(text);
          onEdit?.();
        }}
      />
      <PasswordStrengthMeter displayScore={displayScore} />
      <Text className={cn('text-sm', MESSAGE_TONE[message.tone])}>{message.text}</Text>
      <Text className="text-sm text-muted-foreground">
        {copy.ownHelp}{' '}
        <Text
          className="text-sm text-muted-foreground underline"
          onPress={() => {
            setMode('generated');
            onEdit?.();
          }}
        >
          {copy.generateInstead}
        </Text>
      </Text>
    </View>
  );
}
