'use client';

import { type ReactNode, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import {
  CREATE_ACCOUNT_COPY,
  endWelcome,
  hasRecoveryDoorQueryKey,
  newPasswordMessage,
  RECOVERY_CODE_COPY,
  updateWelcomePassword,
  useWelcome,
  type Welcome,
  WELCOME_COPY,
} from '@stxapps/react';
import { canonicalizePassword, NEW_PASSWORD_MIN_LENGTH } from '@stxapps/shared';
import {
  UnconfirmedSaveError,
  useAuth,
  useChangePassword,
  useRecoveryCode,
} from '@stxapps/web-react';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import { usePasswordStrength } from '@stxapps/web-ui/components/auth/password-strength';
import { ShowOnceSecret } from '@stxapps/web-ui/components/auth/show-once-secret';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@stxapps/web-ui/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { cn } from '@stxapps/web-ui/lib/utils';

import { CardEyebrow, DogEaredCard, FocusedPage } from './focused-page';

// THE WELCOME (docs/account.md, _the welcome_). Create-account is one step and signs
// in; this is what follows it, once, for the account just made. A GATE, like
// InitialSyncGate beside it: it swaps content in place and never navigates, and the
// app under it is what the user lands in when it finishes. Three steps, each
// skippable, in an order that is the design:
//   1. recovery — make a recovery code, now, while the password is at hand;
//   2. check    — sign in with the saved copy, the way the next sign-in will;
//   3. start    — import bookmarks, or start empty.
// The code comes first because copying it replaces the clipboard: the check after it
// can't then be passed by pasting back a password copied on the create form.
//
// It runs on the password held in memory since the create (react/lib/welcome-store.ts):
// to mint the code without asking for it again, and for "Forgot your password? Show it
// again". A reload drops it, and with it this screen; Settings' nudge covers the code.
type Step = 'recovery' | 'check' | 'start';
const STEPS: readonly Step[] = ['recovery', 'check', 'start'];

export function WelcomeGate({ children }: { children: ReactNode }) {
  const welcome = useWelcome();
  const { username } = useAuth();
  // Only for the account it was begun for: a welcome left over from another account
  // (it can't be, teardown ends it, but the check is the cheap half of that promise)
  // never covers this one.
  if (!welcome || welcome.username !== username) return children;
  return <WelcomeScreen welcome={welcome} />;
}

function WelcomeScreen({ welcome }: { welcome: Welcome }) {
  const [step, setStep] = useState<Step>('recovery');
  const { title, description } = WELCOME_COPY.heading[step];

  return (
    <FocusedPage>
      <DogEaredCard>
        <CardHeader>
          <CardEyebrow>
            Step {STEPS.indexOf(step) + 1} of {STEPS.length}
          </CardEyebrow>
          <CardTitle
            // The page's heading: this screen is the whole page while it is up.
            role="heading"
            aria-level={1}
            className={cn('text-xl font-semibold tracking-tight')}
          >
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'recovery' ? (
            <RecoveryStep welcome={welcome} onDone={() => setStep('check')} />
          ) : step === 'check' ? (
            <CheckStep welcome={welcome} onDone={() => setStep('start')} />
          ) : (
            <StartStep />
          )}
        </CardContent>
      </DogEaredCard>
    </FocusedPage>
  );
}

