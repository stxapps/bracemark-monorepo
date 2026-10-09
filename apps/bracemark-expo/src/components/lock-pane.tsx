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

import { LOCK_COPY } from '@stxapps/react';

import { useSignOutFlow } from '../contexts/sign-out-provider';
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
  solicit = true,
  testID,
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
  // Whether the pane may ASK for the unlock as it goes up — the autofocus that
  // raises the keyboard, and the biometric auto-prompt. Both are right for
  // someone arriving at a lock, and wrong for someone who has just engaged it by
  // hand: "Lock now" on the list being shown raised a keyboard under the open
  // drawer, typing into a field nobody could see, and with Face ID enabled the
  // prompt that followed could open the lock the press had just closed. The
  // host decides (it knows how the pane got here); `false` leaves the field, the
  // biometric button and everything else exactly as they are, one tap away.
  // Read ONCE, at mount — see `solicited` below. docs/locks.md, _a hand relock
  // does not ask to be undone_.
  solicit?: boolean;
  // The pane's root marker for the mobile flows. Each host passes its own
  // (`app-lock-pane`, `list-lock-pane`): which gate is up is the assertion.
  testID?: string;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { requestSignOut } = useSignOutFlow();
  // Latched: asking is something the pane does on the way up or not at all. The
  // host's answer can change under a pane that is still up (the auto-relock
  // clears a by-hand mark), and a pane that started quiet must not summon a
  // keyboard or a Face ID sheet later, unprompted.
  const [solicited] = useState(solicit);

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
  // object each render, so a cancel doesn't immediately re-prompt. A pane that
  // may not solicit spends its one offer without prompting — the button below
  // is still there.
  const autoPrompted = useRef(false);
  useEffect(() => {
    if (!biometric || autoPrompted.current) return;
    autoPrompted.current = true;
    if (solicited) void tryBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biometric]);

  // A scroller, not the plain centred View this used to be, and it belongs HERE
  // rather than in either gate — both hosts (AppLockGate full-screen, the links
  // screen's list-lock pane) had the same bug, and a fix typed into two places
  // drifts into two behaviours.
  //
  // The bug: the password field is `autoFocus` when there's no biometric (and
  // the pane may solicit), so the keyboard is up on mount — and with nothing keyboard-aware above it, the
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
      testID={testID}
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
        <Text role="heading" className="text-center text-lg font-semibold">
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
            testID="lock-pane-password"
            autoFocus={solicited && !biometric}
            placeholder={LOCK_COPY.passwordLabel}
            aria-label={LOCK_COPY.passwordLabel}
            value={password}
            // NO `editable={!busy}`, which this field carried and its web twin
            // never did. On native that prop is a keyboard dismissal as much as
            // a guard: a focused field that goes non-editable loses its focus,
            // nothing gives it back when `busy` clears, and a wrong password
            // then cost a tap back into the field to retype. Re-entry is guarded
            // where it belongs — `submit` returns while `busy`, and the button
            // is disabled. docs/soft-keyboard.md, _a submit drops it_.
            onChangeText={(text) => {
              setPassword(text);
              if (error) setError(null);
            }}
            onSubmitEditing={() => void submit()}
          />
          {error && <ErrorText testID="lock-pane-error">{error}</ErrorText>}
        </View>
        <Button testID="lock-pane-unlock" onPress={() => void submit()} disabled={busy}>
          <Text>{busy ? LOCK_COPY.unlocking : LOCK_COPY.unlock}</Text>
        </Button>
      </View>

      <View className="max-w-xs">
        <Text className="text-center text-xs text-muted-foreground">
          {LOCK_COPY.forgot.before}{' '}
          <Text className="text-xs text-muted-foreground underline" onPress={requestSignOut}>
            {LOCK_COPY.forgot.action}
          </Text>{' '}
          {LOCK_COPY.forgot.after}
        </Text>
      </View>
    </StyledKeyboardAwareScrollView>
  );
}
