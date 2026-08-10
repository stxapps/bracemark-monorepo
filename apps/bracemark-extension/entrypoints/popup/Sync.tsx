import { ChevronRight } from 'lucide-react';

import {
  formatSyncedAt,
  getSyncPhase,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
  type SyncPhase,
} from '@stxapps/shared';
import { usePendingChangesCount, useSync } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PopupBody, PopupShell } from './Shell';

// The two sync surfaces of the popup: a glanceable pill docked under the save flow
// (SyncPill), and the detail view it opens (SyncDetail). Sync lives here — the popup's
// operational surface — rather than in the Settings page, which is now durable
// configuration only (theme + account). Both read the same useSync() seam bracemark-web
// uses; in the extension the popup provider tree feeds it from the background's
// storage mirror, so there's no separate storage subscription here. The two-field
// status collapses through @stxapps/shared's getSyncPhase, same as bracemark-web's
// Settings→Data card — only the wording differs per surface.

// COLOUR MEANS ATTENTION, and nothing else.
//
// Both apps are achromatic by design — every token in web-ui's sheet is
// `oklch(L 0 0)`, literally zero chroma, which suits a product whose claim is that
// the server sees nothing. The temptation in a status dot is a green "all good",
// and it is the wrong move twice over: it spends the surface's only colour on the
// state that needs no attention, and it trains the eye to expect colour, so the
// red has to shout to be heard over it. So the healthy states are drawn in the
// foreground colour at low opacity, and the only two chromatic pixels in the
// whole extension are the ones that want a click.
//
// What separates "at rest" from "working" is then MOTION, not hue: both are the
// same grey, one darker and pulsing. A hollow ring was tried for the rest state
// and dropped — at 8px a 1px ring all but vanishes, and it vanished worst in the
// dark theme, where the footer needs it most.
const DOT_STYLES: Record<SyncPhase, string> = {
  checking: 'bg-foreground/50 animate-pulse motion-reduce:animate-none',
  'initial-syncing': 'bg-foreground/50 animate-pulse motion-reduce:animate-none',
  syncing: 'bg-foreground/50 animate-pulse motion-reduce:animate-none',
  idle: 'bg-foreground/25',
  'initial-error': 'bg-destructive',
  'cycle-error': 'bg-destructive',
  // Not the error colour: the cycle worked, a limit is what stopped the rest.
  // Red here would point the user at a connection problem instead of the fix
  // (see @stxapps/shared sync/status.ts, `blocked-capacity`).
  'capacity-blocked': 'bg-amber-500',
};

function StatusDot({ phase }: { phase: SyncPhase }) {
  return (
    <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT_STYLES[phase])} />
  );
}

// The pill's line. Shorter than the shared SYNC_PHASE_LABELS because it shares a
// row with the dot and the chevron — and, at rest, more specific than they are:
// "Up to date" is a claim, "Synced 3 min ago" is the evidence for it, which is
// what someone opening a sync pill actually wants to know. The never-synced case
// gets its own wording rather than a stale-looking blank.
function pillLabel(phase: SyncPhase, lastSyncAt: number | null): string {
  switch (phase) {
    case 'checking':
      return 'Checking…';
    case 'initial-syncing':
      return 'Setting up this device…';
    case 'syncing':
      return 'Syncing…';
    case 'initial-error':
    case 'cycle-error':
      return 'Sync failed';
    case 'capacity-blocked':
      return 'Storage full';
    case 'idle':
      return lastSyncAt ? `Synced ${formatSyncedAt(lastSyncAt)}` : 'Not synced yet';
  }
}

export function SyncPill({ onClick }: { onClick: () => void }) {
  const { storeStatus, bgSyncStatus, lastSyncAt } = useSync();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left text-xs',
        'transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
      )}
      onClick={onClick}
    >
      <StatusDot phase={phase} />
      <span className={cn('truncate text-muted-foreground')}>{pillLabel(phase, lastSyncAt)}</span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'ml-auto size-3.5 shrink-0 text-muted-foreground/60',
          'transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none',
        )}
      />
    </button>
  );
}

// One fact per row in a bordered panel — a spec sheet rather than a paragraph.
// The label sits left in muted, the value right in foreground, so the column of
// values can be read down without reading the labels twice.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-3 py-2 text-xs')}>
      <dt className={cn('shrink-0 text-muted-foreground')}>{label}</dt>
      <dd className={cn('min-w-0 truncate text-right font-medium')}>{children}</dd>
    </div>
  );
}

export function SyncDetail({ onBack }: { onBack: () => void }) {
  const { storeStatus, bgSyncStatus, lastSyncAt, lastError, blockedCount, requestSync } = useSync();
  // Queued local edits the next cycle will push — live from the shared Dexie
  // store, not the background's mirror.
  const pendingCount = usePendingChangesCount();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  const lastSync = lastSyncAt ? formatSyncedAt(lastSyncAt) : 'Never';
  // The blocked explanation + its fix, worded per reason in shared so this
  // surface, both Data cards, and any future one can't drift.
  const blockedDetail = syncBlockedDetail(phase, blockedCount);

  // The one action of this screen. `requestSync` (KICK_SYNC → background runSync)
  // covers every actionable phase: it re-runs the initial pull when it hasn't
  // finished and an incremental cycle otherwise, so a single button recovers both
  // error phases as well as a manual idle sync — no separate retryInitialSync (a
  // no-op under the popup's ExternalSyncProvider anyway). Hidden while a cycle is
  // in flight (checking/initial-syncing/syncing) — nothing to trigger.
  const actionLabel =
    phase === 'idle'
      ? 'Sync now'
      : phase === 'initial-error' || phase === 'cycle-error'
        ? 'Retry'
        : null;

  return (
    <PopupShell title="Sync" onBack={onBack}>
      <PopupBody>
        <dl className={cn('divide-y divide-border rounded-lg border border-border')}>
          <DetailRow label="Status">
            <span className={cn('flex items-center justify-end gap-2')}>
              <StatusDot phase={phase} />
              <span className={cn('truncate')}>{SYNC_PHASE_LABELS[phase]}</span>
            </span>
          </DetailRow>
          <DetailRow label="Pending changes">{pendingCount}</DetailRow>
          <DetailRow label="Last sync">{lastSync}</DetailRow>
          {lastError && (
            <DetailRow label="Last error">
              <span className={cn('text-destructive')}>{lastError}</span>
            </DetailRow>
          )}
        </dl>

        {/* Not styled as an error and given no Retry: the cycle completed, and
            only upgrading / freeing space clears this. */}
        {blockedDetail && (
          <p className={cn('wrap-break-words text-xs leading-5 text-muted-foreground')}>
            {blockedDetail}
          </p>
        )}

        {actionLabel && (
          <Button variant="outline" size="sm" onClick={() => requestSync()}>
            {actionLabel}
          </Button>
        )}
      </PopupBody>
    </PopupShell>
  );
}
