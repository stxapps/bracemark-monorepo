'use client';

import * as React from 'react';
import { RefreshCw } from 'lucide-react';

import { type FieldMessage, NEW_PASSWORD_COPY, newPasswordMessage } from '@stxapps/react';
import { canonicalizePassword, generatePassphrase, NEW_PASSWORD_MIN_LENGTH } from '@stxapps/shared';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import {
  MESSAGE_TONE,
  PasswordStrengthMeter,
  usePasswordStrength,
} from '@stxapps/web-ui/components/auth/password-strength';
import {
  CopySecretTextButton,
  SECRET_TEXT_ACTION,
  SECRET_TEXT_SLOP_Y,
} from '@stxapps/web-ui/components/auth/show-once-secret';
import { Field, FieldDescription, FieldLabel } from '@stxapps/web-ui/components/ui/field';
import { cn } from '@stxapps/web-ui/lib/utils';

// CHOOSING A NEW PASSWORD: ONE REAL FIELD, ALREADY FILLED. The safe path stays the
// default path, a generated ~77-bit passphrase, but there is no generated/typed switch:
// editing the field is choosing your own, and an edited value meets the same floors a
// typed one always did. A manager's own suggestion lands here too, which is the place
// it is welcome, because this is the new password and whatever is accepted simply IS
// it (docs/account.md, _generated password_).
//
// TWO CALLERS, ONE FIELD: create-account's first step and Settings → change password.
// Settings used to have a block of its own, the generated words in a wallet panel
// with an "I've saved it" checkbox and a "Choose my own" switch to a typed field. That
// was two shapes for a manager to read, and on the default one the only field a
// manager could save from was a `hidden` input set by script. It also asked for a tick
// before the submit, when a manager only offers to update after it.
//
// SPLIT AS HOOK + COMPONENT because the caller needs the value and the gate for its own
// submit: `useNewPassword` owns the state and returns a control object, the component
// renders it. The hook existed twice once, and Settings scored the password with no
// penalty terms while create-account passed the username, so the same string could
// pass the floor at rotation and fail it at signup; both callers pass `username` now.

export type NewPasswordControl = {
  password: string;
  setPassword: (password: string) => void;
  regenerate: () => void;
  // The field still holds the words the form generated, untouched.
  generated: boolean;
  displayScore: number | null;
  message: FieldMessage;
  // THE GATE. `tone === 'ok'`, the same pass as every ladder here, so a submit can't
  // disagree with the line under the field.
  ok: boolean;
};

