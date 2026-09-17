import * as React from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, View } from 'react-native';

import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  useSignIn,
  useSignInWithRecovery,
} from '@stxapps/expo-react';
import { useRecoverySignInForm, useSignInForm } from '@stxapps/react';
import type { RecoverySignInValues, SignInValues } from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { PasswordInput } from './password-input';

// The native port of web-ui's components/auth/sign-in-form.tsx (see that file
// for the full rationale). Two modes: the normal password sign-in and the
// recovery-code path (the escape hatch when the password is lost — the recovery
// door unwraps the same DEK). Same react-hook-form setup as web via the shared
// useSignInForm; the RN difference is Controller + onChangeText in place of
// register (no DOM events to spread).
//
// Every control here carries a `testID`: this is the one screen every Maestro
// flow crosses, and flows may bind to `testID` and accessible labels but never
// to body copy (docs/e2e.md, _the testID contract_) — including the two mode
// toggles, which is how a flow reaches the recovery door at all. The
// `aria-label`s are not the same job and do not replace them: RN has no
// `<label for>`, so an Input whose only label is the adjacent `<Text>` announces
// as an unnamed text field.
//
// A FIELD LABEL HERE IS `text-sm`, WEIGHT UNSET — not `font-medium`, which is
// what all seven label sites across the three auth twins carried until they were
// levelled. There is no `Label` component on this side (RN has no `<label>`, so
// each is a bare `Text` above its control), which is exactly why the weight could
// drift with nothing to catch it: web's `Label` deliberately ships `font-normal`
// against shadcn's `font-medium`, and its reasoning is stronger on native, not
// weaker. That reasoning is "at 14px over an Input that's 16px until `md:`, the
// extra weight read as shouting" (web-ui/components/ui/label.tsx) — and this
// app's Input is a flat `text-base` on native at EVERY width (the `md:text-sm`
// sitting beside it is web-only and deliberately unported — input.tsx), so the
// label is always the smaller of the two here, on a tablet as much as on a
// phone. Position and the size gap carry the distinction; weight was a third
// signal doing the same job twice. The `wght` axis of InterVariable really does
// back these utilities (docs/expo-dependencies.md, _font_), so this is a visible
// 500 → 400, not a no-op. It holds for create-account-form.tsx and
// new-password-field.tsx too.
// The one `font-medium` that STAYS in this folder is auth-alt-action.tsx's link,
// whose web twin is medium as well — that one is an affordance, not a label.
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
    control,
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
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-sm">Username</Text>
        {/* NO `autoFocus` on the first field of either door — this screen is
            pushed from the landing CTA, and a keyboard raised during that
            slide-in arrives over a card the user hasn't seen yet. The argument
            in full is on create-account-form.tsx's username field;
            docs/soft-keyboard.md, _arrival_, carries the rule. The recovery
            door below keeps its `autoFocus`: it swaps in on a press, on a
            screen already on the glass. */}
        <Controller
          control={control}
          name="username"
          render={({ field }) => (
            <Input
              testID="sign-in-username"
              aria-label="Username"
              aria-invalid={!!errors.username}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect={false}
              className={cn(errors.username && 'border-destructive')}
              value={field.value}
              onBlur={field.onBlur}
              onChangeText={(text) => {
                field.onChange(text);
                clearRootError();
              }}
            />
          )}
        />
        {errors.username ? <ErrorText>{errors.username.message}</ErrorText> : null}
      </View>

      <View className="gap-2">
        <Text className="text-sm">Password</Text>
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <PasswordInput
              testID="sign-in-password"
              aria-label="Password"
              aria-invalid={!!errors.password}
              autoComplete="current-password"
              className={cn(errors.password && 'border-destructive')}
              value={field.value}
              onBlur={field.onBlur}
              onChangeText={(text) => {
                field.onChange(text);
                clearRootError();
              }}
            />
          )}
        />
        {errors.password ? <ErrorText>{errors.password.message}</ErrorText> : null}
      </View>

      <View className="gap-1">
        <Button testID="sign-in-submit" disabled={isSubmitting} onPress={handleSubmit(onSubmit)}>
          <Text>{isSubmitting ? 'Signing in…' : 'Sign in'}</Text>
        </Button>
        {errors.root ? <ErrorText testID="sign-in-error">{errors.root.message}</ErrorText> : null}
        <Pressable
          testID="sign-in-use-recovery"
          role="button"
          onPress={onUseRecovery}
          className="items-center py-2"
        >
          <Text className="text-center text-sm text-muted-foreground underline">
            Forgot your password? Use a recovery code
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// The same form as PasswordSignIn above with the door swapped, and built the same
// way — react-hook-form over the shared `recoverySignInSchema`, per-field errors,
// a submit-level `root`. It used to hand-roll two useState fields and disable
// itself on empty input, which made it the only submit in either auth form that
// went dead with nothing on screen saying why; see the web twin and
// docs/account.md, _when a submit is allowed to be `disabled`_.
function RecoverySignIn({ onUsePassword }: { onUsePassword: () => void }) {
  const {
    control,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useRecoverySignInForm();
  const signIn = useSignInWithRecovery();

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
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-sm">Username</Text>
        <Controller
          control={control}
          name="username"
          render={({ field }) => (
            <Input
              testID="sign-in-recovery-username"
              aria-label="Username"
              aria-invalid={!!errors.username}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              className={cn(errors.username && 'border-destructive')}
              value={field.value}
              onBlur={field.onBlur}
              onChangeText={(text) => {
                field.onChange(text);
                clearRootError();
              }}
            />
          )}
        />
        {errors.username ? <ErrorText>{errors.username.message}</ErrorText> : null}
      </View>

      <View className="gap-2">
        <Text className="text-sm">Recovery code</Text>
        <Controller
          control={control}
          name="recoveryCode"
          render={({ field }) => (
            <Input
              testID="sign-in-recovery-code"
              aria-label="Recovery code"
              aria-invalid={!!errors.recoveryCode}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect={false}
              className={cn('font-mono', errors.recoveryCode && 'border-destructive')}
              value={field.value}
              onBlur={field.onBlur}
              onChangeText={(text) => {
                field.onChange(text);
                clearRootError();
              }}
            />
          )}
        />
        {errors.recoveryCode ? <ErrorText>{errors.recoveryCode.message}</ErrorText> : null}
      </View>

      <View className="gap-1">
        <Button
          testID="sign-in-recovery-submit"
          disabled={isSubmitting}
          onPress={handleSubmit(onSubmit)}
        >
          <Text>{isSubmitting ? 'Signing in…' : 'Sign in with recovery code'}</Text>
        </Button>
        {errors.root ? (
          <ErrorText testID="sign-in-recovery-error">{errors.root.message}</ErrorText>
        ) : null}
        <Pressable
          testID="sign-in-use-password"
          role="button"
          onPress={onUsePassword}
          className="items-center py-2"
        >
          <Text className="text-center text-sm text-muted-foreground underline">
            Use your password instead
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
