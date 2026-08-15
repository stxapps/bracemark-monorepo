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
import { ShowOnceSecret } from '@stxapps/web-ui/components/auth/show-once-secret';
import { Field, FieldDescription, FieldLabel } from '@stxapps/web-ui/components/ui/field';

// CHOOSING A NEW PASSWORD — the whole block, in one place. A generated ~77-bit
// passphrase shown wallet-style is the DEFAULT, with a typed-your-own escape hatch
// gated by a zxcvbn floor; the account is a password-derived wallet with no email and
// no reset, so the safe path has to be the path of least resistance (docs/account.md,
// _generated password_).
//
// Two surfaces render this on web — create-account's setup step and
// Settings → change password — and they had it twice, near-verbatim: mode state,
// generate-on-mount, regenerate, the ShowOnceSecret panel with its two actions, the
// strength meter, the message line, both help paragraphs, and the gate. That much
// duplication of a SECURITY ceremony drifts, and had: Settings scored the password
// with no penalty terms while create-account passed the username, so the same string
// could pass the entropy floor at rotation and fail it at signup. One component, one
// answer. The words are one layer further down again (`NEW_PASSWORD_COPY` in
// `@stxapps/react`), because the native twin of this file needs the same ones.
//
// SPLIT AS HOOK + COMPONENT because the caller needs the value and the gate for its
// own submit: `useNewPassword` owns the state and returns a control object, the
// component renders it. The alternative — an uncontrolled component reporting up
// through `onChange` — would have both surfaces mirroring this state into their own
// just to be able to submit it.
//
// It renders the Field kit even though Settings' other views hand-roll
// `Label` over a `flex flex-col gap-2` column, and that is not the kit leaking into
// Settings: `Field`'s vertical variant IS `flex-col gap-2`, so this renders exactly
// the column it replaces there, and the block genuinely wants what the kit adds (the
// `data-invalid` cascade that colours label and message together, and the description
// slots). Sibling spacing still belongs to whatever wraps it — FieldGroup's `gap-6`
// on the auth card, the form's `gap-4` in Settings.

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
  // What to submit — the generated passphrase or the typed one, per mode.
  password: string;
  // THE GATE. Generated mode: a passphrase exists and the user ticked "I've saved
  // it". Typed mode: `tone === 'ok'`, which is the schema floor and the entropy floor
  // both passing. Callers spell their submit's `disabled` as this and nothing else,
  // so the button can't disagree with the line under the field it's blocked on.
  ok: boolean;
};

// `username` is the zxcvbn penalty term — a password built out of the account name
// scores low. It's a named scalar rather than a `string[]` of penalty terms because
// it is the only one either surface has, and naming it is what stops the next caller
// from quietly omitting it the way Settings did.
export function useNewPassword({
  username,
}: { username?: string | null } = {}): NewPasswordControl {
  const [mode, setMode] = React.useState<'generated' | 'own'>('generated');
  // Generated in an effect on MOUNT rather than a lazy initializer (which is what the
  // native twin uses) so SSR and the first client render agree — a random value
  // produced during render would hydrate-mismatch. Hence the `passphrase !== ''` in
  // the gate below: there is one frame where there is no passphrase yet.
  const [passphrase, setPassphrase] = React.useState('');
  const [passphraseSaved, setPassphraseSaved] = React.useState(false);
  const [ownPassword, setOwnPassword] = React.useState('');

  React.useEffect(() => {
    setPassphrase(generatePassphrase());
  }, []);

  // Strength only matters on the typed path — the generated passphrase is ~77 bits by
  // construction. Score the CANONICAL form, the exact string the KEK derives from, so
  // the meter can't disagree with what's stored.
  const { guessesLog10, displayScore } = usePasswordStrength(
    mode === 'own' ? canonicalizePassword(ownPassword) : '',
    username ? [username] : [],
    NEW_PASSWORD_MIN_LENGTH,
  );
  // Note it's `guessesLog10` the ladder gates on, never `displayScore` — that one is
  // the meter's, not the policy's (see PASSWORD_MIN_GUESSES_LOG10) — and that null,
  // the estimator still loading, keeps the gate shut until it's ready.
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
    ok: mode === 'generated' ? passphrase !== '' && passphraseSaved : message.tone === 'ok',
  };
}

export function NewPasswordField({
  control,
  // Which ceremony's words to print — 'create' says "Password", 'change' says "New
  // password", and the confirm/secret labels follow.
  copy: which,
  // Namespaces the DOM ids, so both surfaces can render this without colliding.
  idPrefix,
  disabled,
  // Called on every change to the new password — typing, either mode switch,
  // regenerate. Settings hangs its "Incorrect password." reset off this: that message
  // is about the PROOF the form submitted, so it's stale the moment any part of the
  // form moves. Nothing on create-account needs it.
  onEdit,
}: {
  control: NewPasswordControl;
  copy: 'create' | 'change';
  idPrefix: string;
  disabled?: boolean;
  onEdit?: () => void;
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

  // Only in typed mode: `data-invalid` on the Field is a claim that the value the user
  // TYPED is rejected, and in generated mode there is no typed value (the ladder is
  // scoring an empty string). See field-messages.ts on what `error` promises.
  const invalid = mode === 'own' && message.tone === 'error';

  if (mode === 'generated') {
    return (
      <Field>
        {/* No `htmlFor`: this mode has no input to name — ShowOnceSecret's box
            carries its own `secretLabel` — so the label heads the block. */}
        <FieldLabel>{copy.label}</FieldLabel>
        <FieldDescription>{copy.generatedHelp}</FieldDescription>
        <ShowOnceSecret
          id={`${idPrefix}-passphrase-saved`}
          secret={passphrase}
          label={copy.secretLabel}
          saved={passphraseSaved}
          onSavedChange={setPassphraseSaved}
          confirmLabel={copy.confirmLabel}
          // Both of these change WHICH password you end up with, so they ride in the
          // panel's `actions` slot — directly under the value, above Copy. Regenerate
          // also clears the saved checkbox further down; sitting above it is what
          // makes that reset look like cause and effect rather than the box emptying
          // itself.
          actions={
            <div className="flex items-center justify-between">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  regenerate();
                  onEdit?.();
                }}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className="size-3.5" />
                {copy.regenerate}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('own');
                  onEdit?.();
                }}
                className="text-sm text-muted-foreground underline hover:text-foreground"
              >
                {copy.chooseOwn}
              </button>
            </div>
          }
        />
      </Field>
    );
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={`${idPrefix}-new-password`}>{copy.label}</FieldLabel>
      <PasswordInput
        id={`${idPrefix}-new-password`}
        autoComplete="new-password"
        aria-invalid={invalid}
        disabled={disabled}
        value={ownPassword}
        onChange={(e) => {
          setOwnPassword(e.target.value);
          onEdit?.();
        }}
      />
      <PasswordStrengthMeter displayScore={displayScore} />
      <FieldDescription className={MESSAGE_TONE[message.tone]}>{message.text}</FieldDescription>
      <FieldDescription>
        {copy.ownHelp}{' '}
        <button
          type="button"
          onClick={() => {
            setMode('generated');
            onEdit?.();
          }}
          className="underline hover:text-foreground"
        >
          {copy.generateInstead}
        </button>
      </FieldDescription>
    </Field>
  );
}
