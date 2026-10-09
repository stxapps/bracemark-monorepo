// The one password dialog behind every lock EDIT — the expo port of
// bracemark-web's components/lock-password-dialog.tsx (the canonical doc): set/
// remove the app lock (Settings → Misc) and lock/unlock/remove-lock on a list
// (Settings → Lists). The UNLOCK surfaces users hit while browsing are the
// in-place LockPane, not this dialog. Callers mount it conditionally, so state
// resets by construction on every open.
//
// The contract: `onSubmit` resolves → the dialog closes; it throws → the
// message shows inline and the field stays for a retry (callers map a failed
// verify to "Password is not correct…").

import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { lockPasswordSchema } from '@stxapps/shared';

import { PasswordInput } from '../features/auth/password-input';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Text } from './ui/text';
import { ErrorText } from './error-text';

export function LockPasswordDialog({
  onOpenChange,
  title,
  description,
  submitLabel,
  checkboxLabel,
  mode = 'verify',
  onSubmit,
}: {
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  // Present only on "Lock list" — the "Hide this list while locked" opt-in.
  checkboxLabel?: string;
  // What the submitted password is FOR: a new one being set ('create' — Set app
  // lock, Lock list) or an existing one being checked ('verify', the default —
  // unlock and remove). Only 'create' holds its fields still while it saves.
  mode?: 'create' | 'verify';
  onSubmit: (password: string, checked: boolean) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  // What the field holds now — see lock-pane.tsx, `latestPassword`.
  const latestPassword = useRef('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new password is a commitment: what was submitted is what gets saved, so
  // the field and the hide option hold still until the write settles. A password
  // being verified stays editable — a refused one is retyped in place.
  const frozen = mode === 'create' && busy;

  const submit = async () => {
    if (busy) return;

    const parsed = lockPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid password');
      return;
    }

    const submitted = password;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed.data, checked);
      onOpenChange(false);
    } catch (err) {
      if (latestPassword.current === submitted) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* 24 / 16 / 8, one scale down from DialogContent's own gap: 16 between the
            form's blocks, 8 inside the field. Every message this dialog can show is
            about the PASSWORD — the schema's, and the callers' "Password is not
            correct…" — so the error sits in the field's column, under the input it
            describes, not as a third block between the checkbox and the buttons
            where it took a full 16 on each side. */}
        <View className="gap-4">
          <View className="gap-2">
            <PasswordInput
              testID="lock-dialog-password"
              autoFocus
              placeholder="Password"
              aria-label="Password"
              value={password}
              // Non-editable ONLY while frozen: on native that also drops the
              // keyboard, which a refused password being verified must keep for
              // the retry (docs/soft-keyboard.md, _a submit drops it_).
              editable={!frozen}
              onChangeText={(text) => {
                // Not a repeat of `editable`: that lands natively a moment after
                // the state does, and a keystroke already on its way still
                // arrives here.
                if (frozen) return;
                latestPassword.current = text;
                setPassword(text);
                if (error) setError(null);
              }}
              onSubmitEditing={() => void submit()}
            />
            {error && <ErrorText testID="lock-dialog-error">{error}</ErrorText>}
          </View>

          {checkboxLabel && (
            <Pressable
              testID="lock-dialog-checkbox"
              role="checkbox"
              aria-checked={checked}
              disabled={frozen}
              aria-disabled={frozen}
              className="flex-row items-center gap-2"
              onPress={() => setChecked((v) => !v)}
            >
              {/* Disabled on its own account: the box is a pressable inside the
                  row's, with its own hit slop, and the row's `disabled` does not
                  reach it. */}
              <Checkbox
                checked={checked}
                disabled={frozen}
                onCheckedChange={(v) => setChecked(v === true)}
              />
              <Text className="min-w-0 flex-1 text-sm">{checkboxLabel}</Text>
            </Pressable>
          )}

          <DialogFooter>
            <Button variant="outline" onPress={() => onOpenChange(false)}>
              <Text>Cancel</Text>
            </Button>
            <Button testID="lock-dialog-submit" onPress={() => void submit()} disabled={busy}>
              <Text>{busy ? `${submitLabel}…` : submitLabel}</Text>
            </Button>
          </DialogFooter>
        </View>
      </DialogContent>
    </Dialog>
  );
}
