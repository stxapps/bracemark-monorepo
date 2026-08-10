'use client';

// The Account settings section: who you're signed in as, and the account-level
// danger zone — Delete account. Mirrors the Data section's shape (an overview
// whose rows open focused screens as in-section VIEW STATE, self-contained in
// `_account/`), and deliberately does NOT duplicate sign-out (the topbar owns
// that).
//
// Delete account is the FULL teardown — every synced object, every session, the
// account itself — distinct from Data → "Delete all data" (data only, account
// survives). It's guarded by a fresh password re-entry, not just the session:
// the server refuses the call without a proof signed by the password-derived
// key, so the form here collects the password and useDeleteAccount runs the
// door-fetch → unwrap → sign → POST sequence (docs/data-lifecycle.md). A live
// (renewing or dunning) subscription blocks deletion server-side; the view
// pre-warns from the same entitlements read and points at the Subscription
// section, where Paddle's portal handles cancellation.

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserX,
} from 'lucide-react';
import Link from 'next/link';

import { hasRecoveryDoorQueryKey, useSignOutOthers } from '@stxapps/react';
import {
  canonicalizePassword,
  generatePassphrase,
  NEW_PASSWORD_MIN_LENGTH,
  newPasswordSchema,
  PASSWORD_MIN_GUESSES_LOG10,
} from '@stxapps/shared';
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
} from '@stxapps/web-react';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import {
  PasswordStrengthMeter,
  usePasswordStrength,
} from '@stxapps/web-ui/components/auth/password-strength';
import { ShowOnceSecret } from '@stxapps/web-ui/components/auth/show-once-secret';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { Label } from '@stxapps/web-ui/components/ui/label';

import {
  SettingsHeader,
  SettingsNotice,
  SettingsPane,
  SettingsRow,
} from '../../_components/settings-kit';

type AccountView = 'overview' | 'change-password' | 'recovery' | 'sign-out-others' | 'delete';

