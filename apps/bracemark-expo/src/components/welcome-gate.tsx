import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { CircleCheck } from 'lucide-react-native';

import { useAuth, useRecoveryCode } from '@stxapps/expo-react';
import {
  CREATE_ACCOUNT_COPY,
  endWelcome,
  hasRecoveryDoorQueryKey,
  RECOVERY_CODE_COPY,
  useWelcome,
  type Welcome,
  WELCOME_COPY,
} from '@stxapps/react';
import { canonicalizePassword } from '@stxapps/shared';

import { AuthScreen } from '../features/auth/auth-screen';
import { PasswordInput } from '../features/auth/password-input';
import { ShowOnceSecret } from '../features/auth/show-once-secret';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { ErrorText } from './error-text';
import { FirstLineSlot } from './first-line-slot';

// THE WELCOME — the native port of bracemark-web's components/welcome-gate.tsx, which
// carries the argument (docs/account.md, _the welcome_): once, after create-account,
// for the account just made — a recovery code, a check of the saved password, then
// import or start. A GATE, like InitialSyncGate above it: a content swap, never a
// redirect, on the password held in memory since the create
// (react/lib/welcome-store.ts).
//
// One difference: web's check offers to switch the account to a password the browser
// filled. React Native has no `:autofill`, so nothing here can tell a filled value
// from a typed one, and offering to adopt a typo would undo the check. A mismatch gets
// the message and "Show it again".
type Step = 'recovery' | 'check' | 'start';
const STEPS: readonly Step[] = ['recovery', 'check', 'start'];

export function WelcomeGate({ children }: { children: ReactNode }) {
  const welcome = useWelcome();
  const { username } = useAuth();
  // Import goes to Settings → Data, a route inside the Stack this gate covers, so the
  // push waits for the Stack to be back: effects run child-first, so by this one the
  // navigator under it has mounted.
  const afterWelcome = useRef<string | null>(null);
  const shown = !!welcome && welcome.username === username;
  useEffect(() => {
    if (shown || !afterWelcome.current) return;
    const href = afterWelcome.current;
    afterWelcome.current = null;
    router.push(href as '/settings/[section]');
  }, [shown]);

  if (!welcome || !shown) return children;
  return (
    <WelcomeScreen
      welcome={welcome}
      onImport={() => {
        afterWelcome.current = '/settings/data';
        endWelcome();
      }}
    />
  );
}

function WelcomeScreen({ welcome, onImport }: { welcome: Welcome; onImport: () => void }) {
  const [step, setStep] = useState<Step>('recovery');
  const { title, description } = WELCOME_COPY.heading[step];
  return (
    <AuthScreen title={title} description={description}>
      <View className="gap-6">
        <Text className="text-sm text-muted-foreground">
          Step {STEPS.indexOf(step) + 1} of {STEPS.length}
        </Text>
        {step === 'recovery' ? (
          <RecoveryStep welcome={welcome} onDone={() => setStep('check')} />
        ) : step === 'check' ? (
          <CheckStep welcome={welcome} onDone={() => setStep('start')} />
        ) : (
          <StartStep onImport={onImport} />
        )}
      </View>
    </AuthScreen>
  );
}

function Done({ children }: { children: string }) {
  return (
    <View className="flex-row items-start gap-2">
      <FirstLineSlot textClassName="text-sm">
        <Icon as={CircleCheck} className="size-4 text-primary" />
      </FirstLineSlot>
      <Text className="min-w-0 flex-1 text-sm">{children}</Text>
    </View>
  );
}

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
      queryClient.setQueryData([...hasRecoveryDoorQueryKey, welcome.username], true);
      void queryClient.invalidateQueries({ queryKey: hasRecoveryDoorQueryKey });
    } catch {
      setError(WELCOME_COPY.recoveryFailed);
    }
  };

  if (code) {
    return (
      <View className="gap-4">
        <Done>{WELCOME_COPY.recoveryReady}</Done>
        <ShowOnceSecret
          testID="welcome-recovery-code"
          secret={code}
          label={RECOVERY_CODE_COPY.secretLabel}
        />
        <Button testID="welcome-recovery-continue" onPress={onDone}>
          <Text>{WELCOME_COPY.continue}</Text>
        </Button>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <Button
        testID="welcome-create-recovery"
        disabled={recovery.isPending}
        onPress={() => void create()}
      >
        <Text>
          {recovery.isPending ? WELCOME_COPY.creatingRecovery : WELCOME_COPY.createRecovery}
        </Text>
      </Button>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button
        testID="welcome-skip-recovery"
        variant="ghost"
        disabled={recovery.isPending}
        onPress={onDone}
      >
        <Text className="text-muted-foreground">{WELCOME_COPY.skipRecovery}</Text>
      </Button>
    </View>
  );
}

