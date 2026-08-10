// The unlock surface shared by the two lock gates — the expo port of
// bracemark-web's components/lock-pane.tsx (the canonical doc): AppLockGate renders
// it full-screen, the links screen's list-lock pane renders it inside the main
// pane. One password field, inline wrong-password error, and the recovery
// escape hatch — locks are device-local, so "forgot the password" is always
// solvable by signing out (which wipes every lock) and signing back in with the
// account password.

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Lock, ScanFace } from 'lucide-react-native';

import { useSignOut } from '@stxapps/expo-react';

import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

export function LockPane({
  title,
  description,
  onUnlock,
  className,
  biometric,
}: {
  title: string;
  description: string;
  // Resolves false on a wrong password (the pane shows the inline error);
  // anything else it may throw surfaces as the generic failure message.
  onUnlock: (password: string) => Promise<boolean>;
  // Sizing comes from the caller: flex-1 for the app gate, in-pane otherwise.
  className?: string;
  // The biometric fast-path, present only when the gating lock has opted in AND
  // the device supports it (the caller decides). `onUnlock` runs the OS prompt
  // and resolves true when it opened the lock — the gate then unmounts. The
  // password field below is always the fallback (docs/locks.md).
  biometric?: { label: string; onUnlock: () => Promise<boolean> };
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signOut = useSignOut();

  const submit = async () => {
    if (busy) return;
    if (password === '') {
      setError('Please enter a password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(password);
      if (ok) setPassword('');
      else setError('Password is not correct. Please try again.');
    } catch {
      setError('Could not unlock. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // Biometric fast-path. On success the gate unmounts, so we leave `busy` set;
  // on cancel/failure we release it and fall through to the password field —
  // never an error, never a loop.
  const tryBiometric = async () => {
    if (busy || !biometric) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await biometric.onUnlock())) setBusy(false);
    } catch {
      setBusy(false);
    }
  };

  // Auto-prompt ONCE when biometric is offered (open the gate → prompt at once).
  // The ref makes it strictly once-on-offer even though `biometric` is a fresh
  // object each render, so a cancel doesn't immediately re-prompt.
  const autoPrompted = useRef(false);
  useEffect(() => {
    if (!biometric || autoPrompted.current) return;
    autoPrompted.current = true;
    void tryBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biometric]);

  return (
    <View className={cn('items-center justify-center gap-4 px-6 py-8', className)}>
      <View className="size-12 items-center justify-center rounded-full bg-muted">
        <Icon as={Lock} className="size-5 text-muted-foreground" />
      </View>
      <View className="items-center">
        <Text role="heading" className="text-lg font-semibold">
          {title}
        </Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">{description}</Text>
      </View>

      <View className="w-full max-w-xs gap-3">
        {biometric && (
          <Button variant="outline" onPress={() => void tryBiometric()} disabled={busy}>
            <Icon as={ScanFace} className="size-4" />
            <Text>{`Unlock with ${biometric.label}`}</Text>
          </Button>
        )}
        <Input
          secureTextEntry
          autoFocus={!biometric}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Password"
          aria-label="Password"
          value={password}
          editable={!busy}
          onChangeText={(text) => {
            setPassword(text);
            if (error) setError(null);
          }}
          onSubmitEditing={() => void submit()}
        />
        {error && <Text className="text-sm text-destructive">{error}</Text>}
        <Button onPress={() => void submit()} disabled={busy}>
          <Text>{busy ? 'Unlocking…' : 'Unlock'}</Text>
        </Button>
      </View>

      <View className="max-w-xs">
        <Text className="text-center text-xs text-muted-foreground">
          Forgot the password? You can{' '}
          <Text
            className="text-xs text-muted-foreground underline"
            onPress={() => !signOut.isPending && signOut.mutate()}
          >
            sign out
          </Text>{' '}
          and sign back in — signing out removes all locks on this device.
        </Text>
      </View>
    </View>
  );
}
