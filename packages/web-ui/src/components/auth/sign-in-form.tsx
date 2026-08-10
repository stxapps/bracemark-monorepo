'use client';

import * as React from 'react';

import { useSignInForm } from '@stxapps/react';
import type { SignInValues } from '@stxapps/shared';
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
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            Sign in
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

function RecoverySignIn({ onUsePassword }: { onUsePassword: () => void }) {
  const signIn = useSignInWithRecovery();
  const [username, setUsername] = React.useState('');
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (signIn.isPending) return;
    setError(null);
    try {
      await signIn.mutateAsync({ username, recoveryCode });
      // Signed in on the same keys as a password sign-in. The reason you're here is
      // a lost password, so set a new one in Settings → Account → Change password.
    } catch (err) {
      if (err instanceof InvalidRecoveryCodeError) {
        setError('That recovery code didn’t work. Check it and try again.');
      } else {
        setError('Could not sign in. Please try again.');
      }
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="rec-username">Username</FieldLabel>
          <Input
            id="rec-username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) setError(null);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="rec-code">Recovery code</FieldLabel>
          <Input
            id="rec-code"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
            value={recoveryCode}
            onChange={(e) => {
              setRecoveryCode(e.target.value);
              if (error) setError(null);
            }}
          />
        </Field>
        <Field>
          <Button
            type="submit"
            className="w-full"
            disabled={signIn.isPending || username === '' || recoveryCode === ''}
          >
            {signIn.isPending ? 'Signing in…' : 'Sign in with recovery code'}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
