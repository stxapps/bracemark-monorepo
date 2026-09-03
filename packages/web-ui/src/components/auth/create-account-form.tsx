'use client';

import * as React from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';

import { RECOVERY_CODE_COPY, usernameMessage, useUsernameAvailable } from '@stxapps/react';
import { canonicalizePassword, canonicalizeUsername, generateRecoveryCode } from '@stxapps/shared';
import { useCreateAccount, UsernameTakenError } from '@stxapps/web-react';
import {
  NewPasswordField,
  useNewPassword,
} from '@stxapps/web-ui/components/auth/new-password-field';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import { MESSAGE_TONE } from '@stxapps/web-ui/components/auth/password-strength';
import { ShowOnceSecret } from '@stxapps/web-ui/components/auth/show-once-secret';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';

// The "Secure your account" ceremony (docs/account.md). Because the account is a
// password-unlocked wallet — no email, no server-side reset — the safe path is the
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
    title: RECOVERY_CODE_COPY.title,
    description: RECOVERY_CODE_COPY.description.create,
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
// The password half of that — the generated/typed choice, its meter, its message and
// its gate — is `NewPasswordField`, shared with Settings → change password, which
// renders the same block; only the username field is this form's own.

export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [step, setStep] = React.useState<Step>('setup');
  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);

  // The generated/typed password choice, its meter, its message line and its gate —
  // all of it, shared with Settings → change password. `username` is the zxcvbn
  // penalty term.
  const newPassword = useNewPassword({ username });

  const [confirmInput, setConfirmInput] = React.useState('');
  const [confirmError, setConfirmError] = React.useState(false);

  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoverySaved, setRecoverySaved] = React.useState(false);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Mint the recovery code the first time the user reaches that step.
  React.useEffect(() => {
    if (step === 'recovery' && !recoveryCode) setRecoveryCode(generateRecoveryCode());
  }, [step, recoveryCode]);

  const password = newPassword.password;

  // Live username validation + availability (the hook debounces and gates on a valid
  // format internally). Both fields work the same way from here: one ladder produces
  // the message, and the message IS the gate — `tone === 'ok'` is the full pass, so
  // Continue can't disagree with the sentence under the field it's blocked on. See
  // usernameMessage for what "ok" costs (a settled, CURRENT answer, not a debounce-
  // stale one).
  const availability = useUsernameAvailable(username);
  const usernameMsg = usernameMessage(username, availability, usernameTaken);

  const canContinueSetup = usernameMsg.tone === 'ok' && newPassword.ok;

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

        <NewPasswordField control={newPassword} copy="create" idPrefix="signup" />

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
          {/* FieldError, not a `text-destructive` FieldDescription: it renders
              `role="alert"`, so mounting it ANNOUNCES. Both errors on this form
              arrive as the result of a click and nothing else changes on screen —
              a plain <p> leaves a screen-reader user with a button that silently
              re-enables and no idea why. Same reason sign-in-form uses it for
              `errors.root`. */}
          {confirmError ? (
            <FieldError>That doesn’t match. Check what you saved and try again.</FieldError>
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
          label={RECOVERY_CODE_COPY.secretLabel}
          saved={recoverySaved}
          onSavedChange={setRecoverySaved}
          confirmLabel={RECOVERY_CODE_COPY.confirmLabel}
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

      {/* TWO WAYS TO CREATE THE ACCOUNT, and the second one has to say so. It read
          "Skip for now — I'll set this up later" as an underlined text link, which
          described neither what it does nor what it is: `submit(false)` creates the
          account — the same irreversible act as the button above it, minus the
          recovery door. With the primary greyed out until the checkbox is ticked,
          the only LIVE control on the screen was one labelled "skip" and painted in
          the register this app reserves for NAVIGATION (AuthAltAction's "Sign in"),
          so the honest reading was "leave without an account". Naming the outcome
          makes the pair differ in what's true afterwards, not in whether anything
          happens at all.

          GHOST, not outline or secondary: the primary sits at `disabled:opacity-50`
          in the state every user ARRIVES in, so a bordered or filled alternative
          would be the strongest thing on screen exactly where the recommended path
          should lead. Ghost keeps the button geometry — a real hit target and focus
          ring, which a 20px line of text is not, and the native twin is under
          Apple's 44pt floor — while staying subordinate at rest.

          Still skippable, and mandatory is NOT the fix: `recoverySaved` is an
          attestation, not proof. Forcing it moves the exit into the checkbox, and an
          account whose owner ticked a box without saving the code is worse than one
          that knowingly has no second door. Settings → Account mints one later
          (`_account/account-section.tsx`), which is why dropping "I'll set this up
          later" costs nothing — that clause sold the exit, and the counter's note
          below explains why this step doesn't. Step one's "Choose my own" /
          "Generate one instead" stay text links on purpose: those are reversible
          mode switches, not a second submit. */}
      <Field>
        <Button
          type="button"
          className="w-full"
          disabled={!recoverySaved || pending}
          onClick={() => submit(true)}
        >
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          disabled={pending}
          onClick={() => submit(false)}
        >
          Create account without a recovery code
        </Button>
        {/* BELOW the pair, not above it. This error is a RESULT — it exists only
            because one of those two buttons was just clicked, and "try again"
            invites clicking the same one. Above them, mounting it would push both
            buttons down ~33px with the pointer still resting on the one the user
            meant, so the retry click lands on the message instead. Below, nothing
            moves. (See the confirm step for why it's FieldError — it announces,
            and it renders null on its own when there's nothing to say.) */}
        <FieldError>{submitError}</FieldError>
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
// screen left", which is the number that competes with that step's recovery-less
// way out ("Create account without a recovery code").
//
// Deliberately NOT dots, a progress bar, or a coloured capsule strip: dots imply
// steps you can click back to, which this ceremony doesn't offer past a single
// Back, and an accented indicator would outshout the primary button on the one
// screen (recovery) where that button is racing a second submit. With the title now
// changing per step, "something changed" is carried by the largest text on the
// screen and the counter is left with the smaller job of saying how much is left.
// And deliberately no "(optional)" on step 3 even though it is skippable — the
// ghost button below already offers the exit; pre-announcing it in the counter just
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
