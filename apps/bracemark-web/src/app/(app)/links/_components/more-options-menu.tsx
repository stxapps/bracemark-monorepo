'use client';

// The overflow menu behind the topbar's "More options" button: account- and
// session-level actions that don't warrant their own toolbar slot. Sign out goes
// through the hoisted sign-out flow (@stxapps/web-ui's sign-out-provider), which
// wraps the useSignOut mutation (server revocation, then local wipe) — never the
// bare auth-provider endSession primitive, which only drops the local session.
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
// place a user goes to read status. Its icon carries no colour of its own — it
// is the second line, not a lighter glyph, that marks the row as a report — and
// its dot is full-ink neutral, never destructive, because the cycle completed
// and the local library is intact (@stxapps/shared sync/status.ts,
// `blocked-capacity`).

import {
  CircleAlert,
  CloudOff,
  LifeBuoy,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Settings,
  SquarePen,
} from 'lucide-react';
import Link from 'next/link';

import { getSyncPhase } from '@stxapps/shared';
import { useLocks, useSync } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
import { useSignOutFlow } from '@stxapps/web-ui/contexts/sign-out-provider';

import { SUPPORT_URL } from '../../../../lib/site';
import { DEFAULT_SECTION_ID } from '../../settings/sections';

// `onBulkEdit`: the topbar hands its Bulk edit toggle in here when the bar is too
// narrow to hold it as a button (topbar.tsx, COMPACT_BAR_REM) — present, the menu
// leads with it; absent, the item doesn't exist.
export function MoreOptionsMenu({ onBulkEdit }: { onBulkEdit?: () => void } = {}) {
  const { storeStatus, bgSyncStatus, syncNow } = useSync();
  const { appLock, lockApp } = useLocks();
  const { requestSignOut, signingOut } = useSignOutFlow();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  // Rendered inside InitialSyncGate, so storeStatus is never 'error' here —
  // 'initial-error' and its retryInitialSync belong to the gate's own screen.
  const syncError = phase === 'cycle-error';
  const blocked = phase === 'capacity-blocked';
  // The session expired (docs/sessions.md): sync waits for a sign-in, so the Sync
  // item can't do anything and says so instead of offering a dead press. The
  // resume itself is the notice under the topbar. Dot like blocked — full-ink
  // neutral: changes are waiting, nothing is lost.
  const paused = phase === 'paused';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            syncError
              ? 'More options (sync failed)'
              : blocked
                ? 'More options (storage full)'
                : paused
                  ? 'More options (sync paused)'
                  : 'More options'
          }
        >
          {/* The one glyph on the page that isn't `size-4`. Three dots at the
              vertical centre carry a fraction of the ink of Search or SquarePen
              beside it, so at a matching 16 it reads smaller than they do —
              20 makes it weigh the same. Optical, not a new size step: the
              bulk-edit toolbar's own overflow trigger is bumped to match, since
              that bar swaps into the slot below this one. */}
          <MoreHorizontal className="size-5" />
          {(syncError || blocked || paused) && (
            /* The topbar's dot ladder, ranked by what the mark asks of the user
               rather than by how bad the state sounds: `bg-destructive` (the
               cycle failed — act), `bg-foreground` (blocked — changes are stuck,
               but nothing is lost), and a step below both, `bg-foreground/70` on
               the advanced-search trigger beside this one (filters are on — a
               state the user chose). The last rung is why blocked is full ink
               and not `bg-muted-foreground`: `/70` composites to #545454 on
               light, against muted-foreground's #6f6f6f, so the benign mark of
               the neighbouring pair was reading as the heavier one. Full-ink
               NEUTRAL, though — the "never destructive" rule in the header is
               about hue, and it still holds. */
            <span
              aria-hidden="true"
              className={`absolute top-1.25 right-1.25 size-1.5 rounded-full ${
                syncError ? 'bg-destructive' : 'bg-foreground'
              }`}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      {/* Sized to its longest row, over a floor, rather than a fixed width:
          the rows are short in the common case (~90px of label at most) and
          only "Sync failed — Retry" and the Storage-full row are long, so any
          fixed width wide enough for those is dead space the rest of the
          time. `w-auto` drops the kit's trigger-width default and `min-w-36`
          lowers its `min-w-48` floor, which alone left ~70px dead. */}
      <DropdownMenuContent align="end" className="w-auto min-w-36">
        {onBulkEdit && (
          <>
            <DropdownMenuItem onSelect={onBulkEdit}>
              <SquarePen className="size-4" />
              Bulk edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          disabled={paused}
          onSelect={(e) => {
            // Keep the menu open: the Syncing… → settled transition on this item
            // IS the click's feedback (the engine coalesces, so re-clicks are safe).
            // syncNow, not requestSync: a press is not a local edit, so what it
            // pulls stages behind the refresh pill while the list is engaged.
            e.preventDefault();
            syncNow();
          }}
        >
          {phase === 'syncing' ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Syncing…
            </>
          ) : paused ? (
            <>
              <CloudOff className="size-4" />
              Sync paused
            </>
          ) : syncError ? (
            <>
              {/* Deliberately NOT `text-destructive`, and not `variant="destructive"`
                  either: that variant means the action destroys something (Sign
                  out below, Delete on a link), and this one retries a sync. The
                  red lives on the trigger's dot, where it has to carry the state
                  with the menu shut; in here the label already says it. A red
                  glyph would also be a lie on hover — the item's focus rule
                  (`not-data-[variant=destructive]:focus:**:text-accent-foreground`)
                  recolours every descendant, so `text-destructive` flips to black
                  under the cursor and only `!important` would hold it. */}
              <CircleAlert className="size-4" />
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
              <CircleAlert className="mt-0.5 size-4" />
              <span className="flex min-w-0 flex-col">
                Storage full
                {/* `!` because the item's focus rule recolours every descendant
                    (`not-data-[variant=destructive]:focus:**:text-accent-foreground`
                    — the same trap the Retry glyph above documents), so without it
                    this second line jumps from muted to full ink under the cursor
                    and the two lines flatten to one weight. */}
                <span className="text-xs text-muted-foreground!">Some changes aren’t syncing</span>
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
        {/* The hoisted flow (@stxapps/web-ui's sign-out-provider), not the bare
            useSignOut mutation: it syncs first when a change hasn't, asks about
            what that could not save, and covers the page while the revocation
            request is out — this item is gone the moment it is chosen, so none
            of it could live here. */}
        <DropdownMenuItem
          variant="destructive"
          disabled={signingOut}
          onSelect={() => requestSignOut()}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
