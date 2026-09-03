import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ChevronLeft, RefreshCw } from 'lucide-react-native';

import { useCreateAccount, UsernameTakenError } from '@stxapps/expo-react';
import { RECOVERY_CODE_COPY, usernameMessage, useUsernameAvailable } from '@stxapps/react';
import { canonicalizePassword, canonicalizeUsername, generateRecoveryCode } from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { NewPasswordField, useNewPassword } from './new-password-field';
import { PasswordInput } from './password-input';
import { MESSAGE_TONE } from './password-strength';
import { ShowOnceSecret } from './show-once-secret';

// The "Secure your account" ceremony — the native port of web-ui's
// components/auth/create-account-form.tsx (see that file and docs/account.md
// for the full rationale). Because the account is a password-unlocked wallet —
// no email, no server-side reset — the safe path is the DEFAULT path: a
// generated ~77-bit passphrase, shown once wallet-style, with a "type my own"
// escape hatch gated by a zxcvbn strength floor. Three steps:
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
// step's own title and description. That header is THE SCREEN'S heading, which is
// why `(auth)/create-account/index.tsx` passes AuthScreen no `title`; see the note
// on StepHeader for why it has to be the form that owns it.

type Step = 'setup' | 'confirm' | 'recovery';

// Source of truth for the step COUNT as well as the order: StepHeader derives
// "n of 3" by index, so adding a step to the ceremony renumbers the indicator
// automatically instead of leaving a hardcoded "3" behind to go stale.
const STEPS: readonly Step[] = ['setup', 'confirm', 'recovery'];

// BOTH fields on the setup step keep a message line permanently, and every state
// fills it. The ladders behind those messages — `usernameMessage` and
// `newPasswordMessage` — live in `@stxapps/react` (lib/field-messages.ts) and are the
// SAME code the web twin runs, so the two platforms can't say different things about
// the same input; that file carries the full reasoning. Only the tone→class map is
// ours, and it comes from password-strength so a passing message is the same green as
// a passing meter. Each ladder is also THE GATE for its field (`tone === 'ok'`). The
// password half — the generated/typed choice, its meter, its message and its gate — is
// `NewPasswordField`, shared with Settings → change password; only the username field
// is this form's own.

