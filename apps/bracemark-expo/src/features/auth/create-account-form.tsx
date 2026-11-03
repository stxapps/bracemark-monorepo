import * as React from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { ChevronLeft, RefreshCw } from 'lucide-react-native';

import { useCreateAccount, UsernameTakenError } from '@stxapps/expo-react';
import {
  CREATE_ACCOUNT_COPY,
  NEW_PASSWORD_COPY,
  RECOVERY_CODE_COPY,
  usernameMessage,
  useUsernameAvailable,
} from '@stxapps/react';
import { canonicalizePassword, canonicalizeUsername, generateRecoveryCode } from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { advanceTo } from '../../lib/input-keyboard';
import { cn } from '../../lib/utils';
import { NewPasswordField, useNewPassword } from './new-password-field';
import { PasswordInput } from './password-input';
import { MESSAGE_TONE } from './password-strength';
import { SECRET_TEXT_ACTION, SECRET_TEXT_SLOP, ShowOnceSecret } from './show-once-secret';

// The "Secure your account" ceremony — the native port of web-ui's
// components/auth/create-account-form.tsx (see that file and docs/account.md,
// _creating an account_, for the full rationale). Three steps:
//   1. setup    — username + password, one real field for each
//   2. recovery — a generated recovery code (a second door), show-once, SKIPPABLE
//   3. check    — sign in with the saved copy, which creates the account
//
// The order and the words match web even though the reason for them does not reach
// here: this app gets no strong-password offer on iOS, and Safari's sign-up/login
// heuristic reads web pages. One ceremony on both platforms is the point, and the two
// load-bearing labels live in `CREATE_ACCOUNT_COPY` either way. Web's adopt branch has
// no twin: React Native has no `:autofill`, so nothing here can tell a filled value
// from a typed one, and offering to adopt a typo would undo the check.
//
// Not react-hook-form, for web's reason. Every step opens with a StepHeader, which
// is THE SCREEN'S heading: `(auth)/create-account/index.tsx` passes AuthScreen no
// `title`; see the note on StepHeader.

type Step = 'setup' | 'recovery' | 'check';

// Source of truth for the step COUNT as well as the order: StepHeader derives
// "n of 3" by index, so adding a step to the ceremony renumbers the indicator
// automatically instead of leaving a hardcoded "3" behind to go stale.
const STEPS: readonly Step[] = ['setup', 'recovery', 'check'];

// BOTH fields on the setup step keep a message line permanently, and every state
// fills it. The ladders behind those messages — `usernameMessage` and
// `newPasswordMessage` — live in `@stxapps/react` (lib/field-messages.ts) and are the
// SAME code the web twin runs, so the two platforms can't say different things about
// the same input; that file carries the full reasoning. Only the tone→class map is
// ours, and it comes from password-strength so a passing message is the same green as
// a passing meter. Each ladder is also THE GATE for its field (`tone === 'ok'`).

// The heading each step replaces the last one with: web's, from the same module.
const STEP_HEADINGS: Record<Step, { title: string; description: string }> = {
  setup: CREATE_ACCOUNT_COPY.heading.setup,
  recovery: {
    title: RECOVERY_CODE_COPY.title,
    description: RECOVERY_CODE_COPY.description.create,
  },
  check: CREATE_ACCOUNT_COPY.heading.check,
};