// `username` is the zxcvbn penalty term. `currentPassword` is change password's proof
// field, when the proof is a password: a new password equal to it is refused by the
// ladder (field-messages.ts). Create-account has none.
export function useNewPassword({
  username,
  currentPassword,
}: {
  username?: string | null;
  currentPassword?: string;
}): NewPasswordControl {
  // Generated in an effect on MOUNT rather than a lazy initializer (the native twin's):
  // a random value produced during render would hydrate-mismatch. A browser never counts that
  // as typing, which matters: Safari raised no save prompt at Continue on a value set
  // by script, and did on one typed by hand.
  const [words, setWords] = React.useState('');
  const [password, setPassword] = React.useState('');

  const regenerate = React.useCallback(() => {
    const next = generatePassphrase();
    setWords(next);
    setPassword(next);
  }, []);

  React.useEffect(regenerate, [regenerate]);

  const generated = password !== '' && password === words;

  // Nothing to score on the words themselves, and scoring them would fetch ~1.7 MB of
  // dictionary to say what their construction already guarantees. Score the CANONICAL
  // form otherwise, the exact string the KEK derives from.
  const { guessesLog10, displayScore, failed } = usePasswordStrength(
    generated ? '' : canonicalizePassword(password),
    username ? [username] : [],
    NEW_PASSWORD_MIN_LENGTH,
  );

  const message: FieldMessage = generated
    ? { text: NEW_PASSWORD_COPY.generated, tone: 'ok' }
    : newPasswordMessage(password, guessesLog10, failed, currentPassword);

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

// The meter's top band ("Strong", password-strength.tsx).
const STRONGEST = 3;

// ⚠ iOS SAFARI OFFERS AGAIN IF THE FOCUS STAYS. Taking its strong password on a field
// that already held a value brought "Use Strong Password?" straight back up, over the
// password it had just filled, with Save & Fill exactly where the thumb still was. A
// second accept mints a second password. An empty field does not do this, so it is the
// prefill's cost, and leaving the field once a manager has filled it is what pays it
// (docs/account.md, _how safari tells a login from a sign-up_). On a timer, because iOS
// has not set `:autofill` yet in the event that reports the fill, nor on the next frame.
function leaveFieldIfFilled(field: HTMLInputElement) {
  setTimeout(() => {
    try {
      if (field.matches(':autofill')) field.blur();
    } catch {
      // An engine without the selector. Nothing to leave for.
    }
  }, 150);
}

export function NewPasswordField({
  control,
  id,
  label,
  disabled,
  // Called on every change to the password, typed or regenerated. Settings hangs its
  // "Incorrect password." reset off this: that message is about the PROOF the form
  // submitted, so it is stale the moment any part of the form moves.
  onEdit,
}: {
  control: NewPasswordControl;
  // The input's id, which a password manager and the e2e fixtures read
  // (`signup-new-password`, `cp-new-password`).
  id: string;
  label: string;
  disabled?: boolean;
  onEdit?: () => void;
}) {
  const { password, setPassword, regenerate, generated, displayScore, message } = control;
  const invalid = message.tone === 'error';
  const [shown, setShown] = React.useState(false);

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <PasswordInput
        id={id}
        autoComplete="new-password"
        aria-invalid={invalid}
        disabled={disabled}
        onShownChange={setShown}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          onEdit?.();
          leaveFieldIfFilled(e.target);
        }}
      />
      {/* The whole password, because seven words do not fit the field on a phone and
          this is the string the user is here to write down. Beside the field, not by
          turning the field into something that wraps: password-input.tsx carries why.
          `aria-hidden` because it is a copy for the eye: the revealed field is a text
          input that already reads its whole value, and an `<output>` here would be a
          live region speaking the password again on every keystroke. */}
      {shown ? (
        <div
          aria-hidden
          className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
        >
          {password}
        </div>
      ) : null}
      <PasswordStrengthMeter displayScore={displayScore} />
      {/* `aria-live` because the value it describes is masked: Regenerate swaps the
          password with nothing a screen reader would otherwise announce. */}
      <FieldDescription aria-live="polite" className={MESSAGE_TONE[message.tone]}>
        {message.text}
      </FieldDescription>
      <FieldDescription>
        {generated ? NEW_PASSWORD_COPY.generatedHelp : NEW_PASSWORD_COPY.ownHelp}
      </FieldDescription>
      {/* ONE ROW OF TEXT BUTTONS, NOT THE WALLET PANEL'S STACK. A normal sign-up is a
          username, a password and a submit, and a normal change is the old and the new.
          The browser's own save is the main path here: Copy is the fallback, so it does
          not get the full-width button that IS the step on the recovery panels, and
          which here sat stacked over the submit, two full-width buttons for one real
          action. The panel's reason for Regenerate above Copy (a copy it silently
          invalidates) is covered by what follows the submit: create-account's check
          step, and change password's done screen, which shows the new password again.

          Copy LEFT, where reading starts, because it is the one people need; Regenerate
          pushed RIGHT, so a thumb aiming at Copy doesn't mint a new password, and
          "Copy" growing into "Copied" moves nothing. Regenerate is also the way back to
          generated words after editing them. `flex-wrap` for a zoomed page, at `gap-6`
          so a wrapped pair still keeps the half-gap rule for SECRET_TEXT_ACTION's
          target (docs/accessibility.md, _a web target on a touch screen_). */}
      <div className="flex flex-wrap items-center justify-between gap-6">
        <CopySecretTextButton secret={password} />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            regenerate();
            onEdit?.();
          }}
          className={cn(SECRET_TEXT_ACTION, SECRET_TEXT_SLOP_Y, 'disabled:opacity-50')}
        >
          <RefreshCw className="size-3.5" />
          {NEW_PASSWORD_COPY.regenerate}
        </button>
      </div>
    </Field>
  );
}