// The heading each step replaces the last one with. Step one's pair is the line
// the screen header used to carry, and it is a disclosure rather than a caption:
// both halves name a field this form will never show. There is no email address
// and no reset link, not as omissions but because the account has neither
// (docs/account.md — the secret IS the account), and that is what makes step
// three hand the user a code it insists they save. Steps two and three then say
// what THEY are for, which is the same warning arriving at the moment it bites.
const STEP_HEADINGS: Record<Step, { title: string; description: string }> = {
  setup: {
    title: 'Create account',
    description:
      'No email address, no password reset — your password unlocks the key to your links.',
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
      <View className="gap-6">
        <StepHeader step="setup" />
        <View className="gap-2">
          <Text className="text-sm">Username</Text>
          <Input
            autoComplete="username-new"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            className={cn(usernameInvalid && 'border-destructive')}
            value={username}
            onChangeText={(text) => {
              setUsername(text);
              setUsernameTaken(false);
            }}
          />
          {/* `aria-live` so the availability verdict is announced when it lands —
              it arrives without the user typing anything, and it's now a permanent
              node rather than one that mounts, which is what makes a live region
              the right tool here. */}
          <Text aria-live="polite" className={cn('text-sm', MESSAGE_TONE[usernameMsg.tone])}>
            {usernameMsg.text}
          </Text>
        </View>

        <NewPasswordField control={newPassword} copy="create" />

        <Button disabled={!canContinueSetup} onPress={goConfirm}>
          <Text>Continue</Text>
        </Button>
      </View>
    );
  }

  // --- step: confirm --------------------------------------------------------
  if (step === 'confirm') {
    return (
      <View className="gap-6">
        <StepHeader step="confirm" onBack={() => setStep('setup')} />
        <View className="gap-2">
          {/* The visible label for this input is the step's own title, up in the
              StepHeader — but a heading is not a label, so the field would reach
              a screen reader unnamed. RN has no <label for>, so name it directly. */}
          <PasswordInput
            aria-label="Confirm your password"
            autoComplete="new-password"
            autoFocus
            className={cn(confirmError && 'border-destructive')}
            value={confirmInput}
            onChangeText={(text) => {
              setConfirmInput(text);
              if (confirmError) setConfirmError(false);
            }}
          />
          {/* ErrorText for both of this form's errors — it carries the
              `role="alert"` that web gets from its twin's `FieldError`. Each one
              arrives as the result of a press with nothing else changing on
              screen, so without it TalkBack gets a button that silently
              re-enables and no reason why. */}
          {confirmError ? (
            <ErrorText>That doesn’t match. Check what you saved and try again.</ErrorText>
          ) : null}
        </View>
        <Button onPress={goRecovery}>
          <Text>Continue</Text>
        </Button>
      </View>
    );
  }

  // --- step: recovery -------------------------------------------------------
  return (
    <View className="gap-6">
      <StepHeader step="recovery" onBack={() => setStep('confirm')} />
      <View className="gap-2">
        {/* No label here, unlike the confirm step: this step has no input to
            name — ShowOnceSecret carries its own `label` — so the step title in
            the StepHeader is the only heading this content needs. */}
        <ShowOnceSecret
          secret={recoveryCode}
          label={RECOVERY_CODE_COPY.secretLabel}
          saved={recoverySaved}
          onSavedChange={setRecoverySaved}
          confirmLabel={RECOVERY_CODE_COPY.confirmLabel}
          actions={
            <Pressable
              role="button"
              onPress={regenerateRecovery}
              className="flex-row items-center gap-1.5 self-start py-1"
            >
              <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">Regenerate</Text>
            </Pressable>
          }
        />
      </View>

      {/* TWO WAYS TO CREATE THE ACCOUNT, and the second one has to say so — the
          web twin's note carries the argument (why the outcome is the label rather
          than "Skip for now", why ghost rather than outline or secondary, and why
          mandatory isn't the fix). The native-specific half: this was a bare
          `Pressable` around a line of `text-sm`, a ~20pt target against Apple's
          44pt floor, on the second-most-important control of the screen. `Button`
          at the default size is h-10 and already handles the disabled dimming, so
          the manual `opacity-50` goes with it. `gap-2` matches the web Field this
          stack mirrors (field.tsx's vertical variant — 8px, and the note there
          carries why); an earlier `gap-1` was compensating for the Pressable's own
          `py-2`, which the Button doesn't need. */}
      <View className="gap-2">
        <Button disabled={!recoverySaved || pending} onPress={() => submit(true)}>
          <Text>{pending ? 'Creating account…' : 'Create account'}</Text>
        </Button>
        <Button variant="ghost" disabled={pending} onPress={() => submit(false)}>
          <Text className="text-muted-foreground">Create account without a recovery code</Text>
        </Button>
        {/* Below the pair, matching web: the message is the RESULT of pressing one
            of them, so putting it above would shift both buttons down under a
            thumb that's about to retry. */}
        {submitError ? <ErrorText>{submitError}</ErrorText> : null}
      </View>
    </View>
  );
}

// What every step opens with: a chrome row (back link on the left, absent on the
// first step; "Step n of 3" on the right) over that step's own title and
// description. The native twin of web-ui's StepHeader — see that file for why the
// heading is the STEP's rather than a static "Create account", why it has to live
// in the form rather than the screen header, why the counter matters most on step
// ONE, and why it's neither dots, a progress bar, nor a coloured capsule strip.
//
// The title carries the `role="heading"` / `aria-level="1"` that AuthScreen puts on
// its own title, because this IS the screen's h1 now — create-account passes
// AuthScreen no `title`, so nothing else claims that level.
function StepHeader({ step, onBack }: { step: Step; onBack?: () => void }) {
  const { title, description } = STEP_HEADINGS[step];
  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        {onBack ? (
          <Pressable role="button" onPress={onBack} className="flex-row items-center gap-1 py-1">
            <Icon as={ChevronLeft} className="size-4 text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">Back</Text>
          </Pressable>
        ) : (
          // Holds the right-hand column in place on the first step, where there's
          // nothing to go back to — `justify-between` alone would left-align the count.
          <View />
        )}
        <Text className="text-sm text-muted-foreground">
          Step {STEPS.indexOf(step) + 1} of {STEPS.length}
        </Text>
      </View>
      <View className="gap-1.5">
        <Text
          role="heading"
          aria-level="1"
          className="text-xl font-semibold tracking-tight text-card-foreground"
        >
          {title}
        </Text>
        <Text className="text-sm text-muted-foreground">{description}</Text>
      </View>
    </View>
  );
}
