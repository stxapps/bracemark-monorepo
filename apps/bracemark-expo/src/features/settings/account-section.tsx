// The Account settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_account/account-section.tsx` (the canonical doc:
// the overview-plus-sub-views shape, why Delete account demands a fresh
// password even with a live session, why sign-out is NOT duplicated here — the
// links ⋯ menu owns it on this platform). Sub-views are in-section VIEW STATE
// (a local `view` swap), not routes, exactly like web.

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  CircleAlert,
  KeyRound,
  MonitorSmartphone,
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
import {
  hasRecoveryDoorQueryKey,
  RECOVERY_CODE_COPY,
  SESSION_COPY,
  useSignOutOthers,
} from '@stxapps/react';

import { ErrorText } from '../../components/error-text';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { NewPasswordField, useNewPassword } from '../auth/new-password-field';
import { PasswordInput } from '../auth/password-input';
import { ShowOnceSecret } from '../auth/show-once-secret';
import { SettingsHeader, SettingsNotice, SettingsPane, SettingsRow } from './settings-kit';

type AccountView = 'overview' | 'change-password' | 'recovery' | 'sign-out-others' | 'delete';

function DeleteAccountView({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const { subscription } = useEntitlements();
  const { mutate, isPending, error, reset } = useDeleteAccount();
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // Reveal each "you still need to…" nudge only after a submit that was missing it.
  // The checkbox already worked this way; the password now matches it rather than
  // holding the button down (docs/account.md, _when a submit is allowed to be
  // `disabled`_).
  const [passwordNudge, setPasswordNudge] = useState(false);
  const [nudge, setNudge] = useState(false);

  // The same rule the server enforces with its 409: a subscription that would
  // keep billing (renewing, or in dunning) must be canceled first. Pre-warning
  // from the cached entitlements read spares the user typing their password
  // into a call that's going to be refused — but the SERVER check is the gate.
  const subscriptionBlocks = subscription.status === 'grace' || subscription.willRenew;

  const onSubmit = () => {
    if (isPending) return;
    // Report BOTH misses at once — a user who submits an empty form should not have
    // to discover the second requirement after satisfying the first.
    setPasswordNudge(password.length === 0);
    setNudge(!confirmed);
    if (password.length === 0 || !confirmed) return;
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
      {/* All three paragraphs go THROUGH the header — the trailing two used to
          hang off it on `mt-3`. That fixes a 32 on web and moves this platform
          12 → 16, the step the header's column now sets for every description that
          has more than one paragraph. The web twin carries the note. */}
      <SettingsHeader
        title="Delete account"
        back={{ label: 'Account', onPress: onBack }}
        description={
          <>
            <Text className="text-sm text-muted-foreground">
              Permanently delete your account and everything in it: all your data on all your
              devices, your account keys, and every signed-in session.
            </Text>
            <Text className="text-sm text-muted-foreground">
              Your username stays reserved and can’t be registered again — by you or anyone else. If
              you have a canceled subscription with paid time remaining, that time is forfeited.
              Consider exporting your data first (Settings → Data).
            </Text>
            <Text className="text-sm font-medium text-destructive">
              This can’t be undone. There is no grace period, and we don’t bring a deleted account
              back from a backup.
            </Text>
          </>
        }
      />

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
            first — deleting the account doesn’t stop the billing.
          </Text>
        </SettingsNotice>
      )}

      {/* Fresh proof, not just the session: the server only accepts this call
          signed by a key the password unwraps, so the password is required here
          even though you're signed in. */}
      <View className="mt-6 max-w-sm gap-2">
        <Text className="text-sm font-medium">Confirm your password</Text>
        {/* `aria-label` because the Text above is only visually adjacent — RN
            has no <label for>. `testID`s here and below are the e2e contract
            (docs/e2e.md, _the testID contract_). */}
        <PasswordInput
          testID="delete-account-password"
          aria-label="Confirm your password"
          autoComplete="current-password"
          value={password}
          editable={!isPending}
          className={cn(passwordNudge && 'border-destructive')}
          onChangeText={(text) => {
            setPassword(text);
            setPasswordNudge(false);
            if (error) reset();
          }}
        />
        {passwordNudge && <ErrorText>Please enter your password to confirm.</ErrorText>}
      </View>

      {/* The row IS the checkbox to a screen reader, not a button wrapping one:
          Pressable defaults to `accessible`, which collapses the inner Checkbox's
          own semantics into this node — so the role and the checked state have to
          be re-declared here or the whole row announces as untyped text. */}
      <Pressable
        role="checkbox"
        testID="delete-account-confirm"
        aria-checked={confirmed}
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

      {nudge && <ErrorText className="mt-2">Please tick the box above to confirm.</ErrorText>}

      <View className="mt-6 flex-row">
        {/* `subscriptionBlocks` is the one disable this view keeps: the
            SettingsNotice above states it in full and links where to fix it, so the
            dimmed button sits under its own explanation. */}
        <Button
          variant="destructive"
          testID="delete-account-submit"
          disabled={isPending || subscriptionBlocks}
          onPress={onSubmit}
        >
          <Icon as={Trash2} className="size-4" />
          <Text>{isPending ? 'Deleting account…' : 'Delete account forever'}</Text>
        </Button>
      </View>

      {errorText && (
        <ErrorText className="mt-3" icon={CircleAlert}>
          {errorText}
        </ErrorText>
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
  const { username } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The whole "choose a new password" block — generated by default
  // (docs/account.md), typed-your-own behind the same zxcvbn floor as
  // create-account, which is the point of sharing the component rather than
  // describing it as "the same floor". `username` is the penalty term: it was
  // MISSING here while create-account passed it, so a username-derived password
  // could fail at signup and pass at rotation.
  const newPassword = useNewPassword({ username });

  const proofReady = useRecovery ? recoveryCode !== '' : currentPassword !== '';

  const onSubmit = async () => {
    // `newPassword.ok` still returns silently: the button IS disabled for it, and
    // legibly so — generated mode blocks on the labelled checkbox in ShowOnceSecret,
    // typed mode on the permanent message line under the field, which is the gate
    // itself. An empty proof field had neither, so it says so instead
    // (docs/account.md, _when a submit is allowed to be `disabled`_). Same slot as
    // "Incorrect password." below.
    if (changePassword.isPending || !newPassword.ok) return;
    if (!proofReady) {
      setError(useRecovery ? 'Enter your recovery code.' : 'Enter your current password.');
      return;
    }
    setError(null);
    try {
      await changePassword.mutateAsync({
        newPassword: newPassword.password,
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
          <Text className="min-w-0 flex-1 text-sm">{SESSION_COPY.passwordChanged}</Text>
        </View>
        <Text className="mt-4 text-xs text-muted-foreground">
          This changed how you sign in, but didn’t re-encrypt data you’ve already synced. If your
          old password may have been compromised, a password change alone won’t protect data an
          attacker could already have copied — export your data (Settings → Data on the web app),
          delete this account, and create a new one.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <SettingsHeader
        title="Change password"
        description="You’ll need your current password. There is no email reset, so keep the new one safe."
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
          role="button"
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

        <NewPasswordField
          control={newPassword}
          copy="change"
          disabled={changePassword.isPending}
          onEdit={() => {
            if (error) setError(null);
          }}
        />
        {/* The message belongs to the BUTTON — it's what the press answered with —
            so it rides inside the button's wrapper at `mt-3` rather than standing as
            another item in this column's `gap-4`. Same 12 as DeleteAccountView and
            SignOutOtherDevicesView, which already sit outside a gapped parent. It
            has to be nested to get it: a margin on a flex ITEM adds to the gap
            (16 + 12), it doesn't replace it. */}
        <View>
          <View className="flex-row">
            <Button
              disabled={changePassword.isPending || !newPassword.ok}
              onPress={() => void onSubmit()}
            >
              <Text>{changePassword.isPending ? 'Changing…' : 'Change password'}</Text>
            </Button>
          </View>
          {error ? (
            <ErrorText className="mt-3" icon={CircleAlert}>
              {error}
            </ErrorText>
          ) : null}
        </View>

        {/* Honest boundary of what a password change is: a door rotation, not a
            DEK rotation (docs/account.md) — see web for the full note. */}
        <Text className="mt-2 border-t border-border pt-4 text-xs text-muted-foreground">
          Changing your password replaces how you sign in — it doesn’t re-encrypt data you’ve
          already synced. If you think someone actually had your old password, changing it alone
          won’t protect data they may have already copied. In that case the safe path is to export
          your data (Settings → Data), delete this account, and create a new one.
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
    if (recovery.isPending) return;
    // Empty answers out loud rather than holding the button down; the slot below
    // the button is the same one "Incorrect password." uses.
    if (currentPassword === '') {
      setError('Enter your current password.');
      return;
    }
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
          title={RECOVERY_CODE_COPY.title}
          description={
            hadRecovery
              ? RECOVERY_CODE_COPY.description.remint
              : RECOVERY_CODE_COPY.description.mint
          }
        />
        <View className="mt-4 max-w-sm">
          <ShowOnceSecret
            secret={code}
            label={RECOVERY_CODE_COPY.secretLabel}
            saved={saved}
            onSavedChange={setSaved}
            confirmLabel={RECOVERY_CODE_COPY.confirmLabel}
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
        {/* Inside the button's wrapper, at 12 — see ChangePasswordView above for why
            nested rather than a margin on the flex item. */}
        <View>
          <View className="flex-row">
            <Button disabled={recovery.isPending} onPress={() => void onSubmit()}>
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
            <ErrorText className="mt-3" icon={CircleAlert}>
              {error}
            </ErrorText>
          ) : null}
        </View>
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
      {/* Description, not a loose paragraph — the web twin carries the note. It
          drops once the job is done, because what stands there then is the receipt
          below. */}
      <SettingsHeader
        title="Sign out other devices"
        back={{ label: 'Account', onPress: onBack }}
        description={
          done
            ? undefined
            : 'End every other signed-in session — this one stays signed in. Each of the others erases its local copy the next time it connects.'
        }
      />
      {done ? (
        <View className="mt-3 flex-row items-start gap-2">
          <Icon as={ShieldCheck} className="mt-0.5 size-4 shrink-0 text-primary" />
          <Text className="min-w-0 flex-1 text-sm">
            Your other devices have been signed out. They’ll need to sign in again. This device
            stays signed in.
          </Text>
        </View>
      ) : (
        <>
          <View className="mt-6 flex-row">
            <Button onPress={() => void onConfirm()} disabled={signOutOthers.isPending}>
              <Text>{signOutOthers.isPending ? 'Signing out…' : 'Sign out other devices'}</Text>
            </Button>
          </View>
          {error ? (
            <ErrorText className="mt-3" icon={CircleAlert}>
              {error}
            </ErrorText>
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
            description="Your account is your username and password. There is no email address on it."
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
                You haven’t set up a recovery code. Without one, a lost password means a lost
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
              testID="delete-account-open"
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
