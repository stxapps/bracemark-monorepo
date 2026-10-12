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
// the server refuses the call without a proof signed by a key the password
// unwraps, so the form here collects the password and useDeleteAccount runs the
// door-fetch → unwrap → sign → POST sequence (docs/data-lifecycle.md). A live
// (renewing or dunning) subscription blocks deletion server-side; the view
// pre-warns from the same entitlements read and points at the Subscription
// section, where Paddle's portal handles cancellation.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
  UserX,
} from 'lucide-react';
import Link from 'next/link';

import {
  hasRecoveryDoorQueryKey,
  RECOVERY_CODE_COPY,
  SESSION_COPY,
  useSignOutOthers,
} from '@stxapps/react';
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
import { HiddenUsername } from '@stxapps/web-ui/components/auth/hidden-username';
import {
  NewPasswordField,
  useNewPassword,
} from '@stxapps/web-ui/components/auth/new-password-field';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
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
  const { username } = useAuth();
  const { mutate, isPending, error, reset } = useDeleteAccount();
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // Reveal each "you still need to…" nudge only after a submit that was missing it.
  // The checkbox already worked this way; the password now matches it rather than
  // holding the button down (docs/account.md, _when a submit is allowed to be
  // `disabled`_). Both mount above the button, which does shift it — but the retry
  // target for either is the control ABOVE the message (the field, the box), not
  // the button the pointer just left, so nothing moves out from under the cursor.
  const [passwordNudge, setPasswordNudge] = useState(false);
  const [nudge, setNudge] = useState(false);

  // The same rule the server enforces with its 409: a subscription that would
  // keep billing (renewing, or in dunning) must be canceled first. Pre-warning
  // from the cached entitlements read spares the user typing their password
  // into a call that's going to be refused — but the SERVER check is the gate;
  // this is UX, and a stale cache just means the 409 lands below instead.
  const subscriptionBlocks = subscription.status === 'grace' || subscription.willRenew;

  const onSubmit = (event: React.SubmitEvent) => {
    event.preventDefault();
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
    <>
      {/* All three paragraphs go THROUGH the header. The trailing two used to sit
          outside it, which cost the pane's 32 to reach the second sentence of one
          explanation — the twin of this screen (_data/data-section.tsx's
          DeleteView) carries the full note. */}
      <SettingsHeader
        back={{ label: 'Account', onClick: onBack }}
        title="Delete account"
        description={
          <>
            <p>
              Permanently delete your account and everything in it: all your data on all your
              devices, your account keys, and every signed-in session.
            </p>
            <p>
              Your username stays reserved and can’t be registered again — by you or anyone else. If
              you have a canceled subscription with paid time remaining, that time is forfeited.
              Consider exporting your data first (Settings → Data).
            </p>
            <p className="font-medium text-destructive">
              This can’t be undone. There is no grace period, and we don’t bring a deleted account
              back from a backup.
            </p>
          </>
        }
      />

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
            first — deleting the account doesn’t stop the billing.
          </span>
        </SettingsNotice>
      )}

      <form onSubmit={onSubmit}>
        {/* One `current-password` and no username: without this a password
            manager can't tell which saved login to fill here. */}
        <HiddenUsername username={username} />
        {/* Fresh proof, not just the session: the server only accepts this call
            signed by a key the password unwraps, so the password is required
            here even though you're signed in. */}
        <div className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="delete-account-password">Confirm your password</Label>
          <PasswordInput
            id="delete-account-password"
            autoComplete="current-password"
            value={password}
            disabled={isPending}
            aria-invalid={passwordNudge}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordNudge(false);
              if (error) reset();
            }}
          />
          {passwordNudge && (
            <p role="alert" className="text-sm text-destructive">
              Please enter your password to confirm.
            </p>
          )}
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
          <span className="text-sm">
            Yes, I understand my account and all my data will be permanently deleted, with no way
            back.
          </span>
        </Label>

        {nudge && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Please tick the box above to confirm.
          </p>
        )}

        <div className="mt-6">
          {/* `subscriptionBlocks` is the one disable this view keeps: the
              SettingsNotice above states it in full and links where to fix it, so
              the greyed-out button sits under its own explanation. An empty
              password had no such line — it now answers on submit instead. */}
          <Button type="submit" variant="destructive" disabled={isPending || subscriptionBlocks}>
            {isPending ? (
              <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            ) : (
              <Trash2 data-icon="inline-start" className="size-4" />
            )}
            {isPending ? 'Deleting account…' : 'Delete account forever'}
          </Button>
        </div>

        {errorText && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-destructive">
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
  const { username } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The whole "choose a new password" block — generated by default (docs/account.md),
  // typed-your-own behind the same zxcvbn floor as create-account, which is the point
  // of sharing the component rather than describing it as "the same floor". `username`
  // is the penalty term: it was MISSING here while create-account passed it, so a
  // username-derived password could fail at signup and pass at rotation.
  const newPassword = useNewPassword({ username });
  const proofReady = useRecovery ? recoveryCode !== '' : currentPassword !== '';

  const onSubmit = async (event: React.SubmitEvent) => {
    event.preventDefault();
    // `newPassword.ok` still returns silently: the button IS disabled for it, and
    // legibly so — generated mode blocks on the labelled checkbox in ShowOnceSecret,
    // typed mode on the permanent message line under the field, which is the gate
    // itself. An empty proof field had neither, so it says so instead
    // (docs/account.md, _when a submit is allowed to be `disabled`_). The message
    // lands in the same slot as "Incorrect password." below — same field, same voice.
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
      <>
        <SettingsHeader back={{ label: 'Account', onClick: onBack }} title="Change password" />
        <p className="flex items-start gap-2 text-sm text-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          {SESSION_COPY.passwordChanged}
        </p>
        <p className="text-xs text-muted-foreground">
          This changed how you sign in, but didn’t re-encrypt data you’ve already synced. If your
          old password may have been compromised, a password change alone won’t protect data an
          attacker could already have copied — export your data (
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
        description="You’ll need your current password. There is no email reset, so keep the new one safe."
      />

      <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
        {/* The form holds a `current-password` and a `new-password` and no
            username, so a password manager asked to update a saved login has to
            guess which one — or files the new password as an entry with no name.
            It reads this field instead. */}
        <HiddenUsername username={username} />
        {useRecovery ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="cp-recovery">Recovery code</Label>
            <Input
              id="cp-recovery"
              autoCapitalize="characters"
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

        <NewPasswordField
          control={newPassword}
          copy="change"
          idPrefix="cp"
          disabled={changePassword.isPending}
          onEdit={() => {
            if (error) setError(null);
          }}
        />
        {/* The message belongs to the BUTTON — it's what the press answered with —
            so it rides inside the button's wrapper at `mt-3` rather than standing
            as another item in the form's `gap-4`. Same 12 as DeleteAccountView.
            It has to be nested to get it: a margin on a flex ITEM adds to the
            gap (16 + 12), it doesn't replace it. */}
        <div>
          <Button type="submit" disabled={changePassword.isPending || !newPassword.ok}>
            {changePassword.isPending ? (
              <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            ) : null}
            {changePassword.isPending ? 'Changing…' : 'Change password'}
          </Button>
          {error ? (
            <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        {/* Honest boundary of what a password change is: a door rotation, not a
            DEK rotation (docs/account.md). It re-wraps the same DEK, so anyone
            who already had the old password could have unwrapped that DEK — and
            it stays valid, keeping any ciphertext they exfiltrated readable.
            DEK rotation isn't shipped yet, so the real-compromise remedy is the
            manual export → delete → recreate path. */}
        <p className="mt-2 border-t border-border pt-4 text-xs text-muted-foreground">
          Changing your password replaces how you sign in — it doesn’t re-encrypt data you’ve
          already synced. If you think someone actually had your old password, changing it alone
          won’t protect data they may have already copied. In that case the safe path is to export
          your data (
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
  const { username } = useAuth();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Frozen at mount: a successful mint invalidates the recovery-door query, which
  // flips `hasRecovery` to true underneath us. The copy has to describe the account
  // the user arrived with, not the one this view's own write just produced.
  const [hadRecovery] = useState(hasRecovery);

  const onSubmit = async (event: React.SubmitEvent) => {
    event.preventDefault();
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
          title={RECOVERY_CODE_COPY.title}
          description={
            hadRecovery
              ? RECOVERY_CODE_COPY.description.remint
              : RECOVERY_CODE_COPY.description.mint
          }
        />
        <div className="max-w-sm">
          <ShowOnceSecret
            id="settings-recovery-saved"
            secret={code}
            label={RECOVERY_CODE_COPY.secretLabel}
            saved={saved}
            onSavedChange={setSaved}
            confirmLabel={RECOVERY_CODE_COPY.confirmLabel}
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
        {/* One `current-password` and no username — and this form DISAPPEARS on
            success, replaced by the code, which is the shape a password manager
            reads as a login it should offer to save. Unnamed, that is an entry
            with the username blank. */}
        <HiddenUsername username={username} />
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
        {/* Inside the button's wrapper, at 12 — see ChangePasswordView above for
            why nested rather than a margin on the flex item. */}
        <div>
          <Button type="submit" disabled={recovery.isPending}>
            {recovery.isPending ? (
              <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            ) : null}
            {recovery.isPending
              ? 'Generating…'
              : hadRecovery
                ? 'Generate new code'
                : 'Generate recovery code'}
          </Button>
          {error ? (
            <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>
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
      {/* Description, not a loose paragraph — it was sitting a full 32 below its
          own title. It drops once the job is done, because what stands there then
          is the receipt below, and a screen would otherwise describe an action the
          user has already taken. */}
      <SettingsHeader
        back={{ label: 'Account', onClick: onBack }}
        title="Sign out other devices"
        description={
          done
            ? undefined
            : 'End every other signed-in session — this one stays signed in. Each of the others erases its local copy the next time it connects.'
        }
      />
      {done ? (
        <p className="flex items-start gap-2 text-sm text-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          Your other devices have been signed out. They’ll need to sign in again. This device stays
          signed in.
        </p>
      ) : (
        // Nesting matters most here: there's no form on this view, so the error
        // was a direct child of SettingsPane and wore its `gap-8` — a full 32 below
        // the button that produced it. Inside the wrapper it's the same 12 as the
        // other three views.
        <div>
          <Button onClick={onConfirm} disabled={signOutOthers.isPending}>
            {signOutOthers.isPending ? (
              <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            ) : null}
            {signOutOthers.isPending ? 'Signing out…' : 'Sign out other devices'}
          </Button>
          {error ? (
            <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

export function AccountSection() {
  const { username } = useAuth();
  const [view, setView] = useState<AccountView>('overview');
  const hasRecovery = useHasRecoveryDoor();

  return (
    <SettingsPane viewKey={view}>
      {view === 'overview' ? (
        <>
          <SettingsHeader
            title="Account"
            description="Your account is your username and password. There is no email address on it."
          />

          <SettingsRow title="Username" description={username} />

          {hasRecovery.data === false ? (
            <SettingsNotice icon={<CircleAlert className="size-4" />}>
              <span>
                You haven’t set up a recovery code. Without one, a lost password means a lost
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
