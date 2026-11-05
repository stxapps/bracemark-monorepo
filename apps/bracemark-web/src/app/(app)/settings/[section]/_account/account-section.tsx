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
  hasRecoveryDoorQueryOptions,
  NEW_PASSWORD_COPY,
  RECOVERY_CODE_COPY,
  SESSION_COPY,
  useApiClient,
  useSignOutOthers,
} from '@stxapps/react';
import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  SubscriptionActiveError,
  UnconfirmedSaveError,
  useAuth,
  useChangePassword,
  useDeleteAccount,
  useEntitlements,
  useHasRecoveryDoor,
  useRecoveryCode,
} from '@stxapps/web-react';
import { CopySecretButton } from '@stxapps/web-ui/components/auth/copy-secret-button';
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
        {/* Fresh proof, not just the session: the server only accepts this call
            signed by a key the password unwraps, so the password is required
            here even though you're signed in.
            ⚠ `one-time-code`, NOT `current-password`, and no HiddenUsername. This
            form goes away because the account is gone, and as a `current-password`
            Chrome offered to save it after the delete, with the hidden username
            and without it alike: a saved login for an account that no longer
            exists. `one-time-code` makes Chrome's parse fallback-only, so it asks
            nothing, and a click on the field still lists the saved logins to fill
            (docs/password-manager.md, _a password that only proves who you are_;
            `measure:password-manager`, flow `delete-account`). */}
        <div className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="delete-account-password">Confirm your password</Label>
          <PasswordInput
            id="delete-account-password"
            autoComplete="one-time-code"
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
  const [showNew, setShowNew] = useState(false);

  // Create-account's field, the same one: generated words already in a real
  // `new-password` input, editable into your own behind the same floors, which is the
  // point of sharing it rather than describing it as "the same floor". `username` is
  // the penalty term: it was MISSING here while create-account passed it, so a
  // username-derived password could fail at signup and pass at rotation.
  // Compared against the current password only when that is the proof: on the
  // recovery-code path the user has said they don’t know it, and whatever is left
  // over from the password field is not what they are rotating away from.
  const newPassword = useNewPassword({
    username,
    currentPassword: useRecovery ? undefined : currentPassword,
  });
  const proofReady = useRecovery ? recoveryCode !== '' : currentPassword !== '';

  const onSubmit = async (event: React.SubmitEvent) => {
    event.preventDefault();
    // `newPassword.ok` still returns silently: the button IS disabled for it, and
    // legibly so — the permanent message line under the field is the gate itself.
    // An empty proof field has no such line, so it says so instead
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
      // No answer, and the hook could not reach the server to settle it either (it
      // tests the new password against the door first: use-change-password.ts). So
      // say it is unknown, and that a retry is safe: if the change landed, the retry
      // finds the new password already opening and ends on the done screen.
      else if (err instanceof UnconfirmedSaveError) {
        setError(
          'We didn’t get an answer, so we can’t tell yet whether your password changed. Check your connection and try again.',
        );
      } else setError('Could not change your password. Please try again.');
    }
  };

  // THE SAVE IS ASKED FOR HERE, AFTER THE CHANGE, and not by a checkbox before it. A
  // password manager offers its update only once the submit has landed and this form
  // is gone, so "I've saved it" ticked beforehand was a promise, not a fact. So this
  // screen says what to do with that offer, and keeps the new password one press away
  // until the user leaves: someone who declined the update, or uses no manager, is
  // told and not stranded. It is the welcome's "Show it again" in the place a
  // change can have one. There is no check as the welcome has: the manager
  // holds the OLD password for this username, so a login-shaped check would be
  // offered that one (docs/account.md, _changing a password_).
  //
  // ONE SHAPE WITH RECOVERY CODE'S DONE SCREEN, because the two do the same job:
  // confirm what already happened (the ✓ line), say what to do (one muted line), hand
  // over the secret, then Done. They differ in one place, on purpose: the recovery code
  // is shown at once, since no manager saves it and seeing it IS the task, while the
  // new password waits behind a toggle, since its save is the manager's update offer
  // and showing it unasked puts the account password on screen for whoever is nearby.
  if (done) {
    return (
      <>
        <SettingsHeader back={{ label: 'Account', onClick: onBack }} title="Change password" />
        <div className="flex max-w-sm flex-col gap-3">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            {SESSION_COPY.passwordChanged}
          </p>
          <p className="text-sm text-muted-foreground">{NEW_PASSWORD_COPY.afterChange}</p>
          {/* A `button` with `aria-expanded`, as the welcome's "Show it again". The
              `after:` slop is its target (docs/accessibility.md, _a web target on a
              touch screen_): what sits around it takes no tap. */}
          <button
            type="button"
            aria-expanded={showNew}
            onClick={() => setShowNew((shown) => !shown)}
            className="relative self-start text-sm text-muted-foreground underline after:absolute after:-inset-x-2 after:-inset-y-3 hover:text-foreground"
          >
            {NEW_PASSWORD_COPY.showNew}
          </button>
          {showNew ? (
            <>
              <output
                aria-label={NEW_PASSWORD_COPY.shownLabel}
                className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
              >
                {newPassword.password}
              </output>
              <CopySecretButton secret={newPassword.password} />
            </>
          ) : null}
          {/* `mt-3` makes it 24 below whatever is last, so the toggle's 12px slop takes
              exactly half the gap (docs/accessibility.md, _a web target on a touch
              screen_). */}
          <Button className="mt-3 self-start" onClick={onBack}>
            Done
          </Button>
        </div>
        {/* Background reading, so it comes after the way out, under the same hairline
            the form puts it beneath. */}
        <p className="max-w-sm border-t border-border pt-4 text-xs text-muted-foreground">
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
          id="cp-new-password"
          label={NEW_PASSWORD_COPY.label}
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
function RecoveryCodeView({
  onBack,
  hasRecovery,
}: {
  onBack: () => void;
  // `undefined` while the lookup is in flight, which is not the same as `false`.
  hasRecovery: boolean | undefined;
}) {
  const recovery = useRecoveryCode();
  const { username } = useAuth();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const api = useApiClient();
  // FROZEN AT THE MINT, NOT AT MOUNT. A successful mint sets the recovery-door query
  // to true underneath us, and the copy has to describe the account as it was before
  // this view's own write. But freezing at mount froze whatever the lookup had said
  // by then, and on a slow network that was nothing yet, read as "no code": a user
  // who opened this right after a load saw "Set up a recovery code" with no warning
  // that their existing one would stop working, then "set up" instead of "replaced"
  // (WEB-ACCOUNT-008, on staging; WEB-ACCOUNT-010 holds the lookup locally). So until
  // a mint starts the copy follows the lookup, warning while it is unknown, and the
  // submit waits for its answer.
  const [hadAtMint, setHadAtMint] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const hadRecovery = hadAtMint ?? hasRecovery ?? true;
  const busy = starting || recovery.isPending;

  const onSubmit = async (event: React.SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    // Empty answers out loud rather than holding the button down; the slot below
    // the button is the same one "Incorrect password." uses.
    if (currentPassword === '') {
      setError('Enter your current password.');
      return;
    }
    setError(null);
    // The lookup's answer, waited for if it is still in flight (the same request, not
    // a second one). A failed lookup is read as "had one": the warning is the safe
    // side of a guess.
    setStarting(true);
    const had =
      hasRecovery ??
      (await queryClient
        .ensureQueryData(hasRecoveryDoorQueryOptions(api, username))
        .catch(() => true));
    setHadAtMint(had);
    setStarting(false);
    try {
      const result = await recovery.mutateAsync({
        proof: { kind: 'password', currentPassword },
      });
      setCode(result.recoveryCode);
      // The mint landed, so the door exists: say so in the cache at once, then refresh.
      // Invalidating alone left a window, until the refetch answered, where the
      // overview still showed its "no recovery code" nudge and a second visit here
      // froze `hadRecovery` as false: "Generate recovery code" with no warning that the
      // code just made would stop working, then "set up" instead of "replaced".
      queryClient.setQueryData([...hasRecoveryDoorQueryKey, username], true);
      void queryClient.invalidateQueries({ queryKey: hasRecoveryDoorQueryKey });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) setError('Incorrect password.');
      // The save went out and nothing came back. If it landed, the old code is dead
      // and the new one was never shown, so the only safe act is another one.
      else if (err instanceof UnconfirmedSaveError) {
        // It may have landed, so the door may exist now whatever the lookup said.
        void queryClient.invalidateQueries({ queryKey: hasRecoveryDoorQueryKey });
        setError(
          'We didn’t get an answer, so your old recovery code may no longer work. Generate a new one now.',
        );
      } else setError('Could not generate a recovery code. Please try again.');
    }
  };

  // THE CODE IS LIVE BY THE TIME THIS RENDERS, and the screen says so first. It used to
  // gate a "Done" on an "I've saved it" tick with no back link, as friction against
  // leaving unsaved, and that read as a confirm step: a user could take the code to
  // count only once ticked. Leaving without saving is a chore rather than a loss, since
  // anyone who can still sign in mints another here, so the way out is ordinary and
  // the line under the code says what to do if they didn't save it. The welcome after
  // create-account shows its code the same way, for the same reason.
  if (code) {
    return (
      <>
        <SettingsHeader
          back={{ label: 'Account', onClick: onBack }}
          title={RECOVERY_CODE_COPY.title}
        />
        {/* Change password's done screen in shape (its note has why), and Sign out
            other devices' in its first line: the ✓ states the outcome in the body,
            where the other two done screens in Account already put theirs. */}
        <div className="flex max-w-sm flex-col gap-3">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            {hadRecovery ? RECOVERY_CODE_COPY.minted.replaced : RECOVERY_CODE_COPY.minted.first}
          </p>
          <p className="text-sm text-muted-foreground">{RECOVERY_CODE_COPY.saveIt}</p>
          <ShowOnceSecret secret={code} label={RECOVERY_CODE_COPY.secretLabel} />
          <p className="text-sm text-muted-foreground">{RECOVERY_CODE_COPY.shownOnce}</p>
          <Button className="mt-3 self-start" onClick={onBack}>
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
        {/* ⚠ `one-time-code` and no HiddenUsername, as on delete account. The
            password here only proves who you are; it is not new, so there is
            nothing to save. As a `current-password` beside the account's name,
            Chrome offered to save it as the form went away, replaced by the code,
            which reads as saving the code. `one-time-code` makes Chrome's parse
            fallback-only, so it asks nothing, and a click on the field still lists
            the saved logins to fill (docs/password-manager.md, _a password that
            only proves who you are_). */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="rc-current">Current password</Label>
          <PasswordInput
            id="rc-current"
            autoComplete="one-time-code"
            value={currentPassword}
            disabled={busy}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        {/* Inside the button's wrapper, at 12 — see ChangePasswordView above for
            why nested rather than a margin on the flex item. */}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 data-icon="inline-start" className="size-4 animate-spin" /> : null}
            {busy ? 'Generating…' : hadRecovery ? 'Generate new code' : 'Generate recovery code'}
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
                  className="relative underline after:absolute after:-inset-x-1 after:-inset-y-3 hover:text-foreground"
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
        <RecoveryCodeView onBack={() => setView('overview')} hasRecovery={hasRecovery.data} />
      ) : view === 'sign-out-others' ? (
        <SignOutOtherDevicesView onBack={() => setView('overview')} />
      ) : (
        <DeleteAccountView onBack={() => setView('overview')} />
      )}
    </SettingsPane>
  );
}
