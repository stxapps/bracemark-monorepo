// The unlock surface shared by the two lock gates — the expo port of
// bracemark-web's components/lock-pane.tsx (the canonical doc): AppLockGate renders
// it full-screen, the links screen's list-lock pane renders it inside the main
// pane. One password field, inline wrong-password error, and the recovery
// escape hatch — locks are device-local, so "forgot the password" is always
// solvable by signing out (which wipes every lock) and signing back in with the
// account password.

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Lock, ScanFace } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { useSignOut } from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';

import { PasswordInput } from '../features/auth/password-input';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import { ErrorText } from './error-text';

// A composite, not a core host, so Uniwind's HOC is what lets it take
// `className` — and map `contentContainerClassName` onto `contentContainerStyle`
// (auth-screen.tsx carries the canonical note).
const StyledKeyboardAwareScrollView = withUniwind(KeyboardAwareScrollView);

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
      setError(LOCK_COPY.errors.empty);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(password);
      if (ok) setPassword('');
      else setError(LOCK_COPY.errors.wrong);
    } catch {
      setError(LOCK_COPY.errors.failed);
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

  // A scroller, not the plain centred View this used to be, and it belongs HERE
  // rather than in either gate — both hosts (AppLockGate full-screen, the links
  // screen's list-lock pane) had the same bug, and a fix typed into two places
  // drifts into two behaviours.
  //
  // The bug: the password field is `autoFocus` when there's no biometric, so
  // the keyboard is up on mount — and with nothing keyboard-aware above it, the
  // pane stayed centred in the WHOLE window while the keyboard covered its
  // bottom third. What sits in that third is the Unlock button and the "forgot
  // the password" escape hatch, i.e. both ways forward. docs/safe-area.md's
  // table already asked for this ("regular expo-router screen →
  // KeyboardAwareScrollView in the screen wrapper"); these two were the miss.
  //
  // `grow justify-center` is auth-screen.tsx's pattern verbatim: centred while
  // the content fits, scrollable the moment it doesn't — which is the keyboard
  // being up, or a large font scale, or both. `className` still comes from the
  // caller (both pass `flex-1`) so the scroller fills whatever box it's given.
  //
  // The keyboard pair completes the exit. Return already blurred (the field is
  // single-line, so RN resolves `submitBehavior` to `'blurAndSubmit'`) but it
  // was the ONLY way out; now a tap on the pane's own padding drops the
  // keyboard, and so does dragging the pane.
  return (
    <StyledKeyboardAwareScrollView
      className={className}
      contentContainerClassName="grow items-center justify-center gap-4 px-6 py-8"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      bottomOffset={16}
    >
      <View className="size-12 items-center justify-center rounded-full bg-muted">
        <Icon as={Lock} className="size-5 text-muted-foreground" />
      </View>
      <View className="items-center">
        <Text role="heading" className="text-lg font-semibold">
          {title}
        </Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">{description}</Text>
      </View>

      {/* One 8/16 scale, matching the web twin: 16 between blocks — the pane's own
          gap, which this column matches so neither button is held tighter than
          everything else — and 8 INSIDE the field, where the error belongs to the
          input rather than standing as a block of its own. */}
      <View className="w-full max-w-xs gap-4">
        {biometric && (
          <Button variant="outline" onPress={() => void tryBiometric()} disabled={busy}>
            <Icon as={ScanFace} className="size-4" />
            <Text>{`Unlock with ${biometric.label}`}</Text>
          </Button>
        )}
        <View className="gap-2">
          <PasswordInput
            autoFocus={!biometric}
            placeholder={LOCK_COPY.passwordLabel}
            aria-label={LOCK_COPY.passwordLabel}
            value={password}
            editable={!busy}
            onChangeText={(text) => {
              setPassword(text);
              if (error) setError(null);
            }}
            onSubmitEditing={() => void submit()}
          />
          {error && <ErrorText>{error}</ErrorText>}
        </View>
        <Button onPress={() => void submit()} disabled={busy}>
          <Text>{busy ? LOCK_COPY.unlocking : LOCK_COPY.unlock}</Text>
        </Button>
      </View>

      <View className="max-w-xs">
        <Text className="text-center text-xs text-muted-foreground">
          {LOCK_COPY.forgot.before}{' '}
          <Text
            className="text-xs text-muted-foreground underline"
            onPress={() => !signOut.isPending && signOut.mutate()}
          >
            {LOCK_COPY.forgot.action}
          </Text>{' '}
          {LOCK_COPY.forgot.after}
        </Text>
      </View>
    </StyledKeyboardAwareScrollView>
  );
}
