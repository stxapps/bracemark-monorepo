import * as React from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';

import { type FieldMessage, NEW_PASSWORD_COPY, newPasswordMessage } from '@stxapps/react';
import { canonicalizePassword, generatePassphrase, NEW_PASSWORD_MIN_LENGTH } from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { CopySecretTextButton, SECRET_TEXT_ACTION, SECRET_TEXT_SLOP } from './copy-secret-button';
import { PasswordInput } from './password-input';
import { MESSAGE_TONE, PasswordStrengthMeter, usePasswordStrength } from './password-strength';

// CHOOSING A NEW PASSWORD: ONE REAL FIELD, ALREADY FILLED — the native port of
// web-ui's components/auth/new-password-field.tsx, and like it the one field both
// create-account's first step and Settings → change password render. Read that file
// for the argument, including why Settings lost its generated panel and its switch to
// a typed field.
//
// RN differences: a lazy state initializer instead of the generate-on-mount effect (no
// SSR to agree with, so the value is never empty); plain `Text` labels rather than the
// Field kit; `editable` rather than `disabled`; and the invalid border is spelled as a
// CLASS as well as `aria-invalid`, because expo's Input wires `aria-invalid:` styles
// on the web platform only (components/ui/input.tsx): a settings field that passed
// only the attribute once drew no destructive border on a phone at all. The class
// paints, the attribute announces. No leaving the field after a fill: that is an iOS
// Safari sheet, and this app gets no strong-password offer from iOS at all, with no
// shared web credentials (docs/account.md, _creating an account_).

export type NewPasswordControl = {
  password: string;
  setPassword: (password: string) => void;
  regenerate: () => void;
  generated: boolean;
  displayScore: number | null;
  message: FieldMessage;
  ok: boolean;
};

// The meter's top band ("Strong", password-strength.tsx).
const STRONGEST = 3;

// `currentPassword` is change password's proof field, when the proof is a password: a
// new password equal to it is refused by the ladder (field-messages.ts).
export function useNewPassword({
  username,
  currentPassword,
}: {
  username?: string | null;
  currentPassword?: string;
}): NewPasswordControl {
  const [words, setWords] = React.useState(() => generatePassphrase());
  const [password, setPassword] = React.useState(words);

  const regenerate = React.useCallback(() => {
    const next = generatePassphrase();
    setWords(next);
    setPassword(next);
  }, []);

  const generated = password !== '' && password === words;

  // Nothing to score on the words themselves; the CANONICAL form otherwise, the exact
  // string the KEK derives from.
  const { guessesLog10, displayScore } = usePasswordStrength(
    generated ? '' : canonicalizePassword(password),
    username ? [username] : [],
    NEW_PASSWORD_MIN_LENGTH,
  );

  const message: FieldMessage = generated
    ? { text: NEW_PASSWORD_COPY.generated, tone: 'ok' }
    : newPasswordMessage(password, guessesLog10, false, currentPassword);

  return {
    password,
    setPassword,
    regenerate,
    generated,
    displayScore: generated ? STRONGEST : displayScore,
    message,
    ok: message.tone === 'ok',
  };
}

export function NewPasswordField({
  control,
  label,
  shownLabel,
  disabled,
  // Called on every change to the password, typed or regenerated. Settings hangs its
  // "Incorrect password." reset off this.
  onEdit,
  inputRef,
  testID,
}: {
  control: NewPasswordControl;
  label: string;
  // The name of the box that shows the whole password while it is revealed.
  shownLabel: string;
  disabled?: boolean;
  onEdit?: () => void;
  // For a host whose previous field hands Return on to this one (lib/input-keyboard.ts).
  inputRef?: React.Ref<TextInput>;
  // The field's, for the e2e flows (docs/e2e.md, _the testID contract_); the box that
  // shows the whole password takes it with `-shown`.
  testID?: string;
}) {
  const { password, setPassword, regenerate, generated, displayScore, message } = control;
  const invalid = message.tone === 'error';
  const [shown, setShown] = React.useState(false);

  return (
    <View className="gap-2">
      {/* RN has no <label for>, so the input is named directly rather than by the
          Text above it. */}
      <Text className="text-sm">{label}</Text>
      <PasswordInput
        ref={inputRef}
        testID={testID}
        aria-label={label}
        aria-invalid={invalid}
        autoComplete="new-password"
        editable={!disabled}
        onShownChange={setShown}
        className={cn(invalid && 'border-destructive')}
        value={password}
        onChangeText={(text) => {
          setPassword(text);
          onEdit?.();
        }}
      />
      {/* The whole password, because seven words do not fit the field on a phone and
          this is the string the user is here to write down. Beside the field, not by
          making it multiline: password-input.tsx carries why.
          TWO LINES RESERVED, as on web: seven words wrap to one line or two by luck of
          the draw, and Regenerate made the form below jump. The ghost is two lines of
          zero-width spaces in the SAME Text, so it scales and caps with the password
          and needs no fontScale arithmetic (docs/accessibility.md, _font scaling_); in a
          row, the box is as tall as the taller of the two, so a third line still grows it. */}
      {shown ? (
        <View
          aria-label={shownLabel}
          className="flex-row rounded-lg border border-border bg-muted/40 px-3 py-2.5"
        >
          <Text aria-hidden className="font-mono text-sm">
            {'​\n​'}
          </Text>
          <Text
            testID={testID ? `${testID}-shown` : undefined}
            selectable
            className="flex-1 font-mono text-sm"
          >
            {password}
          </Text>
        </View>
      ) : null}
      <PasswordStrengthMeter displayScore={displayScore} />
      {/* `aria-live` because the value it describes is masked: Regenerate swaps the
          password with nothing a screen reader would otherwise announce. */}
      <Text aria-live="polite" className={cn('text-sm', MESSAGE_TONE[message.tone])}>
        {message.text}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {generated ? NEW_PASSWORD_COPY.generatedHelp : NEW_PASSWORD_COPY.ownHelp}
      </Text>
      {/* One row of text buttons, Copy left and Regenerate right, where the wallet
          panel stacks Regenerate over a full-width Copy: web's note in its
          new-password-field.tsx carries why this field differs. `flex-wrap` because
          at a large Dynamic Type size the pair outgrows a narrow phone, and `gap-6`
          so a wrapped pair stays 24 apart, twice SECRET_TEXT_SLOP and then some. */}
      <View className="flex-row flex-wrap items-center justify-between gap-6">
        <CopySecretTextButton secret={password} />
        <Pressable
          role="button"
          disabled={disabled}
          onPress={() => {
            regenerate();
            onEdit?.();
          }}
          hitSlop={SECRET_TEXT_SLOP}
          className={cn(SECRET_TEXT_ACTION, disabled && 'opacity-50')}
        >
          <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
          <Text className="text-sm text-muted-foreground">{NEW_PASSWORD_COPY.regenerate}</Text>
        </Pressable>
      </View>
    </View>
  );
}
