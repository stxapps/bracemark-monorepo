// The overflow menu behind the topbar's ⋯ button — the expo port of bracemark-web's
// MoreOptionsMenu (`(app)/links/_components/more-options-menu.tsx`, the
// canonical doc): account-
// and session-level actions that don't warrant their own topbar slot, with the
// same phase-adaptive Sync entry and the error dot on the trigger — still the
// links screen's only always-visible sync-error surface (pull-to-refresh gives
// the gesture but no error affordance; the full status card lives in Settings →
// Data). Only STANDING states get the dot: a spinner there would flicker
// on every edit's sub-second cycle — and the blocked dot is full-ink neutral,
// never destructive, since the cycle completed and the library is intact. Web's
// "Storage full" row is here too, same reasoning (the Sync item keeps its plain
// label because a press still can't clear a full account; the row LINKS to the
// Data card rather than repeating its sentence). Divergences here:
//
//  - Selecting Sync CLOSES the menu (web keeps it open so the Syncing… → settled
//    transition is the click's feedback) — holding a native dropdown open works
//    against the platform idiom, so the trigger's error dot (or its absence) is
//    the outcome surface instead. requestSync coalesces, so re-taps are safe.
//  - Web's Bulk edit lives OUTSIDE the menu (its own topbar toggle); a phone
//    topbar has no slot to spare, so it lives here as "Select links" — entering
//    the mode only (never a toggle: while the mode is on, the bulk bar's ✕ and
//    the Android back press are the exits, and this menu is still reachable).
//  - Support opens a page in the system browser. It lives on the MARKETING SITE
//    (bracemark-site, the apex — docs/hosting.md), not in bracemark-web: the
//    app has no /support route and never had one. The URL comes from lib/site.ts,
//    which owns the origin (EXPO_PUBLIC_SITE_URL) for every off-app page; the
//    full index of them is Settings → About.

import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  CircleAlert,
  LifeBuoy,
  Lock,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Settings,
  SquareCheckBig,
} from 'lucide-react-native';

import { useLocks, useSignOut, useSync } from '@stxapps/expo-react';
import { getSyncPhase } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { SUPPORT_URL } from '../../lib/site';
import { cn } from '../../lib/utils';
import { useLinksViewState } from './view-state-provider';

export function MoreOptionsMenu() {
  const { storeStatus, bgSyncStatus, requestSync } = useSync();
  const { appLock, lockApp } = useLocks();
  const { enterBulkEdit } = useLinksViewState();
  const signOut = useSignOut();
  const router = useRouter();
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
          aria-label={
            syncError
              ? 'More options (sync failed)'
              : blocked
                ? 'More options (storage full)'
                : 'More options'
          }
          // `left: 2` is half the `gap-1` to the search toggle (topbar.tsx's
          // drawer button carries the rule); `right: 8` is the clearance this
          // one's `-mr-1` leaves to the frame edge, so the slop stops at the
          // screen rather than spilling past it. 46x48 effective.
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 8 }}
          // `icon-sm` (36 on a phone) and pulled to the frame edge, matching
          // every other icon button on both topbars (links and settings) — this
          // is the last slot in the row, so it sets where the bar's right edge
          // reads.
          className="relative -mr-1"
        >
          <Icon as={MoreHorizontal} className="size-5 text-foreground" />
          {(syncError || blocked) && (
            <View
              aria-hidden
              // 5px in (`1.25`), not 4: a size-5 glyph centred in a size-9 box
              // leaves 8 free on each side, and at 4 the dot floats off the mark
              // it belongs to instead of annotating it. Same inset as the search
              // bar's advanced-filter dot, which sits in a larger (size-10)
              // button — the dot tracks the glyph, not the button — and the same
              // as web's pair, so all four agree on one value. Web is FORCED to
              // 1.25 from both sides: its triggers are round (`rounded-4xl` on a
              // 36px box clamps to a circle, which is what the ghost hover
              // fills), so 1 puts the dot's rim outside that circle while 1.5
              // crowds the glyph. This trigger is now the same circle — the kit
              // took web's radii (docs/theme.md, _the radius scale_) — so it is
              // forced from both sides in exactly the same way, which is one
              // fewer reason for the four to drift apart.
              //
              // Colour is web's ladder, ranked by what the mark asks of the user:
              // `bg-destructive` (the cycle failed — act), `bg-foreground`
              // (blocked — changes are stuck, but nothing is lost), and below
              // both, `bg-foreground/70` on the search bar's advanced-filter dot
              // (a state the user chose). Blocked is full ink rather than
              // `bg-muted-foreground` so it can't read quieter than that benign
              // neighbour; NEUTRAL still, which is all "never destructive" asks.
              className={cn(
                'absolute top-1.25 right-1.25 size-1.5 rounded-full',
                syncError ? 'bg-destructive' : 'bg-foreground',
              )}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onPress={requestSync}>
          {syncError ? (
            <>
              {/* No `text-destructive`, matching web: that colour is for actions
                  that destroy something (Sign out below), and this one retries a
                  sync. The red lives on the trigger's dot, where it carries the
                  state with the menu shut; here the label already says it. */}
              <Icon as={CircleAlert} className="size-4" />
              <Text>Sync failed — Retry</Text>
            </>
          ) : (
            <>
              <Icon as={RefreshCw} className="size-4" />
              <Text>{phase === 'syncing' ? 'Syncing…' : 'Sync'}</Text>
            </>
          )}
        </DropdownMenuItem>
        {/* Only while blocked. Reports, never interrupts (the hoisted paywall
            dialog is for actions being refused) — tapping it goes where the
            count and the fix are spelled out. */}
        {blocked && (
          <DropdownMenuItem className="items-start" onPress={() => router.push('/settings/data')}>
            <Icon as={CircleAlert} className="mt-0.5 size-4" />
            <View className="min-w-0 flex-1">
              <Text>Storage full</Text>
              <Text className="text-xs text-muted-foreground">Some changes aren’t syncing</Text>
            </View>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onPress={enterBulkEdit}>
          <Icon as={SquareCheckBig} className="size-4" />
          <Text>Select links</Text>
        </DropdownMenuItem>
        <DropdownMenuItem onPress={() => router.push('/settings')}>
          <Icon as={Settings} className="size-4" />
          <Text>Settings</Text>
        </DropdownMenuItem>
        <DropdownMenuItem onPress={() => void Linking.openURL(SUPPORT_URL)}>
          <Icon as={LifeBuoy} className="size-4" />
          <Text>Support</Text>
        </DropdownMenuItem>
        {/* Re-engage the device-local app lock without a relaunch. Only when one
            is SET and currently open — the app-global peer of the sidebar rows'
            per-list "Lock now" (the app lock isn't a list, so this menu, not the
            drawer, is its home). AppLockGate closes on the spot. Web parity:
            MoreOptionsMenu's "Lock app". */}
        {appLock.exists && appLock.unlocked && (
          <DropdownMenuItem onPress={lockApp}>
            <Icon as={Lock} className="size-4" />
            <Text>Lock app</Text>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {/* useSignOut: server revocation (best-effort), then the local wipe —
            never the bare endSession primitive, which only drops the session. */}
        <DropdownMenuItem
          variant="destructive"
          disabled={signOut.isPending}
          onPress={() => signOut.mutate()}
        >
          <Icon as={LogOut} className="size-4" />
          <Text>Sign out</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
