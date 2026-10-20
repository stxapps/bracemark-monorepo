import { ChevronRight } from 'lucide-react';

import { SESSION_COPY } from '@stxapps/react';
import {
  formatSyncedAt,
  getSyncPhase,
  initialSyncProgressLabel,
  progressPercent,
  SYNC_CYCLE_STEP_LABELS,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
  syncCycleProgressLabel,
  type SyncPhase,
} from '@stxapps/shared';
import { usePendingChangesCount, useSync } from '@stxapps/web-react';
import { ProgressMeter } from '@stxapps/web-ui/components/progress-meter';
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
// the server can't read your library. The temptation in a status dot is a green "all good",
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
  // The session expired: nothing failed and nothing is lost, but it wants a
  // click — a sign-in — so it takes the attention colour, not the error one.
  paused: 'bg-amber-500',
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
    case 'paused':
      return 'Sync paused — sign in to resume';
    case 'idle':
      return lastSyncAt ? `Synced ${formatSyncedAt(lastSyncAt)}` : 'Not synced yet';
  }
}

// What a run in flight can say with numbers, read once for both surfaces: the
// first sync's count while the store is still being set up, a background
// cycle's leg while one is moving something. Null for every other phase — a
// value the provider still holds once the phase has moved on is not a readout.
interface SyncReadout {
  // The line naming what is happening ("Setting up this device…").
  what: string;
  // The progressbar's accessible name: that line without its ellipsis.
  label: string;
  done: number;
  total: number;
  // "1,240 of 3,600 items"
  count: string;
}

function useSyncReadout(phase: SyncPhase): SyncReadout | null {
  const { initialSyncProgress, syncProgress } = useSync();
  if (phase === 'initial-syncing' && initialSyncProgress) {
    const what = SYNC_PHASE_LABELS['initial-syncing'];
    return {
      what,
      label: what.replace(/…$/, ''),
      ...initialSyncProgress,
      count: initialSyncProgressLabel(initialSyncProgress),
    };
  }
  if (phase === 'syncing' && syncProgress) {
    const what = SYNC_CYCLE_STEP_LABELS[syncProgress.step];
    return {
      what,
      label: what.replace(/…$/, ''),
      done: syncProgress.done,
      total: syncProgress.total,
      count: syncCycleProgressLabel(syncProgress),
    };
  }
  return null;
}

// The pill's progress. Two things carry it, both at the pill's own scale: the
// percent beside the label, and the pill's top hairline — the border that
// separates it from the save flow — filling left to right as the run goes. The
// hairline is the footer's existing line, not a new element on the screen, so
// at rest the pill is exactly what it was. The full count is the detail view's;
// at 12px beside the label it would truncate the very words that say what is
// happening.
export function SyncPill({ onClick }: { onClick: () => void }) {
  const { storeStatus, bgSyncStatus, lastSyncAt } = useSync();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  const readout = useSyncReadout(phase);

  return (
    <button
      type="button"
      className={cn(
        'group relative flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left text-xs',
        'transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
      )}
      onClick={onClick}
    >
      {/* Over the border-t, 1px tall: decorative, since the button's own text
          already says the percent, and the detail view carries the real
          progressbar. Same glide as ProgressMeter's fill. */}
      {readout && (
        <span aria-hidden="true" className="absolute inset-x-0 -top-px h-px overflow-hidden">
          <span
            className="block h-full w-full bg-foreground/50 transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{
              transform: `translateX(-${(1 - Math.min(1, readout.done / readout.total)) * 100}%)`,
            }}
          />
        </span>
      )}
      <StatusDot phase={phase} />
      <span className={cn('truncate text-muted-foreground')}>{pillLabel(phase, lastSyncAt)}</span>
      {readout && (
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {progressPercent(readout.done, readout.total)}%
        </span>
      )}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground',
          !readout && 'ml-auto',
          'transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none',
        )}
      />
    </button>
  );
}

