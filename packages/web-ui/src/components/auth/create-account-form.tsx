'use client';

import * as React from 'react';

import { CREATE_ACCOUNT_COPY, usernameMessage, useUsernameAvailable } from '@stxapps/react';
import { canonicalizeUsername } from '@stxapps/shared';
import { SignupLimitedError, useCreateAccount, UsernameTakenError } from '@stxapps/web-react';
import {
  NewPasswordField,
  useNewPassword,
} from '@stxapps/web-ui/components/auth/new-password-field';
import { MESSAGE_TONE } from '@stxapps/web-ui/components/auth/password-strength';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';

// CREATE ACCOUNT IS ONE STEP: a username, a password, and the button that creates the
// account and signs in (docs/account.md, _creating an account_). That is the shape
// every password manager knows as a sign-up, and the reason for it is the manager:
//
//   - the password field is the new password, already holding generated words (~77
//     bits) the user may edit into their own behind the strength floor, or replace with
//     a manager's own suggestion. Whatever is in it when the button is pressed simply
//     IS the password, so Safari's "Use Strong Password" is welcome here, not a trap;
//   - the form goes away only once the account exists, which is when a manager offers
//     to save. One save, with the right password, at the right time.
//
// It used to be three steps — the password, a recovery code, then a sign-in-shaped
// check before anything was created — and each part of that cost something on some
// browser: the step-one field going away before the account existed raised iOS's
// "Save Password?" early in the app, the check's login treatment in Safari rested on two
// strings, and the form needed a branch to adopt whatever Safari had filled. The
// recovery code and the check now come AFTER, on the welcome screen (WelcomeGate, in
// each app), which is also where the password can be shown again.
//
// The reveal stays: the eye on the field, and the whole password in a box under it
// while shown (new-password-field.tsx). There is no reset, so seeing what you are
// about to save is the typo protection.
//
// Not react-hook-form: two inline-validated fields, each with its own message ladder.
export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // `username` is the zxcvbn penalty term.
  const chosen = useNewPassword({ username });

  // Live username validation + availability (debounced, gated on a valid format). Both
  // fields work the same way: one ladder produces the message, and the message IS the
  // gate — `tone === 'ok'` is the full pass, so the button can't disagree with the
  // sentence under the field it is blocked on (lib/field-messages.ts). A disabled
  // button is allowed here because each blocker has a permanent message line beside
  // it (docs/account.md, _when a submit is allowed to be `disabled`_).
  const availability = useUsernameAvailable(username);
  const usernameMsg = usernameMessage(username, availability, usernameTaken);
  const canSubmit = usernameMsg.tone === 'ok' && chosen.ok;
  const pending = createAccount.isPending;

  const submit = async () => {
    if (!canSubmit || pending) return;
    setSubmitError(null);
    try {
      await createAccount.mutateAsync({
        username: canonicalizeUsername(username),
        password: chosen.password,
      });
      // onSuccess in the hook begins the welcome and flips auth state; the guard
      // navigates. Nothing to do here.
    } catch (err) {
      if (err instanceof UsernameTakenError) setUsernameTaken(true);
      else if (err instanceof SignupLimitedError) setSubmitError(CREATE_ACCOUNT_COPY.signupLimited);
      else setSubmitError(CREATE_ACCOUNT_COPY.submitFailed);
    }
  };

  const usernameInvalid = usernameMsg.tone === 'error';

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FieldGroup>
        <Field data-invalid={usernameInvalid}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            autoFocus
            aria-invalid={usernameInvalid}
            // Read-only, not disabled, while the account is being created: a manager
            // reads the username off the form as it goes away, and a disabled field
            // can drop out of what it reads.
            readOnly={pending}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameTaken(false);
            }}
          />
          {/* `aria-live` so the availability verdict is announced when it lands: it
              arrives without the user typing anything, into a node that is always
              there. */}
          <FieldDescription aria-live="polite" className={MESSAGE_TONE[usernameMsg.tone]}>
            {usernameMsg.text}
          </FieldDescription>
        </Field>

        <NewPasswordField
          control={chosen}
          id="signup-new-password"
          label={CREATE_ACCOUNT_COPY.passwordLabel}
          disabled={pending}
          onEdit={() => setSubmitError(null)}
        />

        <Field>
          <Button type="submit" className="w-full" disabled={!canSubmit || pending}>
            {pending ? CREATE_ACCOUNT_COPY.creating : CREATE_ACCOUNT_COPY.submit}
          </Button>
          {/* BELOW the button: this error is a RESULT, and above it the mount would
              push the button out from under a pointer about to retry. FieldError
              renders `role="alert"`, so it announces. */}
          <FieldError>{submitError}</FieldError>
        </Field>
      </FieldGroup>
    </form>
  );
}