function DeleteAccountView({ onBack }: { onBack: () => void }) {
  const { subscription } = useEntitlements();
  const { mutate, isPending, error, reset } = useDeleteAccount();
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // Reveal the "tick the box first" nudge only after a submit without the box.
  const [nudge, setNudge] = useState(false);

  // The same rule the server enforces with its 409: a subscription that would
  // keep billing (renewing, or in dunning) must be canceled first. Pre-warning
  // from the cached entitlements read spares the user typing their password
  // into a call that's going to be refused — but the SERVER check is the gate;
  // this is UX, and a stale cache just means the 409 lands below instead.
  const subscriptionBlocks = subscription.status === 'grace' || subscription.willRenew;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
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
    <>
      <SettingsHeader
        back={{ label: 'Account', onClick: onBack }}
        title="Delete account"
        description="Permanently delete your account and everything in it: all your data on all your devices, your account keys, and every signed-in session."
      />
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Your username stays reserved and can&apos;t be registered again — by you or anyone else.
          If you have a canceled subscription with paid time remaining, that time is forfeited.
          Consider exporting your data first (Settings → Data).
        </p>
        <p className="text-sm font-medium text-destructive">
          This action cannot be undone. There is no grace period and no recovery.
        </p>
      </div>

      {subscriptionBlocks && (
        <SettingsNotice icon={<CircleAlert className="size-4" />}>
          <span>
            You have an active subscription. Cancel it in{' '}
            <Link
              href="/settings/subscription"
              className="underline hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Subscription settings
            </Link>{' '}
            first — deleting the account doesn&apos;t stop the billing.
          </span>
        </SettingsNotice>
      )}

      <form onSubmit={onSubmit}>
        {/* Fresh proof, not just the session: the server only accepts this call
            signed by the password-derived key, so the password is required here
            even though you're signed in. */}
        <div className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="delete-account-password">Confirm your password</Label>
          <Input
            id="delete-account-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={isPending}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) reset();
            }}
          />
        </div>

        <Label
          htmlFor="delete-account-confirm"
          className="mt-4 flex items-start gap-3 rounded-lg border border-border p-3"
        >
          <Checkbox
            id="delete-account-confirm"
            checked={confirmed}
            disabled={isPending}
            onCheckedChange={(v) => {
              setConfirmed(v === true);
              setNudge(false);
            }}
            className="mt-0.5"
          />
          <span className="text-sm font-normal">
            Yes, I understand my account and all my data will be permanently deleted, with no way
            back.
          </span>
        </Label>

        {nudge && (
          <p className="mt-2 text-sm text-destructive">Please tick the box above to confirm.</p>
        )}

        <div className="mt-6">
          <Button
            type="submit"
            variant="destructive"
            disabled={isPending || password.length === 0 || subscriptionBlocks}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {isPending ? 'Deleting account…' : 'Delete account forever'}
          </Button>
        </div>

        {errorText && (
          <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="wrap-break-words">{errorText}</span>
          </p>
        )}
      </form>
    </>
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

  // A generated passphrase is the safe default here too (docs/account.md); the typed
  // path is the escape hatch gated by the same zxcvbn floor as create-account.
  // Generate on mount so the field is populated the moment the view opens.
  useEffect(() => {
    setPassphrase(generatePassphrase());
  }, []);

  const newPassword = mode === 'generated' ? passphrase : ownPassword;

  // Strength only matters on the typed path (the generated passphrase is ~77 bits by
  // construction). Score the CANONICAL form — the exact string the new KEK derives
  // from — and fold in the same length floor so the meter and the gate agree.
  const { guessesLog10, displayScore } = usePasswordStrength(
    mode === 'own' ? canonicalizePassword(ownPassword) : '',
    [],
    NEW_PASSWORD_MIN_LENGTH,
  );
  // Parse once so the schema's own message can surface under the field — the meter
  // says "Weak" without naming the rule that's blocking, which sends people reaching
  // for symbols when length is what's missing.
  const ownPasswordParse = newPasswordSchema.safeParse(ownPassword);
  // Gate on the raw guess estimate; `displayScore` is the meter's, not the policy's
  // (see PASSWORD_MIN_GUESSES_LOG10).
  // null = estimator still loading; stay closed until it's ready.
  const newOk =
    mode === 'generated'
      ? passphrase !== '' && passphraseSaved
      : ownPasswordParse.success &&
        guessesLog10 !== null &&
        guessesLog10 >= PASSWORD_MIN_GUESSES_LOG10;

  // Only once they've typed something. Length first (the schema owns its own message),
  // then the entropy floor — otherwise a long-but-predictable password would fail with
  // a silent "Fair" meter and no way to know what to change.
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

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
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
      <>
        <SettingsHeader back={{ label: 'Account', onClick: onBack }} title="Change password" />
        <p className="flex items-start gap-2 text-sm text-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          Your password has been changed. You&apos;re still signed in on this device, and your other
          devices have been signed out.
        </p>
        <p className="text-xs text-muted-foreground">
          This changed how you sign in, but didn&apos;t re-encrypt data you&apos;ve already synced.
          If your old password may have been compromised, a password change alone won&apos;t protect
          data an attacker could already have copied — export your data (
          <Link href="/settings/data" className="underline hover:text-foreground">
            Settings → Data
          </Link>
          ), delete this account, and create a new one.
        </p>
      </>
    );
  }

  return (
    <>
      <SettingsHeader
        back={{ label: 'Account', onClick: onBack }}
        title="Change password"
        description="You'll need your current password. There is no email reset, so keep the new one safe."
      />

      <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
        {useRecovery ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="cp-recovery">Recovery code</Label>
            <Input
              id="cp-recovery"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono"
              value={recoveryCode}
              disabled={changePassword.isPending}
              onChange={(e) => {
                setRecoveryCode(e.target.value);
                if (error) setError(null);
              }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="cp-current">Current password</Label>
            <PasswordInput
              id="cp-current"
              autoComplete="current-password"
              value={currentPassword}
              disabled={changePassword.isPending}
              onChange={(e) => {
                setCurrentPassword(e.target.value);
                if (error) setError(null);
              }}
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            setUseRecovery((v) => !v);
            setError(null);
          }}
          className="-mt-2 self-start text-sm text-muted-foreground underline hover:text-foreground"
        >
          {useRecovery ? 'Use my current password instead' : 'I forgot it — use my recovery code'}
        </button>

        {mode === 'generated' ? (
          <div className="flex flex-col gap-2">
            <Label>New password</Label>
            <p className="text-sm text-muted-foreground">
              We generated a strong password for you. Save it in your password manager — there is no
              way to reset it if it&apos;s lost.
            </p>
            <ShowOnceSecret
              id="cp-passphrase-saved"
              secret={passphrase}
              label="Your new password"
              saved={passphraseSaved}
              onSavedChange={setPassphraseSaved}
              confirmLabel="I've saved my new password somewhere safe."
            />
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={regeneratePassphrase}
                disabled={changePassword.isPending}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className="size-3.5" />
                Regenerate
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('own');
                  if (error) setError(null);
                }}
                className="text-sm text-muted-foreground underline hover:text-foreground"
              >
                Choose my own
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="cp-new">New password</Label>
            <PasswordInput
              id="cp-new"
              autoComplete="new-password"
              aria-invalid={!!ownPasswordError}
              value={ownPassword}
              disabled={changePassword.isPending}
              onChange={(e) => {
                setOwnPassword(e.target.value);
                if (error) setError(null);
              }}
            />
            <PasswordStrengthMeter displayScore={displayScore} />
            {ownPasswordError ? (
              <p className="text-sm text-destructive">{ownPasswordError}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              A password of random words is stronger than most passwords you&apos;d type. If you use
              your own, make it long and unique.{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('generated');
                  if (error) setError(null);
                }}
                className="underline hover:text-foreground"
              >
                Generate one instead
              </button>
            </p>
          </div>
        )}

        <div>
          <Button type="submit" disabled={changePassword.isPending || !newOk || !proofReady}>
            {changePassword.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {changePassword.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </div>
        {error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        {/* Honest boundary of what a password change is: a door rotation, not a
            DEK rotation (docs/account.md). It re-wraps the same DEK, so anyone
            who already had the old password could have unwrapped that DEK — and
            it stays valid, keeping any ciphertext they exfiltrated readable.
            DEK rotation isn't shipped yet, so the real-compromise remedy is the
            manual export → delete → recreate path. */}
        <p className="mt-2 border-t border-border pt-4 text-xs text-muted-foreground">
          Changing your password replaces how you sign in — it doesn&apos;t re-encrypt data
          you&apos;ve already synced. If you think someone actually had your old password, changing
          it alone won&apos;t protect data they may have already copied. In that case the safe path
          is to export your data (
          <Link href="/settings/data" className="underline hover:text-foreground">
            Settings → Data
          </Link>
          ), delete this account, and create a new one.
        </p>
      </form>
    </>
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

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
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
      <>
        {/* No back link here, deliberately (every other sub-view has one). By this
            point the mint has landed: any previous door is already dead server-side,
            and `hasRecovery` is now true — so a user who leaves without saving is
            stranded with a recovery door they can't open, and the overview's "no
            recovery code" nudge won't fire to tell them. Done (gated on `saved`) is
            the only exit. It's friction, not enforcement — the settings nav and the
            back button still leave, and the checkbox is self-attested — but it makes
            leaving deliberate rather than a stray click. Contrast create-account's
            recovery step, which DOES offer back: there nothing is committed until the
            account is created, so leaving costs nothing. */}
        <SettingsHeader
          title="Recovery code"
          description={
            hadRecovery
              ? 'Save this somewhere safe — it won’t be shown again. Your previous code has stopped working, so this is the only one that can get you back into your account.'
              : 'Save this somewhere safe — it won’t be shown again. It’s your only way back into your account if you forget your password.'
          }
        />
        <div className="max-w-sm">
          <ShowOnceSecret
            id="settings-recovery-saved"
            secret={code}
            label="Your recovery code"
            saved={saved}
            onSavedChange={setSaved}
            confirmLabel="I've saved my recovery code somewhere safe."
          />
          <Button className="mt-4" disabled={!saved} onClick={onBack}>
            Done
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <SettingsHeader
        back={{ label: 'Account', onClick: onBack }}
        title="Recovery code"
        description={
          hadRecovery
            ? 'Generate a new recovery code. Your previous code will stop working.'
            : 'Set up a recovery code — a second way into your account if you lose your password.'
        }
      />

      <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rc-current">Current password</Label>
          <PasswordInput
            id="rc-current"
            autoComplete="current-password"
            value={currentPassword}
            disabled={recovery.isPending}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        <div>
          <Button type="submit" disabled={recovery.isPending || currentPassword === ''}>
            {recovery.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {recovery.isPending
              ? 'Generating…'
              : hadRecovery
                ? 'Generate new code'
                : 'Generate recovery code'}
          </Button>
        </div>
        {error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
      </form>
    </>
  );
}

// Sign out every OTHER device, keeping this one. Session-only (no password
// re-entry): a low-harm, reversible action — the other devices just land back on
// sign-in. This dedicated view IS the confirm step (the section uses in-section
// views, not modal dialogs), so the button click is the deliberate confirmation.
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
    <>
      <SettingsHeader back={{ label: 'Account', onClick: onBack }} title="Sign out other devices" />
      {done ? (
        <p className="flex items-start gap-2 text-sm text-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          Your other devices have been signed out. They&apos;ll need to sign in again. This device
          stays signed in.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            End every other signed-in session. Any other browser or device will have to sign in
            again — this one stays signed in. Your data isn&apos;t touched.
          </p>
          <div>
            <Button onClick={onConfirm} disabled={signOutOthers.isPending}>
              {signOutOthers.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {signOutOthers.isPending ? 'Signing out…' : 'Sign out other devices'}
            </Button>
          </div>
          {error ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </>
      )}
    </>
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

          <SettingsRow title="Username" description={username} />

          {hasRecovery.data === false ? (
            <SettingsNotice icon={<CircleAlert className="size-4" />}>
              <span>
                You haven&apos;t set up a recovery code. Without one, a lost password means a lost
                account — there is no email reset.{' '}
                <button
                  type="button"
                  onClick={() => setView('recovery')}
                  className="underline hover:text-foreground"
                >
                  Set one up
                </button>
                .
              </span>
            </SettingsNotice>
          ) : null}

          <div className="flex flex-col gap-3">
            <SettingsRow
              icon={<KeyRound className="size-5" />}
              title="Change password"
              description="Set a new password using your current one or your recovery code."
              onClick={() => setView('change-password')}
            />
            <SettingsRow
              icon={<ShieldCheck className="size-5" />}
              title="Recovery code"
              description={
                hasRecovery.data === false
                  ? 'Not set up yet — add a way back into your account.'
                  : 'Generate a new recovery code (replaces the old one).'
              }
              onClick={() => setView('recovery')}
            />
            <SettingsRow
              icon={<MonitorSmartphone className="size-5" />}
              title="Sign out other devices"
              description="End every other signed-in session but this one."
              onClick={() => setView('sign-out-others')}
            />
            <SettingsRow
              icon={<UserX className="size-5" />}
              title="Delete account"
              description="Permanently delete your account and all your data."
              onClick={() => setView('delete')}
              destructive
            />
          </div>
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
