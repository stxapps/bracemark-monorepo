'use client';

import * as React from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';

import { newPasswordMessage, usernameMessage, useUsernameAvailable } from '@stxapps/react';
import {
  canonicalizePassword,
  canonicalizeUsername,
  generatePassphrase,
  generateRecoveryCode,
  NEW_PASSWORD_MIN_LENGTH,
} from '@stxapps/shared';
import { useCreateAccount, UsernameTakenError } from '@stxapps/web-react';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import {
  MESSAGE_TONE,
  PasswordStrengthMeter,
  usePasswordStrength,
} from '@stxapps/web-ui/components/auth/password-strength';
import { ShowOnceSecret } from '@stxapps/web-ui/components/auth/show-once-secret';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';

// The "Secure your account" ceremony (docs/account.md). Because the account is a
// password-derived wallet — no email, no server-side reset — the safe path is the
// DEFAULT path: a generated ~77-bit passphrase, shown once wallet-style, with a
// "type my own" escape hatch gated by a zxcvbn strength floor. Three steps:
//   1. setup    — username + choose a password (generated default | typed own)
//   2. confirm  — re-enter it, verifying the user can reproduce it (no reset!)
//   3. recovery — a generated recovery code (a second door), show-once, SKIPPABLE
// then create the account (with the recovery door iff they set one up).
//
// Not react-hook-form: the multi-step secret ceremony (generate, reveal, confirm,
// re-generate) is local UI state, and the only validated inputs are username
// (usernameSchema) and password (newPasswordSchema + the zxcvbn gate), checked inline.
//
// Every step opens with a StepHeader — the back link and "Step 2 of 3" over the
// step's own title and description. That header is THE PAGE'S heading, which is
// why `(auth)/create-account/page.tsx` renders no CardHeader of its own; see the
// note on StepHeader for why it has to be the form that owns it.

type Step = 'setup' | 'confirm' | 'recovery';
type Mode = 'generated' | 'own';

// Source of truth for the step COUNT as well as the order: StepHeader derives
// "n of 3" by index, so adding a step to the ceremony renumbers the indicator
// automatically instead of leaving a hardcoded "3" behind to go stale.
const STEPS: readonly Step[] = ['setup', 'confirm', 'recovery'];

// The heading each step replaces the last one with. Step one's pair is the line
// the page header used to carry, and it is a disclosure rather than a caption:
// both halves name a field this form will never show. There is no email address
// and no reset link, not as omissions but because the account has neither
// (docs/account.md — the secret IS the account), and that is what makes step
// three hand the user a code it insists they save. Steps two and three then say
// what THEY are for, which is the same warning arriving at the moment it bites.
const STEP_HEADINGS: Record<Step, { title: string; description: string }> = {
  setup: {
    title: 'Create account',
    description: 'No email address, no password reset — your password is the key to your links.',
  },
  confirm: {
    title: 'Confirm your password',
    description: 'Re-enter it to make sure you have it saved correctly.',
  },
  recovery: {
    title: 'Recovery code',
    description:
      "Save this recovery code somewhere safe. It's the only way back into your account if you ever lose your password.",
  },
};

// BOTH fields on the setup step keep a message line permanently, and every state
// fills it. The ladders that produce those messages — `usernameMessage` and
// `newPasswordMessage` — live in `@stxapps/react` (lib/field-messages.ts), shared with
// the native twin and with Settings → change password; that file carries the full
// reasoning (no reflow, and a slot that must always speak turns a missing state into
// missing code). Only the tone→class map is ours, and it comes from password-strength
// so a passing message is the same green as a passing meter.
//
// Each ladder is also THE GATE for its field: `tone === 'ok'` is the whole pass, so
// Continue is derived from the two sentences rather than from a second copy of their
// conditions, and can't end up disabled under a line that says everything looks fine.

