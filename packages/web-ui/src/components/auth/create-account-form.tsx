'use client';

import * as React from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';

import {
  CREATE_ACCOUNT_COPY,
  NEW_PASSWORD_COPY,
  RECOVERY_CODE_COPY,
  usernameMessage,
  useUsernameAvailable,
} from '@stxapps/react';
import { canonicalizePassword, canonicalizeUsername, generateRecoveryCode } from '@stxapps/shared';
import { useCreateAccount, UsernameTakenError } from '@stxapps/web-react';
import {
  NewPasswordField,
  useNewPassword,
} from '@stxapps/web-ui/components/auth/new-password-field';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import { MESSAGE_TONE } from '@stxapps/web-ui/components/auth/password-strength';
import {
  SECRET_TEXT_ACTION,
  ShowOnceSecret,
} from '@stxapps/web-ui/components/auth/show-once-secret';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { cn } from '@stxapps/web-ui/lib/utils';

// The "Secure your account" ceremony (docs/account.md, _creating an account_). Because
// the account is a password-unlocked wallet — no email, no server-side reset — the
// safe path is the DEFAULT path: a generated ~77-bit passphrase, already in the
// password field, which the user can edit into their own behind a zxcvbn strength
// floor. Three steps:
//   1. setup    — username + password, one real field for each
//   2. recovery — a generated recovery code (a second door), show-once, SKIPPABLE
//   3. check    — sign in with the saved copy, which creates the account
//
// THE ORDER IS THE DESIGN, and each half of it is about a password manager. A new
// password is asked for exactly once, on step one, where a manager's suggestion is
// welcome. The check comes last and reads as a login, so a manager offers what it has
// saved rather than a new password that could not match. And the recovery step sits
// between them on purpose: copying the code replaces the clipboard, so the check
// cannot be passed by pasting back what step one copied, which is the one thing that
// proves nothing.
//
// NOTHING EXISTS UNTIL THE CHECK PASSES. It is a local compare, so Back undoes
// everything, a closed tab strands no username, and a browser that fills in some other
// password can simply be believed (see `adoptOffered`).
//
// Not react-hook-form: the multi-step secret ceremony is local UI state, and the only
// validated inputs are username (usernameSchema) and password (newPasswordSchema + the
// zxcvbn gate), checked inline.
//
// Every step opens with a StepHeader — the back link and "Step 2 of 3" over the
// step's own title and description. That header is THE PAGE'S heading, which is
// why `(auth)/create-account/page.tsx` renders no CardHeader of its own; see the
// note on StepHeader for why it has to be the form that owns it.

type Step = 'setup' | 'recovery' | 'check';

// Source of truth for the step COUNT as well as the order: StepHeader derives
// "n of 3" by index, so adding a step to the ceremony renumbers the indicator
// automatically instead of leaving a hardcoded "3" behind to go stale.
const STEPS: readonly Step[] = ['setup', 'recovery', 'check'];