// 1. The recovery code, made on request. Not before: an account whose code nobody
// saw would read as "has a recovery code" and silence Settings' nudge. The proof is
// the held password, so there is nothing to type.
function RecoveryStep({ welcome, onDone }: { welcome: Welcome; onDone: () => void }) {
  const recovery = useRecoveryCode();
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (recovery.isPending) return;
    setError(null);
    try {
      const result = await recovery.mutateAsync({
        proof: { kind: 'password', currentPassword: welcome.password },
      });
      setCode(result.recoveryCode);
      // The door exists now; Settings reads this to drop its nudge.
      queryClient.setQueryData([...hasRecoveryDoorQueryKey, welcome.username], true);
      void queryClient.invalidateQueries({ queryKey: hasRecoveryDoorQueryKey });
    } catch (err) {
      setError(
        err instanceof UnconfirmedSaveError
          ? WELCOME_COPY.recoveryUnconfirmed
          : WELCOME_COPY.recoveryFailed,
      );
    }
  };

  if (code) {
    return (
      <FieldGroup>
        <p className="flex items-start gap-2 text-sm text-foreground">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          {WELCOME_COPY.recoveryReady}
        </p>
        {/* Settings' panel, without its checkbox: the code is live already, and Copy is
            the step (show-once-secret.tsx). */}
        <ShowOnceSecret secret={code} label={RECOVERY_CODE_COPY.secretLabel} />
        <Button type="button" className="w-full" onClick={onDone}>
          {WELCOME_COPY.continue}
        </Button>
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <Field>
        <Button
          type="button"
          className="w-full"
          disabled={recovery.isPending}
          onClick={() => void create()}
        >
          {recovery.isPending ? (
            <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
          ) : null}
          {recovery.isPending ? WELCOME_COPY.creatingRecovery : WELCOME_COPY.createRecovery}
        </Button>
        <FieldError>{error}</FieldError>
        {/* Ghost, under the primary, as create-account's old recovery step had it: the
            exit is there and plain, and the recommended path stays the strongest
            thing on screen. */}
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          disabled={recovery.isPending}
          onClick={onDone}
        >
          {WELCOME_COPY.skipRecovery}
        </Button>
      </Field>
    </FieldGroup>
  );
}

type CheckError = 'empty' | 'mismatch' | 'offered';

// Whether the browser put this value here rather than the user typing or pasting it.
// `:autofill` clears on the next edit; an engine without the selector throws, and
// gets the plain mismatch.
function filledByBrowser(input: HTMLInputElement | null) {
  try {
    return input?.matches(':autofill') ?? false;
  } catch {
    return false;
  }
}

