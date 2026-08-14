'use client';

import * as React from 'react';

import { useRecoverySignInForm, useSignInForm } from '@stxapps/react';
import type { RecoverySignInValues, SignInValues } from '@stxapps/shared';
import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  useSignIn,
  useSignInWithRecovery,
} from '@stxapps/web-react';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';

// Client leaf for the sign-in route. Two modes: the normal password sign-in and
// the recovery-code path (the escape hatch when the password is lost — the
// recovery door unwraps the same DEK). The page stays a Server Component; only
// this interactive form runs on the client.
export function SignInForm() {
  const [mode, setMode] = React.useState<'password' | 'recovery'>('password');
  return mode === 'password' ? (
    <PasswordSignIn onUseRecovery={() => setMode('recovery')} />
  ) : (
    <RecoverySignIn onUsePassword={() => setMode('password')} />
  );
}

function PasswordSignIn({ onUseRecovery }: { onUseRecovery: () => void }) {
  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useSignInForm();
  const signIn = useSignIn();

  // The credential failure is a submit-level `root` error, not tied to a field,
  // so react-hook-form's onChange re-validation never clears it. Drop it as soon
  // as the user edits either field.
  const clearRootError = () => {
    if (errors.root) clearErrors('root');
  };

  async function onSubmit(values: SignInValues) {
    try {
      await signIn.mutateAsync(values);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        setError('root', { message: 'Incorrect username or password' });
      } else {
        setError('root', { message: 'Could not sign in. Please try again.' });
      }
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Field data-invalid={!!errors.username}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            autoFocus
            aria-invalid={!!errors.username}
            {...register('username', { onChange: clearRootError })}
          />
          <FieldError errors={errors.username ? [errors.username] : undefined} />
        </Field>
        <Field data-invalid={!!errors.password}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            aria-invalid={!!errors.password}
            {...register('password', { onChange: clearRootError })}
          />
          <FieldError errors={errors.password ? [errors.password] : undefined} />
        </Field>
        <Field>
          {/* The label carries the pending state, like every other submit in the
              auth ceremony. While `isSubmitting` the button is `disabled`, which
              is `pointer-events-none` and out of the tab order — it announces
              nothing on its own, so without this the only signal that a sign-in
              is in flight is a greyed-out rectangle. */}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <FieldError errors={errors.root ? [errors.root] : undefined} />
          <button
            type="button"
            onClick={onUseRecovery}
            className="mt-1 text-sm text-muted-foreground underline hover:text-foreground"
          >
            Forgot your password? Use a recovery code
          </button>
        </Field>
      </FieldGroup>
    </form>
  );
}

// THE SAME FORM AS PasswordSignIn ABOVE, DOOR SWAPPED — and it is built the same
// way on purpose. It used to hand-roll two `useState` fields plus a `string | null`
// error, which is how it drifted into being the only submit in either auth form
// that sat `disabled` on empty input with nothing on screen saying why: no checkbox
// above it, no permanent message line under the fields (contrast create-account's
// setup step, where the ladder IS the gate — docs/account.md). A disabled button is
// silent in every channel — `disabled:pointer-events-none` kills hover, the
// attribute drops it from the tab order, and nothing is announced — and everyone
// who reaches THIS screen has already lost their password, so a dead control with
// no explanation is the worst thing to hand them.
//
// On the shared resolver (`recoverySignInSchema`) empty input submits and answers
// per-field, in the same announcing FieldError slots the password path uses, and
// the button is live whenever a request isn't in flight. See docs/account.md,
// _when a submit is allowed to be `disabled`_.
function RecoverySignIn({ onUsePassword }: { onUsePassword: () => void }) {
  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useRecoverySignInForm();
  const signIn = useSignInWithRecovery();

  // Same as the password path: the failure is a submit-level `root` error, not tied
  // to a field, so onChange re-validation never clears it.
  const clearRootError = () => {
    if (errors.root) clearErrors('root');
  };

  async function onSubmit(values: RecoverySignInValues) {
    try {
      await signIn.mutateAsync(values);
      // Signed in on the same keys as a password sign-in. The reason you're here is
      // a lost password, so set a new one in Settings → Account → Change password.
    } catch (err) {
      if (err instanceof InvalidRecoveryCodeError) {
        setError('root', { message: 'That recovery code didn’t work. Check it and try again.' });
      } else {
        setError('root', { message: 'Could not sign in. Please try again.' });
      }
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Field data-invalid={!!errors.username}>
          <FieldLabel htmlFor="rec-username">Username</FieldLabel>
          <Input
            id="rec-username"
            type="text"
            autoComplete="username"
            autoFocus
            aria-invalid={!!errors.username}
            {...register('username', { onChange: clearRootError })}
          />
          <FieldError errors={errors.username ? [errors.username] : undefined} />
        </Field>
        <Field data-invalid={!!errors.recoveryCode}>
          <FieldLabel htmlFor="rec-code">Recovery code</FieldLabel>
          <Input
            id="rec-code"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
            aria-invalid={!!errors.recoveryCode}
            {...register('recoveryCode', { onChange: clearRootError })}
          />
          <FieldError errors={errors.recoveryCode ? [errors.recoveryCode] : undefined} />
        </Field>
        <Field>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in with recovery code'}
          </Button>
          <FieldError errors={errors.root ? [errors.root] : undefined} />
          <button
            type="button"
            onClick={onUsePassword}
            className="mt-1 text-sm text-muted-foreground underline hover:text-foreground"
          >
            Use your password instead
          </button>
        </Field>
      </FieldGroup>
    </form>
  );
}