// The heading each step replaces the last one with. Step one's pair is the line
// the page header used to carry, and it is a disclosure rather than a caption:
// both halves name a field this form will never show. There is no email address
// and no reset link, not as omissions but because the account has neither
// (docs/account.md — the secret IS the account), and that is what makes the
// recovery step hand the user a code it insists they save. The later steps then say
// what THEY are for, which is the same warning arriving at the moment it bites.
const STEP_HEADINGS: Record<Step, { title: string; description: string }> = {
  setup: CREATE_ACCOUNT_COPY.heading.setup,
  recovery: {
    title: RECOVERY_CODE_COPY.title,
    description: RECOVERY_CODE_COPY.description.create,
  },
  check: CREATE_ACCOUNT_COPY.heading.check,
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

// Why the check failed, which decides what the step says and offers.
type CheckError = 'empty' | 'mismatch' | 'offered' | 'weak';

// Whether the browser put this value here, as opposed to the user typing or pasting
// it. `:autofill` clears on the next edit. Older engines throw on the selector, and
// there the answer is the plain mismatch, which is what they got before this existed.
function filledByBrowser(input: HTMLInputElement | null) {
  try {
    return input?.matches(':autofill') ?? false;
  } catch {
    return false;
  }
}

export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [step, setStep] = React.useState<Step>('setup');
  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);

  // `username` is the zxcvbn penalty term.
  const chosen = useNewPassword({ username });
  const password = chosen.password;

  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoverySaved, setRecoverySaved] = React.useState(false);
  const [withRecovery, setWithRecovery] = React.useState(false);

  const [checkInput, setCheckInput] = React.useState('');
  const [checkError, setCheckError] = React.useState<CheckError | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [adopting, setAdopting] = React.useState(false);
  const checkInputRef = React.useRef<HTMLInputElement>(null);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Mint the recovery code the first time the user reaches that step.
  React.useEffect(() => {
    if (step === 'recovery' && !recoveryCode) setRecoveryCode(generateRecoveryCode());
  }, [step, recoveryCode]);

  // Live username validation + availability (the hook debounces and gates on a valid
  // format internally). Both fields work the same way from here: one ladder produces
  // the message, and the message IS the gate — `tone === 'ok'` is the full pass, so
  // Continue can't disagree with the sentence under the field it's blocked on. See
  // usernameMessage for what "ok" costs (a settled, CURRENT answer, not a debounce-
  // stale one).
  const availability = useUsernameAvailable(username);
  const usernameMsg = usernameMessage(username, availability, usernameTaken);

  const canContinueSetup = usernameMsg.tone === 'ok' && chosen.ok;

  const regenerateRecovery = () => {
    setRecoveryCode(generateRecoveryCode());
    setRecoverySaved(false);
  };

  const goCheck = (recovery: boolean) => {
    setWithRecovery(recovery);
    setCheckInput('');
    setCheckError(null);
    setShowPassword(false);
    setSubmitError(null);
    setStep('check');
  };

  const createTheAccount = async () => {
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

  const finish = () => {
    // Empty first, and canonical, so a few spaces count as nothing: derivation trims
    // them. The button stays live (docs/account.md, _when a submit is allowed to be
    // `disabled`_), and saying the field is empty reveals nothing about the password.
    if (canonicalizePassword(checkInput) === '') {
      setCheckError('empty');
      return;
    }
    // Compare the CANONICAL forms: derivation canonicalizes both, so encodings that
    // derive the same KEK (e.g. a trailing space) must count as a match here too —
    // otherwise we'd reject a re-entry that would actually sign in fine.
    if (canonicalizePassword(checkInput) !== canonicalizePassword(password)) {
      setCheckError(filledByBrowser(checkInputRef.current) ? 'offered' : 'mismatch');
      return;
    }
    // Reachable only after `adoptOffered`: step one's gate already passed anything else.
    if (!chosen.ok) {
      setCheckError('weak');
      return;
    }
    void createTheAccount();
  };

  // THE SAFETY NET UNDER SAFARI'S HEURISTICS (docs/account.md, _how safari tells a
  // login from a sign-up_). No attribute turns off its strong-password offer, and
  // which forms get one is decided by words on the page, so this step cannot promise
  // it never appears. If it does, and the offer is taken, Safari has ALREADY saved its
  // password under this username, and the worst thing the old form could do was
  // refuse that value and finish with the words: a saved copy that can never sign in,
  // on an account with no reset. So the form believes the manager instead. No account
  // exists yet, so changing the password is free, and the saved copy and the account
  // now agree however the page was classified. The same goes for an older save of
  // this username, left by regenerating after a browser had already saved.
  //
  // It finishes by itself, because the button already said what the user wants. It
  // does so from an effect because the value still has to pass step one's gate, and
  // the ladder answers on the render after the password changes.
  const adoptOffered = () => {
    chosen.setPassword(checkInput);
    setCheckError(null);
    setAdopting(true);
  };

  const adopted = adopting && password === checkInput;
  const adoptedTone = chosen.message.tone;
  React.useEffect(() => {
    if (!adopted || adoptedTone === 'muted') return;
    setAdopting(false);
    if (adoptedTone === 'ok') void createTheAccount();
    else setCheckError('weak');
    // `createTheAccount` closes over the password this effect has just seen settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adopted, adoptedTone]);

  const pending = createAccount.isPending;

  // --- step: setup ----------------------------------------------------------
  if (step === 'setup') {
    const usernameInvalid = usernameMsg.tone === 'error';

    return (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (canContinueSetup) setStep('recovery');
        }}
      >
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

          <NewPasswordField
            control={chosen}
            id="signup-new-password"
            label={CREATE_ACCOUNT_COPY.passwordLabel}
          />

          <Field>
            <Button type="submit" className="w-full" disabled={!canContinueSetup}>
              Continue
            </Button>
          </Field>
        </FieldGroup>
      </form>
    );
  }

  // --- step: recovery -------------------------------------------------------
  if (step === 'recovery') {
    return (
      <FieldGroup>
        <StepHeader step="recovery" onBack={() => setStep('setup')} />
        <Field>
          {/* No label here: this step has no input to name — ShowOnceSecret carries
              its own `label` — so the step title in the StepHeader is the only
              heading this content needs. */}
          <ShowOnceSecret
            secret={recoveryCode}
            label={RECOVERY_CODE_COPY.secretLabel}
            confirm={{
              id: 'recovery-saved',
              saved: recoverySaved,
              onSavedChange: setRecoverySaved,
              label: RECOVERY_CODE_COPY.confirmLabel,
            }}
            actions={
              // Step one's look, on the panel's stack: still ABOVE the full-width Copy,
              // because here nothing downstream checks a stale code, but on the RIGHT,
              // where step one put it, so the eye goes from the code to Copy and this
              // reads as the aside it is. Its target stops
              // at 6px below, half the 12px gap to Copy; above, the code's box takes
              // no tap, so it reaches the full 12.
              <button
                type="button"
                onClick={regenerateRecovery}
                className={cn(SECRET_TEXT_ACTION, 'self-end after:-top-3 after:-bottom-1.5')}
              >
                <RefreshCw className="size-3.5" />
                {NEW_PASSWORD_COPY.regenerate}
              </button>
            }
          />
        </Field>

        {/* TWO WAYS ON, and the second one has to say so. It read "Skip for now — I'll
            set this up later" as an underlined text link, which described neither what
            it does nor what it is. With the primary greyed out until the checkbox is
            ticked, the only LIVE control on the screen was one labelled "skip" and
            painted in the register this app reserves for NAVIGATION (AuthAltAction's
            "Sign in"). Naming the outcome makes the pair differ in what's true
            afterwards, not in whether anything happens at all.

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
            below explains why this step doesn't.

            THE SECOND LABEL WRAPS, and its button grows with it instead of pinning
            `h-9` — the same fix as the native twin, for the same reason: on a narrow
            phone ui/button.tsx's `whitespace-nowrap` runs a long label through the
            padding. Shortening it is not available — the label is the outcome, word
            for word. So `whitespace-normal`, and `min-h` rather than `h`. `py-1.5`,
            not the native `py-2`: this box carries a 1px border, so one `text-sm` line
            is 20 + 12 + 2 = 34 and still lands on the 36 the primary above it has,
            where `py-2` would make it 38. `text-balance` keeps a lone "code" off the
            second line. */}
        <Field>
          <Button
            type="button"
            className="w-full"
            disabled={!recoverySaved}
            onClick={() => goCheck(true)}
          >
            Continue
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-9 w-full py-1.5 text-balance whitespace-normal text-muted-foreground"
            onClick={() => goCheck(false)}
          >
            {CREATE_ACCOUNT_COPY.continueWithoutRecovery}
          </Button>
        </Field>
      </FieldGroup>
    );
  }

  // --- step: check ----------------------------------------------------------
  const checkInvalid = checkError !== null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        finish();
      }}
    >
      <FieldGroup>
        <StepHeader step="check" onBack={() => setStep('recovery')} />
        <Field>
          {/* VISIBLE, not HiddenUsername. A manager reads a login as a pair, this is
              the form it saves from, and the same field tells a person whose password
              to look up. Canonical, because that is the name the account is created
              under. Read-only rather than disabled, as the expired-session sign-in
              does it: it stays in the tab order and is still announced. */}
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            readOnly
            value={canonicalizeUsername(username)}
          />
        </Field>
        <Field data-invalid={checkInvalid}>
          <FieldLabel htmlFor="password">{CREATE_ACCOUNT_COPY.passwordLabel}</FieldLabel>
          <PasswordInput
            ref={checkInputRef}
            id="password"
            autoComplete="current-password"
            autoFocus
            aria-invalid={checkInvalid}
            value={checkInput}
            onChange={(e) => {
              setCheckInput(e.target.value);
              if (checkError) setCheckError(null);
            }}
          />
          {/* FieldError, not a `text-destructive` FieldDescription: it renders
              `role="alert"`, so mounting it ANNOUNCES. Every error on this form
              arrives as the result of a click and nothing else changes on screen —
              a plain <p> leaves a screen-reader user with a button that silently
              re-enables and no idea why. Same reason sign-in-form uses it for
              `errors.root`. */}
          {checkError === 'empty' ? <FieldError>{CREATE_ACCOUNT_COPY.empty}</FieldError> : null}
          {checkError === 'mismatch' ? (
            <FieldError>{CREATE_ACCOUNT_COPY.mismatch}</FieldError>
          ) : null}
          {checkError === 'weak' ? <FieldError>{chosen.message.text}</FieldError> : null}
          {checkError === 'offered' ? (
            <>
              <FieldError>{CREATE_ACCOUNT_COPY.offeredPassword}</FieldError>
              <Button
                type="button"
                variant="outline"
                // The Field's `data-invalid` colours what it holds, and this is the way
                // out of the error, not more of it.
                className="w-full text-foreground"
                onClick={adoptOffered}
              >
                {CREATE_ACCOUNT_COPY.useOfferedPassword}
              </Button>
            </>
          ) : null}
        </Field>
        <Field>
          {/* LIVE: gating it on a match would make the button a hint oracle for the
              password being typed. `pending` is the one allowed disable, and the label
              carries it (docs/account.md, _when a submit is allowed to be `disabled`_). */}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? CREATE_ACCOUNT_COPY.creating : CREATE_ACCOUNT_COPY.signIn}
          </Button>
          {/* BELOW the button: this error is a RESULT, and above it the mount would
              push the button out from under a pointer about to retry. */}
          <FieldError>{submitError}</FieldError>
          {/* Keeps its words in both states, because they are what Safari reads
              (create-account-copy.ts), so it toggles on `aria-expanded` rather than on
              a label that changes. A `button`, like sign-in's: it opens something
              here, and leaves for nowhere. The `after:` slop is its target, as there. */}
          <button
            type="button"
            aria-expanded={showPassword}
            onClick={() => setShowPassword((shown) => !shown)}
            className="relative mt-1 text-sm text-muted-foreground underline after:absolute after:inset-x-0 after:-top-1.5 after:-bottom-3 hover:text-foreground"
          >
            {CREATE_ACCOUNT_COPY.showPassword}
          </button>
          {showPassword ? (
            <output
              aria-label={CREATE_ACCOUNT_COPY.shownPasswordLabel}
              className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
            >
              {password}
            </output>
          ) : null}
        </Field>
      </FieldGroup>
    </form>
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
// Swapping the title is the change the user actually notices.
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
// the only thing that says more is coming — by the last step the user has seen
// two screens and can infer the shape.
//
// Deliberately NOT dots, a progress bar, or a coloured capsule strip: dots imply
// steps you can click back to, which this ceremony doesn't offer past a single
// Back, and an accented indicator would outshout the primary button on the one
// screen (recovery) where that button is racing a second one. With the title now
// changing per step, "something changed" is carried by the largest text on the
// screen and the counter is left with the smaller job of saying how much is left.
// And deliberately no "(optional)" on the recovery step even though it is skippable —
// the ghost button there already offers the exit; pre-announcing it in the counter
// just discourages setting up the second door. See docs/account.md, _creating an
// account_.
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
