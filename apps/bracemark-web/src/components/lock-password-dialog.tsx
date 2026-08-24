'use client';

// The one password dialog behind every lock EDIT — set/remove the app lock
// (Settings → Misc) and lock/unlock/remove-lock on a list (Settings → Lists).
// The UNLOCK surfaces users hit while browsing are the in-place LockPane, not
// this dialog. Callers mount it conditionally (the LinkDestroyConfirm pattern),
// so state resets by construction on every open.
//
// The contract: `onSubmit` resolves → the dialog closes; it throws → the
// message shows inline and the field stays for a retry (callers map a failed
// verify to "Password is not correct…").

import { useState } from 'react';

import { lockPasswordSchema } from '@stxapps/shared';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';
import { Label } from '@stxapps/web-ui/components/ui/label';

interface LockPasswordDialogProps {
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  // Present only on "Lock list" — the "Hide this list while locked" opt-in.
  checkboxLabel?: string;
  onSubmit: (password: string, checked: boolean) => Promise<void>;
}

export function LockPasswordDialog({
  onOpenChange,
  title,
  description,
  submitLabel,
  checkboxLabel,
  onSubmit,
}: LockPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.SubmitEvent) => {
    e.preventDefault();
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
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* 24 / 16 / 8, one scale down from DialogContent's own gap: 16 between
            the form's blocks, 8 inside the field. Every message this dialog can
            show is about the PASSWORD — the schema's, and the callers' "Password
            is not correct…" — so the error sits in the field's column, under the
            input it describes, not as a third block between the checkbox and the
            buttons where it took a full 16 on each side. */}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <PasswordInput
              autoFocus
              autoComplete="off"
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>

          {checkboxLabel && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="lock-dialog-checkbox"
                checked={checked}
                onCheckedChange={(v) => setChecked(v === true)}
              />
              <Label htmlFor="lock-dialog-checkbox">{checkboxLabel}</Label>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? `${submitLabel}…` : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
