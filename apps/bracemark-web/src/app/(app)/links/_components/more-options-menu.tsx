'use client';

// The overflow menu behind the topbar's "More options" button: account- and
// session-level actions that don't warrant their own toolbar slot. Sign out goes
// through the useSignOut mutation (server revocation, then local wipe) rather
// than the bare auth-provider endSession primitive, which only drops the local
// session.
//
// The Sync item adapts to the sync phase, and a failed cycle also surfaces as a
// dot on the trigger — the topbar is the links page's only always-visible sync
// error surface (the full status card lives in Settings → Data). Only STANDING
// states get the dot: a spinner there would flicker on every edit's sub-second
// cycle.
//
// 'capacity-blocked' is the one phase the Sync ITEM doesn't absorb. Its two
// variants re-label the same action by what pressing it will do (Syncing… = in
// flight, Retry = press to fix); blocked is the phase where pressing changes
// nothing, so it stays the plain "Sync" it always was (still the right action
// once space is freed) and the state gets its own row instead — a LINK to
// Settings → Data, not a copy of what that card says. This menu is a launcher,
// not a status readout: it names the state and the fact that changes are
// stuck, and the sentence with the count (syncBlockedDetail) stays in the one
// place a user goes to read status. Its dot and its icon are muted, never
// destructive — the cycle completed and the local library is intact
// (@stxapps/shared sync/status.ts, `blocked-capacity`).

import {
  CircleAlert,
  LifeBuoy,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Settings,
} from 'lucide-react';
import Link from 'next/link';

import { getSyncPhase } from '@stxapps/shared';
import { useLocks, useSignOut, useSync } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';

import { SUPPORT_URL } from '../../../../lib/site';
import { DEFAULT_SECTION_ID } from '../../settings/sections';

export function MoreOptionsMenu() {
  const { storeStatus, bgSyncStatus, requestSync } = useSync();
  const { appLock, lockApp } = useLocks();
  const signOut = useSignOut();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  // Rendered inside InitialSyncGate, so storeStatus is never 'error' here —
  // 'initial-error' and its retryInitialSync belong to the gate's own screen.
  const syncError = phase === 'cycle-error';
  const blocked = phase === 'capacity-blocked';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={
            syncError
              ? 'More options (sync failed)'
              : blocked
                ? 'More options (storage full)'
                : 'More options'
          }
        >
          <MoreHorizontal className="size-4" />
          {(syncError || blocked) && (
            <span
              aria-hidden="true"
              className={`absolute top-1 right-1 size-1.5 rounded-full ${
                syncError ? 'bg-destructive' : 'bg-muted-foreground'
              }`}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onSelect={(e) => {
            // Keep the menu open: the Syncing… → settled transition on this item
            // IS the click's feedback (requestSync coalesces, so re-clicks are safe).
            e.preventDefault();
            requestSync();
          }}
        >
          {phase === 'syncing' ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Syncing…
            </>
          ) : syncError ? (
            <>
              <CircleAlert className="size-4 text-destructive" />
              Sync failed — Retry
            </>
          ) : (
            <>
              <RefreshCw className="size-4" />
              Sync
            </>
          )}
        </DropdownMenuItem>
        {/* Only while blocked. Deliberately below Sync and not styled as an
            error: it reports, it doesn't interrupt (the hoisted paywall dialog
            is for actions being refused). Tapping it goes where the count and
            the fix are spelled out. */}
        {blocked && (
          <DropdownMenuItem asChild>
            <Link href="/settings/data" className="items-start">
              <CircleAlert className="mt-0.5 size-4 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                Storage full
                <span className="text-xs text-muted-foreground">Some changes aren’t syncing</span>
              </span>
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/settings/${DEFAULT_SECTION_ID}`}>
            <Settings className="size-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        {/* Support lives on the marketing site (the apex), not in this app — hence
            an absolute cross-origin URL, not a next/link to `/support`. */}
        <DropdownMenuItem asChild>
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
            <LifeBuoy className="size-4" />
            Support
          </a>
        </DropdownMenuItem>
        {/* Re-engage the device-local app lock without a reload. Only when one is
            SET and currently open — the app-global peer of the sidebar rows'
            per-list "Lock now" (the app lock isn't a list, so this menu, not the
            rail, is its home). AppLockGate closes on the spot. */}
        {appLock.exists && appLock.unlocked && (
          <DropdownMenuItem onSelect={() => lockApp()}>
            <Lock className="size-4" />
            Lock app
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={signOut.isPending}
          onSelect={() => signOut.mutate()}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