// 2. The check: a login, in shape and in words, because that is what makes a manager
// offer the copy it saved rather than a new password (docs/account.md, _how safari
// tells a login from a sign-up_). A local compare of canonical forms against the held
// password: derivation is deterministic, so a match here is a sign-in that works.
//
// THE SAFETY NET UNDER SAFARI'S HEURISTICS. If Safari reads this as a sign-up anyway
// and its strong password is taken, it has ALREADY saved that password under this
// username, over the real one. A saved copy that can't sign in, on an account with no
// reset, is the worst thing this screen could leave behind. So when the check fails
// AND the browser filled the field, it offers to make the account match: a real
// password change now, proved with the held password, behind the same floor any new
// password meets.
function CheckStep({ welcome, onDone }: { welcome: Welcome; onDone: () => void }) {
  const changePassword = useChangePassword();
  const [value, setValue] = useState('');
  const [checkError, setCheckError] = useState<CheckError | null>(null);
  const [passed, setPassed] = useState(false);
  const [shown, setShown] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The floor the browser's password has to clear before the account takes it, scored
  // only while it is on offer (no dictionary fetch otherwise).
  const offered = checkError === 'offered';
  const strength = usePasswordStrength(
    offered ? canonicalizePassword(value) : '',
    [welcome.username],
    NEW_PASSWORD_MIN_LENGTH,
  );
  const offeredMessage = offered
    ? newPasswordMessage(value, strength.guessesLog10, strength.failed, welcome.password)
    : null;

  const check = () => {
    if (canonicalizePassword(value) === '') {
      setCheckError('empty');
      return;
    }
    if (canonicalizePassword(value) !== canonicalizePassword(welcome.password)) {
      setCheckError(filledByBrowser(inputRef.current) ? 'offered' : 'mismatch');
      return;
    }
    setPassed(true);
  };

  const adoptOffered = async () => {
    if (changePassword.isPending || offeredMessage?.tone !== 'ok') return;
    setSwitchError(null);
    try {
      await changePassword.mutateAsync({
        newPassword: value,
        proof: { kind: 'password', currentPassword: welcome.password },
      });
      updateWelcomePassword(value);
      setCheckError(null);
      setPassed(true);
    } catch {
      setSwitchError(WELCOME_COPY.switchFailed);
    }
  };

  if (passed) {
    return (
      <FieldGroup>
        <p role="status" className="flex items-start gap-2 text-sm text-foreground">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          {WELCOME_COPY.passed}
        </p>
        <Button type="button" className="w-full" onClick={onDone}>
          {WELCOME_COPY.continue}
        </Button>
      </FieldGroup>
    );
  }

  const invalid = checkError !== null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        check();
      }}
    >
      <FieldGroup>
        <Field>
          {/* Visible and read-only: a manager reads a login as a pair, and a person is
              told whose password to look up. Read-only rather than disabled, so it
              stays in the tab order and in what a manager reads. */}
          <FieldLabel htmlFor="welcome-username">Username</FieldLabel>
          <Input
            id="welcome-username"
            type="text"
            autoComplete="username"
            readOnly
            value={welcome.username}
          />
        </Field>
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor="welcome-password">Password</FieldLabel>
          <PasswordInput
            ref={inputRef}
            id="welcome-password"
            autoComplete="current-password"
            autoFocus
            aria-invalid={invalid}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (checkError) setCheckError(null);
              setSwitchError(null);
            }}
          />
          {checkError === 'empty' ? <FieldError>{WELCOME_COPY.empty}</FieldError> : null}
          {checkError === 'mismatch' ? <FieldError>{WELCOME_COPY.mismatch}</FieldError> : null}
          {offered ? (
            <>
              <FieldError>
                {offeredMessage && offeredMessage.tone !== 'ok' && offeredMessage.tone !== 'muted'
                  ? offeredMessage.text
                  : WELCOME_COPY.offeredPassword}
              </FieldError>
              <Button
                type="button"
                variant="outline"
                // The Field's `data-invalid` colours what it holds, and this is the
                // way out of the error, not more of it.
                className="w-full text-foreground"
                disabled={changePassword.isPending || offeredMessage?.tone !== 'ok'}
                onClick={() => void adoptOffered()}
              >
                {changePassword.isPending
                  ? WELCOME_COPY.switchingPassword
                  : WELCOME_COPY.useOfferedPassword}
              </Button>
              <FieldError>{switchError}</FieldError>
            </>
          ) : null}
        </Field>
        <Field>
          {/* LIVE: gating it on a match would make the button a hint oracle. */}
          <Button type="submit" className="w-full">
            {WELCOME_COPY.signIn}
          </Button>
          {/* Keeps its words in both states, because they are what Safari reads, so it
              toggles on `aria-expanded` rather than on a label that changes. */}
          <button
            type="button"
            aria-expanded={shown}
            onClick={() => setShown((s) => !s)}
            className="relative mt-1 text-sm text-muted-foreground underline after:absolute after:inset-x-0 after:-top-1.5 after:-bottom-3 hover:text-foreground"
          >
            {WELCOME_COPY.showPassword}
          </button>
          {shown ? (
            <output
              aria-label={CREATE_ACCOUNT_COPY.shownPasswordLabel}
              className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
            >
              {welcome.password}
            </output>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full text-muted-foreground"
            onClick={onDone}
          >
            {WELCOME_COPY.skipCheck}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}

// 3. In. Ending the welcome drops the held password and uncovers the app; the import
// goes on to Settings → Data, where importing lives.
function StartStep() {
  const router = useRouter();
  return (
    <FieldGroup>
      <Field>
        <Button
          type="button"
          className="w-full"
          onClick={() => {
            endWelcome();
            router.push('/settings/data');
          }}
        >
          {WELCOME_COPY.importBookmarks}
        </Button>
        <Button type="button" variant="outline" className="w-full" onClick={endWelcome}>
          {WELCOME_COPY.startEmpty}
        </Button>
      </Field>
    </FieldGroup>
  );
}