// One fact per row in a bordered panel — a spec sheet rather than a paragraph.
// The label sits left in muted, the value right in foreground, so the column of
// values can be read down without reading the labels twice.
//
// Stays at the popup's 12px caption tier (browser-extension.md, the `dense`
// label bullet) — the whole panel is labels and values, and 14px here would put
// the medium-weight `dd` at PopupTitle's exact size and weight. The panel read
// cramped because it is one unbroken 12px block, so the air comes from row
// padding instead: don't trade it back for a size step. No `leading-*` — every
// row is single-line (`truncate`), so line-height would only pad the box again.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-3 py-2.5 text-xs')}>
      <dt className={cn('shrink-0 text-muted-foreground')}>{label}</dt>
      <dd className={cn('min-w-0 truncate text-right font-medium')}>{children}</dd>
    </div>
  );
}

export function SyncDetail({ onBack, onResume }: { onBack: () => void; onResume: () => void }) {
  const { storeStatus, bgSyncStatus, lastSyncAt, lastError, blockedCount, requestSync } = useSync();
  // Queued local edits the next cycle will push — live from the shared Dexie
  // store, not the background's mirror.
  const pendingCount = usePendingChangesCount();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  const lastSync = lastSyncAt ? formatSyncedAt(lastSyncAt) : 'Never';
  // The blocked explanation + its fix, worded per reason in shared so this
  // surface, both Data cards, and any future one can't drift.
  const blockedDetail = syncBlockedDetail(phase, blockedCount);
  const readout = useSyncReadout(phase);
  // The first sync's listing: real work with no denominator yet. Drawn as the
  // meter's indeterminate track with a line saying what it is, so the screen is
  // never the bare "Setting up…" it used to be for however long the pull took.
  const listing = phase === 'initial-syncing' && !readout;

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
              <span className={cn('truncate')}>{readout?.what ?? SYNC_PHASE_LABELS[phase]}</span>
            </span>
          </DetailRow>
          {/* The how-far under the what: a full-width row, since a bar can't sit
              in the right-hand value column. The `dt` is for the list's
              structure; the meter names itself. */}
          {(readout || listing) && (
            <div className={cn('px-3 py-3')}>
              <dt className="sr-only">Progress</dt>
              <dd>
                {readout ? (
                  <ProgressMeter
                    label={readout.label}
                    done={readout.done}
                    total={readout.total}
                    valueText={readout.count}
                  />
                ) : (
                  <ProgressMeter label="Finding your links" valueText="Finding your links…" />
                )}
              </dd>
            </div>
          )}
          <DetailRow label="Pending changes">{pendingCount}</DetailRow>
          <DetailRow label="Last sync">{lastSync}</DetailRow>
          {lastError && (
            <DetailRow label="Last error">
              <span className={cn('text-destructive')}>{lastError}</span>
            </DetailRow>
          )}
        </dl>

        {/* Standing prose, not an announcement — on screen from the moment the
            pull is. Without it a first sync reads as something to sit and watch:
            the popup is the only window onto it, and nothing said that closing
            it doesn't stop it (the worker runs it), or that an interrupted pull
            resumes (storeDownloads' staleness skip) rather than starting over. */}
        {phase === 'initial-syncing' && (
          <p className={cn('text-xs leading-5 text-muted-foreground')}>
            You can close this popup — syncing carries on, and picks up where it left off if it’s
            interrupted.
          </p>
        )}

        {/* Not styled as an error and given no Retry: the cycle completed, and
            only upgrading / freeing space clears this. */}
        {blockedDetail && (
          <p className={cn('wrap-break-words text-xs leading-5 text-muted-foreground')}>
            {blockedDetail}
          </p>
        )}

        {/* The expired session (docs/sessions.md): what is true, then the one
            fix. A status, not an alert — the user didn't cause it. */}
        {phase === 'paused' && (
          <>
            <p role="status" className={cn('text-xs leading-5 text-muted-foreground')}>
              {SESSION_COPY.paused.description}
            </p>
            <Button size="sm" onClick={onResume}>
              {SESSION_COPY.paused.resume}
            </Button>
          </>
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
