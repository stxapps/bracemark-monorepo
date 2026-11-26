// The Misc settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_misc/misc-section.tsx`: what's left once Appearance
// took the theme, the link layout and the sort (appearance-section.tsx) — today,
// the APP LOCK, inherently device-only: no tabs, just set/remove through
// LockPasswordDialog, enforced by AppLockGate in the (app) layout. Plus expo's
// biometric fast-path for it.

import { useState } from 'react';
import { View } from 'react-native';

import { useEntitlements, useLockMutations, useLocks } from '@stxapps/expo-react';

import { LockPasswordDialog } from '../../components/lock-password-dialog';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { SettingsGroup, SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';

export function MiscSection() {
  const { appLock, biometricAvailable, biometricLabel } = useLocks();
  const { setAppLock, removeAppLock, setAppBiometric } = useLockMutations();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const [lockDialog, setLockDialog] = useState<'set' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Surface a failed write rather than swallowing it; the controls stay live for a
  // retry.
  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <SettingsPane>
      <SettingsHeader title="Misc." description="General preferences for the app." />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <SettingsGroup
        title="App lock"
        description="Lock the whole app with a password on this device only — it engages every time the app loads. If you forget the password, sign out and sign back in with your account password; signing out removes all locks on this device."
      >
        <View className="flex-row">
          {appLock.exists ? (
            // Remove stays open even for a free (downgraded) account, so an
            // existing lock is never stranded — mirrors list unlock/remove.
            <Button
              variant="outline"
              testID="app-lock-remove"
              onPress={() => setLockDialog('remove')}
            >
              <Text>Remove app lock…</Text>
            </Button>
          ) : (
            // Setting a new lock is the `locks` Plus lever — gate at the button,
            // before any password dialog (nothing sensitive is typed then thrown).
            <Button
              variant="outline"
              testID="app-lock-set"
              onPress={() => (entitlements.locks ? setLockDialog('set') : paywall.show('locks'))}
            >
              <Text>Set app lock…</Text>
            </Button>
          )}
        </View>

        {/* Biometric fast-path — only with an app lock set AND biometry enrolled
            on this device. The password stays the root credential and the
            fallback; this just opts the app lock into Face ID / Touch ID. The
            Switch reflects the persisted flag, so a cancelled enable (the OS
            confirm) leaves it off. */}
        {appLock.exists && biometricAvailable && (
          <View className="flex-row items-center justify-between gap-4">
            <View className="min-w-0 flex-1">
              <Text className="font-medium">Unlock with {biometricLabel}</Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                Use {biometricLabel} instead of typing the password. The password still works as a
                fallback.
              </Text>
            </View>
            <Switch value={appLock.biometric} onValueChange={(v) => run(setAppBiometric(v))} />
          </View>
        )}
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
