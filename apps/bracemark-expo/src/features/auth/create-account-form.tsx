import * as React from 'react';
import { type TextInput, View } from 'react-native';

import { SignupLimitedError, useCreateAccount, UsernameTakenError } from '@stxapps/expo-react';
import { CREATE_ACCOUNT_COPY, usernameMessage, useUsernameAvailable } from '@stxapps/react';
import { canonicalizeUsername } from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { advanceTo } from '../../lib/input-keyboard';
import { cn } from '../../lib/utils';
import { NewPasswordField, useNewPassword } from './new-password-field';
import { MESSAGE_TONE } from './password-strength';

// CREATE ACCOUNT IS ONE STEP — the native port of web-ui's
// components/auth/create-account-form.tsx, which carries the argument: a username, the
// password field already holding generated words, and the button that creates the
// account and signs in. The recovery code and the check of the saved password come
// after, on the welcome screen (components/welcome-gate.tsx).
//
// One step is what fixed this platform's own problem with the old ceremony: its
// Continue unmounted the filled `new-password` field before the account existed, and
// iOS read that as a submission — "Save Password?" over the recovery step, for an
// account not yet made (docs/account.md, _creating an account_). Now the field goes
// away only when the account exists, which is when a save is right.
export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // `username` is the zxcvbn penalty term.
  const chosen = useNewPassword({ username });
  // Return on the username goes on to the password (lib/input-keyboard.ts).
  const passwordRef = React.useRef<TextInput>(null);

  // Each ladder is the gate for its field (`tone === 'ok'`), as on web.
  const availability = useUsernameAvailable(username);
  const usernameMsg = usernameMessage(username, availability, usernameTaken);
  const canSubmit = usernameMsg.tone === 'ok' && chosen.ok;
  const pending = createAccount.isPending;

  const submit = async () => {
    // `pending` too: the button is disabled while the account is being created, but a
    // keyboard's Return is not, and a second create for the same name would come back
    // as UsernameTakenError on an account that was just made.
    if (!canSubmit || pending) return;
    setSubmitError(null);
    try {
      await createAccount.mutateAsync({
        username: canonicalizeUsername(username),
        password: chosen.password,
      });
      // onSuccess in the hook begins the welcome and flips auth state.
    } catch (err) {
      if (err instanceof UsernameTakenError) setUsernameTaken(true);
      else if (err instanceof SignupLimitedError) setSubmitError(CREATE_ACCOUNT_COPY.signupLimited);
      else setSubmitError(CREATE_ACCOUNT_COPY.submitFailed);
    }
  };

  const usernameInvalid = usernameMsg.tone === 'error';

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-sm">Username</Text>
        {/* NOT `autoFocus`: the screen is pushed from the landing CTA, and a keyboard
            raised during that slide-in would scroll the disclosure line above this
            field away before anyone read it (docs/soft-keyboard.md, _arrival_). */}
        <Input
          testID="create-account-username"
          // RN has no <label for>: the field is named directly.
          aria-label="Username"
          // `username-new` is Android's autofill hint and has no iOS mapping in React
          // Native, so iOS is told by `textContentType` what this field is, beside a
          // `new-password` field it offers to save a login for.
          autoComplete="username-new"
          textContentType="username"
          editable={!pending}
          className={cn(usernameInvalid && 'border-destructive')}
          {...advanceTo(passwordRef)}
          value={username}
          onChangeText={(text) => {
            setUsername(text);
            setUsernameTaken(false);
          }}
        />
        {/* `aria-live` so the availability verdict is announced when it lands. */}
        <Text aria-live="polite" className={cn('text-sm', MESSAGE_TONE[usernameMsg.tone])}>
          {usernameMsg.text}
        </Text>
      </View>

      <NewPasswordField
        control={chosen}
        label={CREATE_ACCOUNT_COPY.passwordLabel}
        shownLabel={CREATE_ACCOUNT_COPY.shownPasswordLabel}
        inputRef={passwordRef}
        testID="create-account-password"
        disabled={pending}
        onEdit={() => setSubmitError(null)}
      />

      <View className="gap-2">
        <Button
          testID="create-account-submit"
          disabled={!canSubmit || pending}
          onPress={() => void submit()}
        >
          <Text>{pending ? CREATE_ACCOUNT_COPY.creating : CREATE_ACCOUNT_COPY.submit}</Text>
        </Button>
        {/* Below the button: the message is the RESULT of pressing it. ErrorText
            carries `role="alert"`. */}
        {submitError ? <ErrorText testID="create-account-error">{submitError}</ErrorText> : null}
      </View>
    </View>
  );
}
