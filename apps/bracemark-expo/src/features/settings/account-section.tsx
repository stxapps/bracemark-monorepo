// The Account settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_account/account-section.tsx` (the canonical doc:
// the overview-plus-sub-views shape, why Delete account demands a fresh
// password even with a live session, why sign-out is NOT duplicated here — the
// links ⋯ menu owns it on this platform). Sub-views are in-section VIEW STATE
// (a local `view` swap), not routes, exactly like web.

import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  CircleAlert,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserX,
} from 'lucide-react-native';

import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  SubscriptionActiveError,
  useAuth,
  useChangePassword,
  useDeleteAccount,
  useEntitlements,
  useHasRecoveryDoor,
  useRecoveryCode,
} from '@stxapps/expo-react';
import { hasRecoveryDoorQueryKey, useSignOutOthers } from '@stxapps/react';
import {
  canonicalizePassword,
  generatePassphrase,
  NEW_PASSWORD_MIN_LENGTH,
  newPasswordSchema,
  PASSWORD_MIN_GUESSES_LOG10,
} from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { PasswordInput } from '../auth/password-input';
import { PasswordStrengthMeter, usePasswordStrength } from '../auth/password-strength';
import { ShowOnceSecret } from '../auth/show-once-secret';
import { SettingsHeader, SettingsNotice, SettingsPane, SettingsRow } from './settings-kit';

type AccountView = 'overview' | 'change-password' | 'recovery' | 'sign-out-others' | 'delete';

