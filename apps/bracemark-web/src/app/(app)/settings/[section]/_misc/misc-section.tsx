'use client';

// The Misc settings section: what's left once Appearance took the theme, the link
// layout and the sort (_appearance/appearance-section.tsx) — today, the APP LOCK.
// Inherently device-only (locks never sync; wiped on sign-out — see LockRecord in
// web-react's db.ts), so no Sync/Device tabs: just set/remove, both through
// LockPasswordDialog. The lock itself is enforced by AppLockGate in the (app) layout.

import { useState } from 'react';

import { useEntitlements, useLockMutations, useLocks } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';

import { SettingsGroup, SettingsHeader, SettingsPane } from '../../_components/settings-kit';

import { LockPasswordDialog } from '@/components/lock-password-dialog';
import { usePaywall } from '@/contexts/paywall-provider';

export function MiscSection() {
  const { appLock } = useLocks();
  const { setAppLock, removeAppLock } = useLockMutations();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const [lockDialog, setLockDialog] = useState<'set' | 'remove' | null>(null);

  return (
    <SettingsPane>
      <SettingsHeader title="Misc." description="General preferences for the app." />

      <SettingsGroup
        title="App lock"
        description="Lock the whole app with a password on this device only — it engages every time the app loads. If you forget the password, sign out and sign back in with your account password; signing out removes all locks on this device."
      >
        <div>
          {appLock.exists ? (
            // Remove stays open even for a free (downgraded) account, so an
            // existing lock is never stranded — mirrors list unlock/remove.
            <Button variant="outline" onClick={() => setLockDialog('remove')}>
              Remove app lock…
            </Button>
          ) : (
            // Setting a new lock is the `locks` Plus lever — gate at the button,
            // before any password dialog (nothing sensitive is typed then thrown).
            <Button
              variant="outline"
              onClick={() => (entitlements.locks ? setLockDialog('set') : paywall.show('locks'))}
            >
              Set app lock…
            </Button>
          )}
        </div>
      </SettingsGroup>

      {lockDialog === 'set' && (
        <LockPasswordDialog
          mode="create"
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Set app lock"
          description="Create a password to lock this app on this device. It takes effect the next time the app loads."
          submitLabel="Set lock"
          onSubmit={async (password) => {
            await setAppLock(password);
          }}
        />
      )}
      {lockDialog === 'remove' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Remove app lock"
          description="Enter your app lock password to remove it."
          submitLabel="Remove"
          onSubmit={async (password) => {
            if (!(await removeAppLock(password))) {
              throw new Error('Password isn’t correct. Please try again.');
            }
          }}
        />
      )}
    </SettingsPane>
  );
}
