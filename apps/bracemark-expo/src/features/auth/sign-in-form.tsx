import * as React from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, View } from 'react-native';

import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  useSignIn,
  useSignInWithRecovery,
} from '@stxapps/expo-react';
import { useSignInForm } from '@stxapps/react';
import type { SignInValues } from '@stxapps/shared';

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
        <Text className="text-sm font-medium">Username</Text>
        <Controller
          control={control}
          name="username"
          render={({ field }) => (
            <Input
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
        {errors.username ? (
          <Text className="text-sm text-destructive">{errors.username.message}</Text>
        ) : null}
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium">Password</Text>
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <PasswordInput
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
        {errors.password ? (
          <Text className="text-sm text-destructive">{errors.password.message}</Text>
        ) : null}
      </View>

      <View className="gap-1">
        <Button disabled={isSubmitting} onPress={handleSubmit(onSubmit)}>
          <Text>{isSubmitting ? 'Signing in…' : 'Sign in'}</Text>
        </Button>
        {errors.root ? (
          <Text className="text-sm text-destructive">{errors.root.message}</Text>
        ) : null}
        <Pressable onPress={onUseRecovery} className="items-center py-2">
          <Text className="text-sm text-muted-foreground underline">
            Forgot your password? Use a recovery code
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function RecoverySignIn({ onUsePassword }: { onUsePassword: () => void }) {
  const signIn = useSignInWithRecovery();
  const [username, setUsername] = React.useState('');
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit() {
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
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-sm font-medium">Username</Text>
        <Input
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          value={username}
          onChangeText={(text) => {
            setUsername(text);
            if (error) setError(null);
          }}
        />
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium">Recovery code</Text>
        <Input
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect={false}
          className="font-mono"
          value={recoveryCode}
          onChangeText={(text) => {
            setRecoveryCode(text);
            if (error) setError(null);
          }}
        />
      </View>

      <View className="gap-1">
        <Button
          disabled={signIn.isPending || username === '' || recoveryCode === ''}
          onPress={onSubmit}
        >
          <Text>{signIn.isPending ? 'Signing in…' : 'Sign in with recovery code'}</Text>
        </Button>
        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        <Pressable onPress={onUsePassword} className="items-center py-2">
          <Text className="text-sm text-muted-foreground underline">Use your password instead</Text>
        </Pressable>
      </View>
    </View>
  );
}
