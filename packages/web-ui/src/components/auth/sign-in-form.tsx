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
import { cn } from '@stxapps/web-ui/lib/utils';

// Client leaf for the sign-in route. Two modes: the normal password sign-in and
// the recovery-code path (the escape hatch when the password is lost — the
// recovery door unwraps the same DEK). The page stays a Server Component; only
// this interactive form runs on the client.
//
// DENSITY — the label tier, exactly the two `Label` already defines (label.tsx):
// `standard` is `text-sm` foreground, `dense` is `text-xs` muted. A prop rather
// than a class override because the two callers want DIFFERENT answers and both
// are right, and neither can be derived from the other at render time.
//
// bracemark-web's /sign-in is a full-page card and takes the default. The browser
// extension's popup passes `dense`, and the reason is the POPUP'S OWN SCALE, not
// the size of the control under the label: left at `standard` the popup put a 14px
// label under a 14px `PopupTitle`, so a page heading and a field name were one
// weight apart and nothing else; and it made this form the only popup screen not
// on the dense tier its two siblings already use (Editor.tsx's List/Tags/Note
// labels).
//
// This argument used to be led by a different one — that a 360px popup never
// matches `md:`, so these Inputs rendered at 16px, "the same bind as the add sheet
// on a phone, where the VALUE can't shrink and only the label can move". That
// bind was real on the phone and imported wrongly to the popup: `md:` is a proxy
// for a TOUCH DEVICE (iOS auto-zoom — input.tsx), and a toolbar popup is a desktop
// with a mouse that merely happens to be 360px wide. The extension now pins all
// five controls back to 14px in one rule (its `styles/globals.css`), so the popup's
// fields are 14px and the dense tier stands on the `PopupTitle` collision alone —
// which, note, it always could: a 14px label ties that heading at either value
// size, so nothing about this prop changed when the controls did.
//
// WHAT DENSITY DOES NOT TOUCH, deliberately:
//   - `FieldError`. It stays `text-sm` in both tiers. An error must not be
//     quieter than the label it corrects, it is the one line on the screen that
//     HAS to be read, and it is already differentiated by colour rather than by
//     size — so shrinking it buys tidiness and costs legibility (accessibility.md).
//   - the submit `Button` (`h-9 text-sm font-medium`). It is the screen's single
//     filled anchor; a dense form still wants a standard-sized commit, and the
//     popup's other screens keep the default Button too.
//   - every gap. `FieldGroup`'s 24 and `Field`'s vertical 8 are a ratio argument
//     (field.tsx: 1:3 is what keeps a label attached to ITS control), and a ratio
//     holds at either label size. Density is a TYPE tier here, nothing else — if
//     the popup ever needs a tighter rhythm that is a separate, visible decision.
//
// LOCKED USERNAME — the expired state's resume (docs/sessions.md, _the expired
// state on the client_). Resume is a normal sign-in, password or recovery code,
// but only as the account whose library is on this device: the field is
// pre-filled with the stored username and read-only. Read-only rather than
// disabled, so it stays in the tab order and is still announced — the user is
// told whose account this is, and the value still submits with the form.
export function SignInForm({
  density = 'standard',
  lockedUsername,
}: {
  density?: 'standard' | 'dense';
  lockedUsername?: string;
}) {
  const [mode, setMode] = React.useState<'password' | 'recovery'>('password');
  return mode === 'password' ? (
    <PasswordSignIn
      density={density}
      lockedUsername={lockedUsername}
      onUseRecovery={() => setMode('recovery')}
    />
  ) : (
    <RecoverySignIn
      density={density}
      lockedUsername={lockedUsername}
      onUsePassword={() => setMode('password')}
    />
  );
}

// The door to the other mode. Muted and underlined in both tiers; only the step
// moves, so it stays level with the labels above it rather than becoming the
// loudest secondary line on a dense surface.
function modeSwitchClass(density: 'standard' | 'dense') {
  return cn(
    'mt-1 text-muted-foreground underline hover:text-foreground',
    density === 'dense' ? 'text-xs' : 'text-sm',
  );
}

function PasswordSignIn({
  density,
  lockedUsername,
  onUseRecovery,
}: {
  density: 'standard' | 'dense';
  lockedUsername?: string;
  onUseRecovery: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useSignInForm(lockedUsername);
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
          <FieldLabel htmlFor="username" density={density}>
            Username
          </FieldLabel>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            autoFocus={!lockedUsername}
            readOnly={!!lockedUsername}
            aria-invalid={!!errors.username}
            {...register('username', { onChange: clearRootError })}
          />
          <FieldError errors={errors.username ? [errors.username] : undefined} />
        </Field>
        <Field data-invalid={!!errors.password}>
          <FieldLabel htmlFor="password" density={density}>
            Password
          </FieldLabel>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            autoFocus={!!lockedUsername}
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
          <button type="button" onClick={onUseRecovery} className={modeSwitchClass(density)}>
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
function RecoverySignIn({
  density,
  lockedUsername,
  onUsePassword,
}: {
  density: 'standard' | 'dense';
  lockedUsername?: string;
  onUsePassword: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useRecoverySignInForm(lockedUsername);
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
          <FieldLabel htmlFor="rec-username" density={density}>
            Username
          </FieldLabel>
          <Input
            id="rec-username"
            type="text"
            autoComplete="username"
            autoFocus={!lockedUsername}
            readOnly={!!lockedUsername}
            aria-invalid={!!errors.username}
            {...register('username', { onChange: clearRootError })}
          />
          <FieldError errors={errors.username ? [errors.username] : undefined} />
        </Field>
        <Field data-invalid={!!errors.recoveryCode}>
          <FieldLabel htmlFor="rec-code" density={density}>
            Recovery code
          </FieldLabel>
          <Input
            id="rec-code"
            type="text"
            autoFocus={!!lockedUsername}
            autoCapitalize="characters"
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
          <button type="button" onClick={onUsePassword} className={modeSwitchClass(density)}>
            Use your password instead
          </button>
        </Field>
      </FieldGroup>
    </form>
  );
}