function DeleteAccountView({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const { subscription } = useEntitlements();
  const { mutate, isPending, error, reset } = useDeleteAccount();
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // Reveal the "tick the box first" nudge only after a submit without the box.
  const [nudge, setNudge] = useState(false);

  // The same rule the server enforces with its 409: a subscription that would
  // keep billing (renewing, or in dunning) must be canceled first. Pre-warning
  // from the cached entitlements read spares the user typing their password
  // into a call that's going to be refused — but the SERVER check is the gate.
  const subscriptionBlocks = subscription.status === 'grace' || subscription.willRenew;

  const onSubmit = () => {
    if (isPending) return;
    if (!confirmed) {
      setNudge(true);
      return;
    }
    setNudge(false);
    mutate({ password });
  };

  const errorText =
    error == null
      ? null
      : error instanceof SubscriptionActiveError
        ? 'Your subscription is still active. Cancel it first, then come back — your data stays put until you do.'
        : error instanceof InvalidCredentialsError
          ? 'Incorrect password.'
          : `Something went wrong: ${error.message} Nothing was deleted — please try again.`;

  return (
    <View>
      <SettingsHeader
        title="Delete account"
        description="Permanently delete your account and everything in it: all your data on all your devices, your account keys, and every signed-in session."
        back={{ label: 'Account', onPress: onBack }}
      />
      <Text className="mt-3 text-sm text-muted-foreground">
        Your username stays reserved and can&apos;t be registered again — by you or anyone else. If
        you have a canceled subscription with paid time remaining, that time is forfeited. Consider
        exporting your data first (Settings → Data).
      </Text>
      <Text className="mt-3 text-sm font-medium text-destructive">
        This action cannot be undone. There is no grace period and no recovery.
      </Text>

      {subscriptionBlocks && (
        <SettingsNotice
          className="mt-4"
          icon={<Icon as={CircleAlert} className="size-4 text-muted-foreground" />}
        >
          <Text className="text-sm text-muted-foreground">
            You have an active subscription. Cancel it in{' '}
            <Text
              className="text-sm text-muted-foreground underline"
              onPress={() => router.push('/settings/subscription')}
            >
              Subscription settings
            </Text>{' '}
            first — deleting the account doesn&apos;t stop the billing.
          </Text>
        </SettingsNotice>
      )}

      {/* Fresh proof, not just the session: the server only accepts this call
          signed by the password-derived key, so the password is required here
          even though you're signed in. */}
      <View className="mt-6 max-w-sm gap-2">
        <Text className="text-sm font-medium">Confirm your password</Text>
        <Input
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          value={password}
          editable={!isPending}
          onChangeText={(text) => {
            setPassword(text);
            if (error) reset();
          }}
        />
      </View>

      <Pressable
        className="mt-4 flex-row items-start gap-3 rounded-lg border border-border p-3"
        onPress={() => {
          if (isPending) return;
          setConfirmed((v) => !v);
          setNudge(false);
        }}
      >
        <Checkbox
          checked={confirmed}
          disabled={isPending}
          onCheckedChange={(v) => {
            setConfirmed(v === true);
            setNudge(false);
          }}
          className="mt-0.5"
        />
        <Text className="min-w-0 flex-1 text-sm">
          Yes, I understand my account and all my data will be permanently deleted, with no way
          back.
        </Text>
      </Pressable>

      {nudge && (
        <Text className="mt-2 text-sm text-destructive">Please tick the box above to confirm.</Text>
      )}

      <View className="mt-6 flex-row">
        <Button
          variant="destructive"
          disabled={isPending || password.length === 0 || subscriptionBlocks}
          onPress={onSubmit}
        >
          <Icon as={Trash2} className="size-4" />
          <Text>{isPending ? 'Deleting account…' : 'Delete account forever'}</Text>
        </Button>
      </View>

      {errorText && (
        <SettingsNotice
          tone="error"
          className="mt-3"
          icon={<Icon as={CircleAlert} className="size-4 text-destructive" />}
        >
          {errorText}
        </SettingsNotice>
      )}
    </View>
  );
}

// Change the password door. Prove an existing door — the current password (usual)
// or the recovery code ("I forgot it") — then set a new password gated by the same
// zxcvbn floor as create-account. A tier-1 rotation: the DEK/keys/data and the
// session are all unchanged, so there's nothing to re-sign-in.
function ChangePasswordView({ onBack }: { onBack: () => void }) {
  const changePassword = useChangePassword();
  const [useRecovery, setUseRecovery] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [mode, setMode] = useState<'generated' | 'own'>('generated');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseSaved, setPassphraseSaved] = useState(false);
  const [ownPassword, setOwnPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // A generated passphrase is the safe default here too (docs/account.md); the
  // typed path is the escape hatch gated by the same zxcvbn floor as
  // create-account. Generate on mount so the field is populated at open.
  useEffect(() => {
    setPassphrase(generatePassphrase());
  }, []);

  const newPassword = mode === 'generated' ? passphrase : ownPassword;

  // Strength only matters on the typed path — score the CANONICAL form (the
  // exact string the new KEK derives from); see web for the full rationale.
  const { guessesLog10, displayScore } = usePasswordStrength(
    mode === 'own' ? canonicalizePassword(ownPassword) : '',
    [],
    NEW_PASSWORD_MIN_LENGTH,
  );
  const ownPasswordParse = newPasswordSchema.safeParse(ownPassword);
  // Gate on the raw guess estimate; null = estimator still loading — stay closed.
  const newOk =
    mode === 'generated'
      ? passphrase !== '' && passphraseSaved
      : ownPasswordParse.success &&
        guessesLog10 !== null &&
        guessesLog10 >= PASSWORD_MIN_GUESSES_LOG10;

  // Only once they've typed something. Length first (the schema owns its own
  // message), then the entropy floor — web's ordering, verbatim.
  const ownPasswordError =
    ownPassword === ''
      ? null
      : !ownPasswordParse.success
        ? (ownPasswordParse.error?.issues[0]?.message ?? 'Invalid password')
        : guessesLog10 !== null && guessesLog10 < PASSWORD_MIN_GUESSES_LOG10
          ? 'Too predictable — add a few more words, or generate a password instead.'
          : null;
  const proofReady = useRecovery ? recoveryCode !== '' : currentPassword !== '';

  const regeneratePassphrase = () => {
    setPassphrase(generatePassphrase());
    setPassphraseSaved(false);
  };

  const onSubmit = async () => {
    if (changePassword.isPending || !newOk || !proofReady) return;
    setError(null);
    try {
      await changePassword.mutateAsync({
        newPassword,
        proof: useRecovery
          ? { kind: 'recovery', recoveryCode }
          : { kind: 'password', currentPassword },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) setError('Incorrect password.');
      else if (err instanceof InvalidRecoveryCodeError) setError('That recovery code didn’t work.');
      else setError('Could not change your password. Please try again.');
    }
  };

  if (done) {
    return (
      <View>
        <SettingsHeader title="Change password" back={{ label: 'Account', onPress: onBack }} />
        <View className="mt-3 flex-row items-start gap-2">
          <Icon as={ShieldCheck} className="mt-0.5 size-4 shrink-0 text-primary" />
          <Text className="min-w-0 flex-1 text-sm">
            Your password has been changed. You&apos;re still signed in on this device, and your
            other devices have been signed out.
          </Text>
        </View>
        <Text className="mt-4 text-xs text-muted-foreground">
          This changed how you sign in, but didn&apos;t re-encrypt data you&apos;ve already synced.
          If your old password may have been compromised, a password change alone won&apos;t protect
          data an attacker could already have copied — export your data (Settings → Data on the web
          app), delete this account, and create a new one.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <SettingsHeader
        title="Change password"
        description="You'll need your current password. There is no email reset, so keep the new one safe."
        back={{ label: 'Account', onPress: onBack }}
      />

      <View className="mt-6 max-w-sm gap-4">
        {useRecovery ? (
          <View className="gap-2">
            <Text className="text-sm font-medium">Recovery code</Text>
            <Input
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              className="font-mono"
              value={recoveryCode}
              editable={!changePassword.isPending}
              onChangeText={(text) => {
                setRecoveryCode(text);
                if (error) setError(null);
              }}
            />
          </View>
        ) : (
          <View className="gap-2">
            <Text className="text-sm font-medium">Current password</Text>
            <PasswordInput
              autoComplete="current-password"
              value={currentPassword}
              editable={!changePassword.isPending}
              onChangeText={(text) => {
                setCurrentPassword(text);
                if (error) setError(null);
              }}
            />
          </View>
        )}
        <Pressable
          onPress={() => {
            setUseRecovery((v) => !v);
            setError(null);
          }}
          className="-mt-2 self-start"
        >
          <Text className="text-sm text-muted-foreground underline">
            {useRecovery ? 'Use my current password instead' : 'I forgot it — use my recovery code'}
          </Text>
        </Pressable>

        {mode === 'generated' ? (
          <View className="gap-2">
            <Text className="text-sm font-medium">New password</Text>
            <Text className="text-sm text-muted-foreground">
              We generated a strong password for you. Save it in your password manager — there is no
              way to reset it if it&apos;s lost.
            </Text>
            <ShowOnceSecret
              secret={passphrase}
              label="Your new password"
              saved={passphraseSaved}
              onSavedChange={setPassphraseSaved}
              confirmLabel="I've saved my new password somewhere safe."
            />
            <View className="flex-row items-center justify-between">
              <Pressable
                onPress={regeneratePassphrase}
                disabled={changePassword.isPending}
                className="flex-row items-center gap-1.5"
              >
                <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Regenerate</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setMode('own');
                  if (error) setError(null);
                }}
              >
                <Text className="text-sm text-muted-foreground underline">Choose my own</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="gap-2">
            <Text className="text-sm font-medium">New password</Text>
            <PasswordInput
              autoComplete="new-password"
              aria-invalid={!!ownPasswordError}
              value={ownPassword}
              editable={!changePassword.isPending}
              onChangeText={(text) => {
                setOwnPassword(text);
                if (error) setError(null);
              }}
            />
            <PasswordStrengthMeter displayScore={displayScore} />
            {ownPasswordError ? (
              <Text className="text-sm text-destructive">{ownPasswordError}</Text>
            ) : null}
            <Text className="text-sm text-muted-foreground">
              A password of random words is stronger than most passwords you&apos;d type. If you use
              your own, make it long and unique.{' '}
              <Text
                className="text-sm text-muted-foreground underline"
                onPress={() => {
                  setMode('generated');
                  if (error) setError(null);
                }}
              >
                Generate one instead
              </Text>
            </Text>
          </View>
        )}

        <View className="flex-row">
          <Button
            disabled={changePassword.isPending || !newOk || !proofReady}
            onPress={() => void onSubmit()}
          >
            <Text>{changePassword.isPending ? 'Changing…' : 'Change password'}</Text>
          </Button>
        </View>
        {error ? (
          <View className="flex-row items-start gap-2">
            <Icon as={CircleAlert} className="mt-0.5 size-4 shrink-0 text-destructive" />
            <Text className="min-w-0 flex-1 text-sm text-destructive">{error}</Text>
          </View>
        ) : null}

        {/* Honest boundary of what a password change is: a door rotation, not a
            DEK rotation (docs/account.md) — see web for the full note. */}
        <Text className="mt-2 border-t border-border pt-4 text-xs text-muted-foreground">
          Changing your password replaces how you sign in — it doesn&apos;t re-encrypt data
          you&apos;ve already synced. If you think someone actually had your old password, changing
          it alone won&apos;t protect data they may have already copied. In that case the safe path
          is to export your data (Settings → Data), delete this account, and create a new one.
        </Text>
      </View>
    </View>
  );
}

// Generate or regenerate the recovery door. Prove the current password, mint a new
// code server-side, and show it ONCE. Regenerating invalidates any previous code.
function RecoveryCodeView({ onBack, hasRecovery }: { onBack: () => void; hasRecovery: boolean }) {
  const recovery = useRecoveryCode();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Frozen at mount: a successful mint invalidates the recovery-door query, which
  // flips `hasRecovery` to true underneath us. The copy has to describe the account
  // the user arrived with, not the one this view's own write just produced.
  const [hadRecovery] = useState(hasRecovery);

  const onSubmit = async () => {
    if (recovery.isPending || currentPassword === '') return;
    setError(null);
    try {
      const result = await recovery.mutateAsync({
        proof: { kind: 'password', currentPassword },
      });
      setCode(result.recoveryCode);
      // The nudge on the overview reads this query — refresh it so it clears.
      void queryClient.invalidateQueries({ queryKey: hasRecoveryDoorQueryKey });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) setError('Incorrect password.');
      else setError('Could not generate a recovery code. Please try again.');
    }
  };

  if (code) {
    return (
      <View>
        {/* No `back` on this header, deliberately (every other sub-view has
            one) — the mint has landed and the old door is dead; Done (gated on
            `saved`) is the only exit. See web's rationale in full. */}
        <SettingsHeader
          title="Recovery code"
          description={
            hadRecovery
              ? 'Save this somewhere safe — it won’t be shown again. Your previous code has stopped working, so this is the only one that can get you back into your account.'
              : 'Save this somewhere safe — it won’t be shown again. It’s your only way back into your account if you forget your password.'
          }
        />
        <View className="mt-4 max-w-sm">
          <ShowOnceSecret
            secret={code}
            label="Your recovery code"
            saved={saved}
            onSavedChange={setSaved}
            confirmLabel="I've saved my recovery code somewhere safe."
          />
          <View className="mt-4 flex-row">
            <Button disabled={!saved} onPress={onBack}>
              <Text>Done</Text>
            </Button>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View>
      <SettingsHeader
        title="Recovery code"
        description={
          hadRecovery
            ? 'Generate a new recovery code. Your previous code will stop working.'
            : 'Set up a recovery code — a second way into your account if you lose your password.'
        }
        back={{ label: 'Account', onPress: onBack }}
      />

      <View className="mt-6 max-w-sm gap-4">
        <View className="gap-2">
          <Text className="text-sm font-medium">Current password</Text>
          <PasswordInput
            autoComplete="current-password"
            value={currentPassword}
            editable={!recovery.isPending}
            onChangeText={(text) => {
              setCurrentPassword(text);
              if (error) setError(null);
            }}
          />
        </View>
        <View className="flex-row">
          <Button
            disabled={recovery.isPending || currentPassword === ''}
            onPress={() => void onSubmit()}
          >
            <Text>
              {recovery.isPending
                ? 'Generating…'
                : hadRecovery
                  ? 'Generate new code'
                  : 'Generate recovery code'}
            </Text>
          </Button>
        </View>
        {error ? (
          <SettingsNotice
            tone="error"
            icon={<Icon as={CircleAlert} className="size-4 text-destructive" />}
          >
            {error}
          </SettingsNotice>
        ) : null}
      </View>
    </View>
  );
}

// Sign out every OTHER device, keeping this one. Session-only (no password
// re-entry): a low-harm, reversible action — this dedicated view IS the confirm
// step (the section uses in-section views, not modal dialogs).
function SignOutOtherDevicesView({ onBack }: { onBack: () => void }) {
  const signOutOthers = useSignOutOthers();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onConfirm = async () => {
    if (signOutOthers.isPending) return;
    setError(null);
    try {
      await signOutOthers.mutateAsync();
      setDone(true);
    } catch {
      setError('Could not sign out your other devices. Please try again.');
    }
  };

  return (
    <View>
      <SettingsHeader title="Sign out other devices" back={{ label: 'Account', onPress: onBack }} />
      {done ? (
        <View className="mt-3 flex-row items-start gap-2">
          <Icon as={ShieldCheck} className="mt-0.5 size-4 shrink-0 text-primary" />
          <Text className="min-w-0 flex-1 text-sm">
            Your other devices have been signed out. They&apos;ll need to sign in again. This device
            stays signed in.
          </Text>
        </View>
      ) : (
        <>
          <Text className="mt-1 text-sm text-muted-foreground">
            End every other signed-in session. Any other browser or device will have to sign in
            again — this one stays signed in. Your data isn&apos;t touched.
          </Text>
          <View className="mt-6 flex-row">
            <Button onPress={() => void onConfirm()} disabled={signOutOthers.isPending}>
              <Text>{signOutOthers.isPending ? 'Signing out…' : 'Sign out other devices'}</Text>
            </Button>
          </View>
          {error ? (
            <SettingsNotice
              tone="error"
              className="mt-3"
              icon={<Icon as={CircleAlert} className="size-4 text-destructive" />}
            >
              {error}
            </SettingsNotice>
          ) : null}
        </>
      )}
    </View>
  );
}

export function AccountSection() {
  const { username } = useAuth();
  const [view, setView] = useState<AccountView>('overview');
  const hasRecovery = useHasRecoveryDoor();

  return (
    <SettingsPane>
      {view === 'overview' ? (
        <>
          <SettingsHeader
            title="Account"
            description="Your account is your username and password — no email, nothing else on file."
          />

          <SettingsRow
            title="Username"
            description={
              <Text numberOfLines={1} className="text-sm text-muted-foreground">
                {username}
              </Text>
            }
          />

          {hasRecovery.data === false ? (
            <SettingsNotice
              icon={<Icon as={CircleAlert} className="size-4 text-muted-foreground" />}
            >
              <Text className="text-sm text-muted-foreground">
                You haven&apos;t set up a recovery code. Without one, a lost password means a lost
                account — there is no email reset.{' '}
                <Text
                  className="text-sm text-muted-foreground underline"
                  onPress={() => setView('recovery')}
                >
                  Set one up
                </Text>
                .
              </Text>
            </SettingsNotice>
          ) : null}

          <View className="gap-3">
            <SettingsRow
              icon={<Icon as={KeyRound} className="size-5 text-muted-foreground" />}
              title="Change password"
              description="Set a new password using your current one or your recovery code."
              onPress={() => setView('change-password')}
            />
            <SettingsRow
              icon={<Icon as={ShieldCheck} className="size-5 text-muted-foreground" />}
              title="Recovery code"
              description={
                hasRecovery.data === false
                  ? 'Not set up yet — add a way back into your account.'
                  : 'Generate a new recovery code (replaces the old one).'
              }
              onPress={() => setView('recovery')}
            />
            <SettingsRow
              icon={<Icon as={MonitorSmartphone} className="size-5 text-muted-foreground" />}
              title="Sign out other devices"
              description="End every other signed-in session but this one."
              onPress={() => setView('sign-out-others')}
            />
            <SettingsRow
              icon={<Icon as={UserX} className="size-5 text-destructive" />}
              title="Delete account"
              description="Permanently delete your account and all your data."
              onPress={() => setView('delete')}
              destructive
            />
          </View>
        </>
      ) : view === 'change-password' ? (
        <ChangePasswordView onBack={() => setView('overview')} />
      ) : view === 'recovery' ? (
        <RecoveryCodeView
          onBack={() => setView('overview')}
          hasRecovery={hasRecovery.data === true}
        />
      ) : view === 'sign-out-others' ? (
        <SignOutOtherDevicesView onBack={() => setView('overview')} />
      ) : (
        <DeleteAccountView onBack={() => setView('overview')} />
      )}
    </SettingsPane>
  );
}
