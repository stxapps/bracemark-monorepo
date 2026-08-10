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

import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { lockPasswordSchema } from '@stxapps/shared';

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
import { Input } from './ui/input';
import { Text } from './ui/text';

export function LockPasswordDialog({
  onOpenChange,
  title,
  description,
  submitLabel,
  checkboxLabel,
  onSubmit,
}: {
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  // Present only on "Lock list" — the "Hide this list while locked" opt-in.
  checkboxLabel?: string;
  onSubmit: (password: string, checked: boolean) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;

    const parsed = lockPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid password');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed.data, checked);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

        <View className="gap-4">
          <Input
            secureTextEntry
            autoFocus
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

          {checkboxLabel && (
            <Pressable
              className="flex-row items-center gap-2"
              onPress={() => setChecked((v) => !v)}
            >
              <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
              <Text className="min-w-0 flex-1 text-sm">{checkboxLabel}</Text>
            </Pressable>
          )}

          {error && <Text className="text-sm text-destructive">{error}</Text>}

          <DialogFooter>
            <Button variant="outline" onPress={() => onOpenChange(false)}>
              <Text>Cancel</Text>
            </Button>
            <Button onPress={() => void submit()} disabled={busy}>
              <Text>{busy ? `${submitLabel}…` : submitLabel}</Text>
            </Button>
          </DialogFooter>
        </View>
      </DialogContent>
    </Dialog>
  );
}