export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [step, setStep] = React.useState<Step>('setup');
  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);

  const [mode, setMode] = React.useState<Mode>('generated');
  // Generated on MOUNT (an effect, not during render) so SSR and client agree —
  // a random value produced during render would hydrate-mismatch.
  const [passphrase, setPassphrase] = React.useState('');
  const [passphraseSaved, setPassphraseSaved] = React.useState(false);
  const [ownPassword, setOwnPassword] = React.useState('');

  const [confirmInput, setConfirmInput] = React.useState('');
  const [confirmError, setConfirmError] = React.useState(false);

  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoverySaved, setRecoverySaved] = React.useState(false);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPassphrase(generatePassphrase());
  }, []);

  // Mint the recovery code the first time the user reaches that step.
  React.useEffect(() => {
    if (step === 'recovery' && !recoveryCode) setRecoveryCode(generateRecoveryCode());
  }, [step, recoveryCode]);

  const password = mode === 'generated' ? passphrase : ownPassword;

  // Live username validation + availability (the hook debounces and gates on a valid
  // format internally). Both fields work the same way from here: one ladder produces
  // the message, and the message IS the gate — `tone === 'ok'` is the full pass, so
  // Continue can't disagree with the sentence under the field it's blocked on. See
  // usernameMessage for what "ok" costs (a settled, CURRENT answer, not a debounce-
  // stale one).
  const availability = useUsernameAvailable(username);
  const usernameMsg = usernameMessage(username, availability, usernameTaken);

  // Strength only matters on the typed path (the generated passphrase is ~77 bits
  // by construction). Score the CANONICAL form (canonicalizePassword) — the exact
  // string the KEK derives from — so the meter can't disagree with what's stored.
  // Pass the username as a penalty term.
  const { guessesLog10, displayScore } = usePasswordStrength(
    mode === 'own' ? canonicalizePassword(ownPassword) : '',
    [username],
    NEW_PASSWORD_MIN_LENGTH,
  );
  // Note it's `guessesLog10` the ladder gates on, never `displayScore` — that one is
  // the meter's, not the policy's (see PASSWORD_MIN_GUESSES_LOG10) — and that null,
  // the estimator still loading, keeps the gate shut until it's ready.
  const passwordMsg = newPasswordMessage(ownPassword, guessesLog10);

  const passwordChosen =
    mode === 'generated' ? passphrase !== '' && passphraseSaved : passwordMsg.tone === 'ok';
  const canContinueSetup = usernameMsg.tone === 'ok' && passwordChosen;

  const regeneratePassphrase = () => {
    setPassphrase(generatePassphrase());
    setPassphraseSaved(false);
  };

  const regenerateRecovery = () => {
    setRecoveryCode(generateRecoveryCode());
    setRecoverySaved(false);
  };

  const goConfirm = () => {
    setConfirmInput('');
    setConfirmError(false);
    setStep('confirm');
  };

  const goRecovery = () => {
    // Compare the CANONICAL forms: derivation canonicalizes both, so encodings that
    // derive the same KEK (e.g. a trailing space) must count as a match here too —
    // otherwise we'd reject a re-entry that would actually sign in fine.
    if (canonicalizePassword(confirmInput) !== canonicalizePassword(password)) {
      setConfirmError(true);
      return;
    }
    setStep('recovery');
  };

  const submit = async (withRecovery: boolean) => {
    setSubmitError(null);
    try {
      await createAccount.mutateAsync({
        username: canonicalizeUsername(username),
        password,
        recoveryCode: withRecovery ? recoveryCode : undefined,
      });
      // onSuccess in the hook flips auth state and navigates; nothing to do here.
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        setUsernameTaken(true);
        setStep('setup');
      } else {
        setSubmitError('Could not create account. Please try again.');
      }
    }
  };

  const pending = createAccount.isPending;

  // --- step: setup ----------------------------------------------------------
  if (step === 'setup') {
    const usernameInvalid = usernameMsg.tone === 'error';
    const passwordInvalid = passwordMsg.tone === 'error';

    return (
      <FieldGroup>
        <StepHeader step="setup" />
        <Field data-invalid={usernameInvalid}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            autoFocus
            aria-invalid={usernameInvalid}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameTaken(false);
            }}
          />
          {/* `aria-live` so the availability verdict is announced when it lands —
              it arrives without the user typing anything, and it's now a permanent
              node rather than one that mounts, which is what makes a live region
              the right tool here. */}
          <FieldDescription aria-live="polite" className={MESSAGE_TONE[usernameMsg.tone]}>
            {usernameMsg.text}
          </FieldDescription>
        </Field>

        {mode === 'generated' ? (
          <Field>
            <FieldLabel>Your password</FieldLabel>
            <FieldDescription>
              We generated a strong password for you. Save it in your password manager — there is no
              way to reset it if it&apos;s lost.
            </FieldDescription>
            <ShowOnceSecret
              id="passphrase-saved"
              secret={passphrase}
              label="Your password"
              saved={passphraseSaved}
              onSavedChange={setPassphraseSaved}
              confirmLabel="I've saved my password somewhere safe."
              // Both of these change WHICH password you end up with, so they ride
              // in the panel's `actions` slot — directly under the value, above
              // Copy. Regenerate also clears the saved checkbox further down;
              // sitting above it is what makes that reset look like cause and
              // effect rather than the box emptying itself.
              actions={
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={regeneratePassphrase}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className="size-3.5" />
                    Regenerate
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('own')}
                    className="text-sm text-muted-foreground underline hover:text-foreground"
                  >
                    Choose my own
                  </button>
                </div>
              }
            />
          </Field>
        ) : (
          <Field data-invalid={passwordInvalid}>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <PasswordInput
              id="password"
              autoComplete="new-password"
              aria-invalid={passwordInvalid}
              value={ownPassword}
              onChange={(e) => setOwnPassword(e.target.value)}
            />
            <PasswordStrengthMeter displayScore={displayScore} />
            <FieldDescription className={MESSAGE_TONE[passwordMsg.tone]}>
              {passwordMsg.text}
            </FieldDescription>
            <FieldDescription>
              A password of random words is stronger than most passwords you&apos;d type. If you use
              your own, make it long and unique — there is no way to reset it if it&apos;s lost.{' '}
              <button
                type="button"
                onClick={() => setMode('generated')}
                className="underline hover:text-foreground"
              >
                Generate one instead
              </button>
            </FieldDescription>
          </Field>
        )}

        <Field>
          <Button type="button" className="w-full" disabled={!canContinueSetup} onClick={goConfirm}>
            Continue
          </Button>
        </Field>
      </FieldGroup>
    );
  }

  // --- step: confirm --------------------------------------------------------
  if (step === 'confirm') {
    return (
      <FieldGroup>
        <StepHeader step="confirm" onBack={() => setStep('setup')} />
        <Field data-invalid={confirmError}>
          {/* The visible label for this input is the step's own title, up in the
              StepHeader — but a heading is not a label, so the field would be
              left unnamed for a screen reader. Keep the real <label htmlFor>,
              sr-only. It's `position:absolute`, so it costs no gap in the Field. */}
          <FieldLabel htmlFor="confirm" className="sr-only">
            Confirm your password
          </FieldLabel>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            autoFocus
            aria-invalid={confirmError}
            value={confirmInput}
            onChange={(e) => {
              setConfirmInput(e.target.value);
              if (confirmError) setConfirmError(false);
            }}
          />
          {confirmError ? (
            <FieldDescription className="text-destructive">
              That doesn&apos;t match. Check what you saved and try again.
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <Button type="button" className="w-full" onClick={goRecovery}>
            Continue
          </Button>
        </Field>
      </FieldGroup>
    );
  }

  // --- step: recovery -------------------------------------------------------
  return (
    <FieldGroup>
      <StepHeader step="recovery" onBack={() => setStep('confirm')} />
      <Field>
        {/* No label here, unlike the confirm step: this step has no input to
            name — ShowOnceSecret carries its own `label` — so the step title in
            the StepHeader is the only heading this content needs. */}
        <ShowOnceSecret
          id="recovery-saved"
          secret={recoveryCode}
          label="Your recovery code"
          saved={recoverySaved}
          onSavedChange={setRecoverySaved}
          confirmLabel="I've saved my recovery code somewhere safe."
          actions={
            <button
              type="button"
              onClick={regenerateRecovery}
              className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
              Regenerate
            </button>
          }
        />
      </Field>

      <Field>
        <Button
          type="button"
          className="w-full"
          disabled={!recoverySaved || pending}
          onClick={() => submit(true)}
        >
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={pending}
          className="mt-1 text-sm text-muted-foreground underline hover:text-foreground disabled:opacity-50"
        >
          Skip for now — I&apos;ll set this up later
        </button>
        {submitError ? (
          <FieldDescription className="text-destructive">{submitError}</FieldDescription>
        ) : null}
      </Field>
    </FieldGroup>
  );
}

// What every step opens with: a chrome row (back link on the left, absent on the
// first step; "Step n of 3" on the right) over that step's own title and
// description, at the page step — `text-xl font-semibold tracking-tight`, the
// same size /sign-in's CardTitle is bumped to, because this card is the whole page.
//
// THE HEADING IS THE STEP'S, AND THAT IS THE POINT. A header that reads "Create
// account" above a screen whose only job is to re-enter a password spends the
// loudest slot on a message the user already acted on — and the two screens then
// differ only in a small grey counter, so advancing looks like nothing happened.
// Swapping the title is the change the user actually notices. The copy is not new:
// steps two and three already carried these exact strings as a FieldLabel and
// FieldDescription, one text step down; this promotes them rather than adding words.
//
// IT LIVES HERE, NOT IN THE PAGE'S CardHeader, because `step` is this component's
// local state — driving a page-level header from it would mean lifting that state
// across the web-ui→app boundary, and again across feature→route on native, so the
// page could re-render three words. The header moved down to the state instead of
// the state moving up to the header, which is why `(auth)/create-account/page.tsx`
// renders CardContent with no CardHeader above it (and expo's screen passes
// AuthScreen no `title`).
//
// The counter stays a plain line of text. Its real job is on step ONE, where it's
// the only thing that says a recovery code is coming — by step 3 the user has seen
// two screens and can infer the shape. On the recovery step it then reads as "one
// screen left", which is the number that competes with that step's "Skip for now"
// escape hatch.
//
// Deliberately NOT dots, a progress bar, or a coloured capsule strip: dots imply
// steps you can click back to, which this ceremony doesn't offer past a single
// Back, and an accented indicator would outshout the primary button on the one
// screen (recovery) where that button is racing a Skip link. With the title now
// changing per step, "something changed" is carried by the largest text on the
// screen and the counter is left with the smaller job of saying how much is left.
// And deliberately no "(optional)" on step 3 even though it is skippable — the
// Skip link below already offers the exit; pre-announcing it in the counter just
// discourages setting up the second door. See docs/account.md, _generated password_.
function StepHeader({ step, onBack }: { step: Step; onBack?: () => void }) {
  const { title, description } = STEP_HEADINGS[step];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Back
          </button>
        ) : (
          // Holds the right-hand column in place on the first step, where there's
          // nothing to go back to — `justify-between` alone would left-align the count.
          <span />
        )}
        <span className="text-sm text-muted-foreground">
          Step {STEPS.indexOf(step) + 1} of {STEPS.length}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