export function CreateAccountForm() {
  const createAccount = useCreateAccount();

  const [step, setStep] = React.useState<Step>('setup');
  const [username, setUsername] = React.useState('');
  const [usernameTaken, setUsernameTaken] = React.useState(false);

  // `username` is the zxcvbn penalty term.
  const chosen = useNewPassword({ username });
  const password = chosen.password;
  // Return on the username goes on to the password (lib/input-keyboard.ts).
  const passwordRef = React.useRef<TextInput>(null);

  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoverySaved, setRecoverySaved] = React.useState(false);
  const [withRecovery, setWithRecovery] = React.useState(false);

  const [checkInput, setCheckInput] = React.useState('');
  // Both name their message in CREATE_ACCOUNT_COPY. Web has two more, for its adopt
  // branch, which has no twin here.
  const [checkError, setCheckError] = React.useState<'empty' | 'mismatch' | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Mint the recovery code the first time the user reaches that step.
  React.useEffect(() => {
    if (step === 'recovery' && !recoveryCode) setRecoveryCode(generateRecoveryCode());
  }, [step, recoveryCode]);

  // Live username validation + availability (the hook debounces and gates on a valid
  // format internally). See usernameMessage for what "ok" costs (a settled, CURRENT
  // answer, not a debounce-stale one).
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

  const finish = async () => {
    // Empty first, and canonical, so a few spaces count as nothing, as on web.
    if (canonicalizePassword(checkInput) === '') {
      setCheckError('empty');
      return;
    }
    // Compare the CANONICAL forms: derivation canonicalizes both, so encodings that
    // derive the same KEK (e.g. a trailing space) must count as a match here too —
    // otherwise we'd reject a re-entry that would actually sign in fine.
    if (canonicalizePassword(checkInput) !== canonicalizePassword(password)) {
      setCheckError('mismatch');
      return;
    }
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
          {/* NOT `autoFocus`, and neither is sign-in's first field. Both screens
              are PUSHED from the landing CTAs, so focusing on mount runs the
              keyboard's slide-up against the navigator's slide-in, and then has
              AuthScreen's KeyboardAwareScrollView scroll this field clear of the
              keyboard — taking the lockup and the step's own description up with
              it, before the screen has finished arriving. That description is
              this screen's disclosure ("no email address, no password reset" —
              docs/account.md), i.e. the one line that has to land BEFORE anyone
              starts typing. The cost is one tap. Same divergence docs/editors.md
              records for the link editor's `focus`: on native a focus summons
              the keyboard, which web's `focus()` never does, so the web twins
              keep theirs. A field that swaps in WITHIN this screen still
              focuses — see the check step below. docs/soft-keyboard.md,
              _arrival_. */}
          <Input
            // RN has no <label for>: the Text above names nothing to a screen
            // reader, so the field is named directly (sign-in-form.tsx's header).
            aria-label="Username"
            // `username-new` is Android's autofill hint and has no iOS mapping in
            // React Native, which turns only the tokens it knows into a
            // `textContentType` — so iOS was left to guess what this field is,
            // beside a `new-password` field it offers to save a login for.
            autoComplete="username-new"
            textContentType="username"
            className={cn(usernameInvalid && 'border-destructive')}
            {...advanceTo(passwordRef)}
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

        <NewPasswordField
          control={chosen}
          label={CREATE_ACCOUNT_COPY.passwordLabel}
          shownLabel={CREATE_ACCOUNT_COPY.shownPasswordLabel}
          inputRef={passwordRef}
        />

        <Button disabled={!canContinueSetup} onPress={() => setStep('recovery')}>
          <Text>Continue</Text>
        </Button>
      </View>
    );
  }

  // --- step: recovery -------------------------------------------------------
  if (step === 'recovery') {
    return (
      <View className="gap-6">
        <StepHeader step="recovery" onBack={() => setStep('setup')} />
        <View className="gap-2">
          {/* No label here: this step has no input to name — ShowOnceSecret carries
              its own `label` — so the step title in the StepHeader is the only
              heading this content needs. */}
          <ShowOnceSecret
            secret={recoveryCode}
            label={RECOVERY_CODE_COPY.secretLabel}
            confirm={{
              saved: recoverySaved,
              onSavedChange: setRecoverySaved,
              label: RECOVERY_CODE_COPY.confirmLabel,
            }}
            actions={
              // Step one's look, on the panel's stack and on the right, as on web. The
              // slop stops at 6
              // below, half the 12 to Copy; 28 drawn makes 42.
              <Pressable
                role="button"
                onPress={regenerateRecovery}
                hitSlop={{ top: 8, bottom: 6, left: SECRET_TEXT_SLOP, right: SECRET_TEXT_SLOP }}
                className={cn(SECRET_TEXT_ACTION, 'self-end')}
              >
                <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">
                  {NEW_PASSWORD_COPY.regenerate}
                </Text>
              </Pressable>
            }
          />
        </View>

        {/* TWO WAYS ON, and the second one has to say so — the web twin's note carries
            the argument (why the outcome is the label rather than "Skip for now", why
            ghost rather than outline or secondary, and why mandatory isn't the fix).
            The native-specific half: `Button` at the default size is h-10 and already
            handles the disabled dimming. `gap-2` matches the web Field this stack
            mirrors (field.tsx's vertical variant — 8px, and the note there carries
            why).

            THE SECOND LABEL WRAPS, and its button grows with it instead of pinning
            `h-10`: one Dynamic Type step up it no longer fits the narrowest phones.
            Shortening it is not available — the label is the outcome, word for word
            (docs/account.md) — and shrinking it is the fix docs/accessibility.md,
            _font scaling_, rules out. So `min-h` rather than `h`. `py-2` is not the
            padding ui/button.tsx removed: that rule is for a pinned box, and here two
            `text-sm` lines are exactly the 40 minimum, so without it they would touch
            both edges; a one-line label still lands on 40. The two break strategies
            keep a lone "code" off the second line. */}
        <View className="gap-2">
          <Button disabled={!recoverySaved} onPress={() => goCheck(true)}>
            <Text>Continue</Text>
          </Button>
          <Button variant="ghost" className="h-auto min-h-10 py-2" onPress={() => goCheck(false)}>
            <Text
              className="shrink text-center text-muted-foreground"
              lineBreakStrategyIOS="push-out"
              textBreakStrategy="balanced"
            >
              {CREATE_ACCOUNT_COPY.continueWithoutRecovery}
            </Text>
          </Button>
        </View>
      </View>
    );
  }

  // --- step: check ----------------------------------------------------------
  return (
    <View className="gap-6">
      <StepHeader step="check" onBack={() => setStep('recovery')} />
      <View className="gap-2">
        <Text className="text-sm">Username</Text>
        {/* `editable={false}` as the expired-session sign-in does it: readable and
            focusable, and whose password this is, for a person and for a manager. */}
        <Input
          aria-label="Username"
          autoComplete="username"
          textContentType="username"
          editable={false}
          value={canonicalizeUsername(username)}
        />
      </View>
      <View className="gap-2">
        <Text className="text-sm">{CREATE_ACCOUNT_COPY.passwordLabel}</Text>
        {/* This one KEEPS `autoFocus` where the setup step's username dropped it: the
            step swaps in place on a screen that is already here, with no transition
            to fight, and the press that got you here was the intent to type the
            password again. */}
        <PasswordInput
          aria-label={CREATE_ACCOUNT_COPY.passwordLabel}
          autoComplete="current-password"
          autoFocus
          returnKeyType="go"
          onSubmitEditing={finish}
          className={cn(checkError && 'border-destructive')}
          value={checkInput}
          onChangeText={(text) => {
            setCheckInput(text);
            if (checkError) setCheckError(null);
          }}
        />
        {/* ErrorText for every error on this form — it carries the `role="alert"`
            that web gets from its twin's `FieldError`. Each one arrives as the result
            of a press with nothing else changing on screen, so without it TalkBack
            gets a button that silently re-enables and no reason why. */}
        {checkError ? <ErrorText>{CREATE_ACCOUNT_COPY[checkError]}</ErrorText> : null}
      </View>
      <View className="gap-2">
        <Button disabled={pending} onPress={finish}>
          <Text>{pending ? CREATE_ACCOUNT_COPY.creating : CREATE_ACCOUNT_COPY.signIn}</Text>
        </Button>
        {/* Below the button, matching web: the message is the RESULT of pressing it,
            so putting it above would shift it under a thumb that's about to retry. */}
        {submitError ? <ErrorText>{submitError}</ErrorText> : null}
        <Pressable
          role="button"
          aria-expanded={showPassword}
          onPress={() => setShowPassword((shown) => !shown)}
          className="items-center py-1"
        >
          <Text className="text-center text-sm text-muted-foreground underline">
            {CREATE_ACCOUNT_COPY.showPassword}
          </Text>
        </Pressable>
        {showPassword ? (
          <View
            aria-label={CREATE_ACCOUNT_COPY.shownPasswordLabel}
            className="rounded-lg border border-border bg-muted/40 px-3 py-2.5"
          >
            <Text selectable className="font-mono text-sm">
              {password}
            </Text>
          </View>
        ) : null}
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
