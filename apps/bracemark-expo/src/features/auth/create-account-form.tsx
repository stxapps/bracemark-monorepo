import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ChevronLeft, RefreshCw } from 'lucide-react-native';

import { useCreateAccount, UsernameTakenError } from '@stxapps/expo-react';
import { newPasswordMessage, usernameMessage, useUsernameAvailable } from '@stxapps/react';
import {
  canonicalizePassword,
  canonicalizeUsername,
  generatePassphrase,
  generateRecoveryCode,
  NEW_PASSWORD_MIN_LENGTH,
} from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { PasswordInput } from './password-input';
import { MESSAGE_TONE, PasswordStrengthMeter, usePasswordStrength } from './password-strength';
import { ShowOnceSecret } from './show-once-secret';

// The "Secure your account" ceremony — the native port of web-ui's
// components/auth/create-account-form.tsx (see that file and docs/account.md
// for the full rationale). Because the account is a password-derived wallet —
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
type Mode = 'generated' | 'own';

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
// a passing meter. Each ladder is also THE GATE for its field (`tone === 'ok'`).

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

export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [step, setStep] = React.useState<Step>('setup');
  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);

  const [mode, setMode] = React.useState<Mode>('generated');
  // Lazy initializer, unlike web's generate-on-mount effect: that dance exists
  // so SSR and client hydration agree, and native has no SSR.
  const [passphrase, setPassphrase] = React.useState(() => generatePassphrase());
  const [passphraseSaved, setPassphraseSaved] = React.useState(false);
  const [ownPassword, setOwnPassword] = React.useState('');

  const [confirmInput, setConfirmInput] = React.useState('');
  const [confirmError, setConfirmError] = React.useState(false);

  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoverySaved, setRecoverySaved] = React.useState(false);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

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

  const passwordChosen = mode === 'generated' ? passphraseSaved : passwordMsg.tone === 'ok';
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
      <View className="gap-6">
        <StepHeader step="setup" />
        <View className="gap-2">
          <Text className="text-sm font-medium">Username</Text>
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

        {mode === 'generated' ? (
          <View className="gap-2">
            <Text className="text-sm font-medium">Your password</Text>
            <Text className="text-sm text-muted-foreground">
              We generated a strong password for you. Save it in your password manager — there is no
              way to reset it if it&apos;s lost.
            </Text>
            <ShowOnceSecret
              secret={passphrase}
              label="Your password"
              saved={passphraseSaved}
              onSavedChange={setPassphraseSaved}
              confirmLabel="I've saved my password somewhere safe."
              // Both change WHICH password you end up with, so they ride in the
              // panel's `actions` slot — under the value, above Copy. Regenerate
              // also clears the saved checkbox below; sitting above it is what
              // makes that reset read as cause and effect.
              actions={
                <View className="flex-row items-center justify-between">
                  <Pressable
                    onPress={regeneratePassphrase}
                    className="flex-row items-center gap-1.5 py-1"
                  >
                    <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
                    <Text className="text-sm text-muted-foreground">Regenerate</Text>
                  </Pressable>
                  <Pressable onPress={() => setMode('own')} className="py-1">
                    <Text className="text-sm text-muted-foreground underline">Choose my own</Text>
                  </Pressable>
                </View>
              }
            />
          </View>
        ) : (
          <View className="gap-2">
            <Text className="text-sm font-medium">Password</Text>
            <PasswordInput
              autoComplete="new-password"
              className={cn(passwordInvalid && 'border-destructive')}
              value={ownPassword}
              onChangeText={setOwnPassword}
            />
            <PasswordStrengthMeter displayScore={displayScore} />
            <Text className={cn('text-sm', MESSAGE_TONE[passwordMsg.tone])}>
              {passwordMsg.text}
            </Text>
            <Text className="text-sm text-muted-foreground">
              A password of random words is stronger than most passwords you&apos;d type. If you use
              your own, make it long and unique — there is no way to reset it if it&apos;s lost.
            </Text>
            <Pressable onPress={() => setMode('generated')} className="self-start py-1">
              <Text className="text-sm text-muted-foreground underline">Generate one instead</Text>
            </Pressable>
          </View>
        )}

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
          {confirmError ? (
            <Text className="text-sm text-destructive">
              That doesn&apos;t match. Check what you saved and try again.
            </Text>
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
          label="Your recovery code"
          saved={recoverySaved}
          onSavedChange={setRecoverySaved}
          confirmLabel="I've saved my recovery code somewhere safe."
          actions={
            <Pressable
              onPress={regenerateRecovery}
              className="flex-row items-center gap-1.5 self-start py-1"
            >
              <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">Regenerate</Text>
            </Pressable>
          }
        />
      </View>

      <View className="gap-1">
        <Button disabled={!recoverySaved || pending} onPress={() => submit(true)}>
          <Text>{pending ? 'Creating account…' : 'Create account'}</Text>
        </Button>
        <Pressable
          onPress={() => submit(false)}
          disabled={pending}
          className={cn('items-center py-2', pending && 'opacity-50')}
        >
          <Text className="text-sm text-muted-foreground underline">
            Skip for now — I&apos;ll set this up later
          </Text>
        </Pressable>
        {submitError ? <Text className="text-sm text-destructive">{submitError}</Text> : null}
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
          <Pressable onPress={onBack} className="flex-row items-center gap-1 py-1">
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