function CheckStep({ welcome, onDone }: { welcome: Welcome; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [checkError, setCheckError] = useState<'empty' | 'mismatch' | null>(null);
  const [passed, setPassed] = useState(false);
  const [shown, setShown] = useState(false);

  const check = () => {
    if (canonicalizePassword(value) === '') setCheckError('empty');
    else if (canonicalizePassword(value) !== canonicalizePassword(welcome.password))
      setCheckError('mismatch');
    else setPassed(true);
  };

  if (passed) {
    return (
      <View className="gap-4">
        <View role="status">
          <Done>{WELCOME_COPY.passed}</Done>
        </View>
        <Button testID="welcome-check-continue" onPress={onDone}>
          <Text>{WELCOME_COPY.continue}</Text>
        </Button>
      </View>
    );
  }

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-sm">Username</Text>
        {/* `editable={false}` as the expired-session sign-in does it: readable and
            focusable, and whose password this is, for a person and for a manager. */}
        <Input
          aria-label="Username"
          autoComplete="username"
          textContentType="username"
          editable={false}
          value={welcome.username}
        />
      </View>
      <View className="gap-2">
        <Text className="text-sm">Password</Text>
        {/* Focused on arrival: it swaps in on a press, on a screen already here
            (docs/soft-keyboard.md, _arrival_). */}
        <PasswordInput
          testID="welcome-check-password"
          aria-label="Password"
          autoComplete="current-password"
          autoFocus
          returnKeyType="go"
          onSubmitEditing={check}
          className={cn(checkError && 'border-destructive')}
          value={value}
          onChangeText={(text) => {
            setValue(text);
            if (checkError) setCheckError(null);
          }}
        />
        {checkError ? (
          <ErrorText testID="welcome-check-error">{WELCOME_COPY[checkError]}</ErrorText>
        ) : null}
      </View>
      <View className="gap-2">
        <Button testID="welcome-check-submit" onPress={check}>
          <Text>{WELCOME_COPY.signIn}</Text>
        </Button>
        <Pressable
          testID="welcome-show-password"
          role="button"
          aria-expanded={shown}
          onPress={() => setShown((s) => !s)}
          className="items-center py-1"
        >
          <Text className="text-center text-sm text-muted-foreground underline">
            {WELCOME_COPY.showPassword}
          </Text>
        </Pressable>
        {shown ? (
          <View
            aria-label={CREATE_ACCOUNT_COPY.shownPasswordLabel}
            className="rounded-lg border border-border bg-muted/40 px-3 py-2.5"
          >
            <Text testID="welcome-shown-password" selectable className="font-mono text-sm">
              {welcome.password}
            </Text>
          </View>
        ) : null}
        <Button testID="welcome-skip-check" variant="ghost" onPress={onDone}>
          <Text className="text-muted-foreground">{WELCOME_COPY.skipCheck}</Text>
        </Button>
      </View>
    </View>
  );
}

function StartStep({ onImport }: { onImport: () => void }) {
  return (
    <View className="gap-2">
      <Button testID="welcome-import" onPress={onImport}>
        <Text>{WELCOME_COPY.importBookmarks}</Text>
      </Button>
      <Button testID="welcome-start" variant="outline" onPress={endWelcome}>
        <Text>{WELCOME_COPY.startEmpty}</Text>
      </Button>
    </View>
  );
}
