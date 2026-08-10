// The sync state VOCABULARY, shared across every client (web, extension, and the
// future native app) — pure data + pure derivation, no React and no browser API,
// so a native client that re-implements the platform-web engine still speaks the
// same status language. The concrete providers (web-react's SyncProvider /
// ExternalSyncProvider, and whatever a native app writes) produce these two
// fields; this module owns the collapse into one phase and the default labels.

// Sync state is TWO dimensions, kept as two fields rather than one enum:
//   storeStatus  — the gate: can the app render local data at all? Durable; once
//                  'ready' it stays 'ready' while cycles come and go.
//   bgSyncStatus — the indicator: health of the current/last background cycle. A
//                  failed background cycle coexists with a usable store (that's
//                  the point of local-first), so it must not leave 'ready'.

// The gate's phases — named for the LOCAL STORE, not the sync runs: on a
// returning visit no initial sync runs at all, yet the store is 'ready'.
export type StoreStatus =
  | 'checking' // reading the flag from the local store
  | 'syncing-initial' // first-ever pull on this device, UI is blocked
  | 'ready' // local store is usable; background sync may still be running
  | 'error'; // initial pull failed; offer retry

// The indicator's phases. Only post-'ready' cycles report here — while the gate
// blocks, the decrypting screen IS the progress UI.
export type BgSyncStatus =
  | 'idle' // no cycle in flight; the last one (if any) succeeded
  | 'syncing' // a background cycle is in flight
  // The cycle COMPLETED, but the server refused part of the push at files/sign.
  // Deliberately NOT 'error': everything else pulled, pushed and committed, the
  // local store is correct, and nothing is retryable by pressing a button — only
  // freeing space clears it. Calling that "Sync failed" would send a user hunting
  // for a network problem they don't have.
  //
  // ONE blocked status, because bracemark-api now has ONE refusal:
  // `quota_exceeded`, the byte/object backstop every plan shares (lib/quota.ts).
  // There used to be a second, `upgrade_required` for the free tier's link cap,
  // with its own status because the two wanted opposite advice — "upgrade" vs
  // "delete something", and sending a paying customer who is out of storage to
  // the subscription page helps nobody. The link cap moved to the create
  // surfaces, so an over-cap save is now refused BEFORE
  // it is written and never becomes a pending op at all — there is no partial
  // push to report, and no plan-blocked state to be in.
  | 'blocked-capacity'
  | 'error'; // the last cycle failed; requestSync retries (flips back to 'syncing')

// What a completed cycle learned beyond "it worked" — the engines' return value,
// read by each platform's SyncProvider to pick its bgSyncStatus. Shared so the
// two sibling engines (web-react, expo-react) and their providers can't drift on
// the meaning.
//
// Collected as a MUTABLE accumulator threaded down the push chain (the cycles →
// pushPending → pushPuts → signPushable) rather than bubbled up through return
// types: the refusal is learned four frames below the only caller that reports
// it, and every frame in between already returns something else. Adding a field
// here costs one write at the bottom instead of a wider tuple in each frame.
export interface SyncOutcome {
  // Whether the quota gate refused any part of the push. The cycle still
  // completed either way: pulls landed, deletes committed, and every put the
  // gate didn't refuse was uploaded — so this is a state to SURFACE, not a
  // failure to retry. It clears by itself on the next cycle once the account is
  // back under its limits.
  //
  // A boolean rather than a reason, because there is only one refusal left to
  // name (see BgSyncStatus). Kept separate from `blockedCount` rather than
  // inferred from it so the two stay independently truthful — a surface reading
  // a restored mirror can know it is blocked without a trustworthy count.
  blocked: boolean;
  // How many pending ops the gate refused this cycle — the "12 links aren't
  // syncing" detail. NOT the pending-queue length: that also counts ops which
  // simply haven't been reached yet, so it would overstate the problem.
  blockedCount: number;
}

// A fresh accumulator for one cycle.
export function emptySyncOutcome(): SyncOutcome {
  return { blocked: false, blockedCount: 0 };
}

// Record one refusal onto the cycle's accumulator. Owned here, not written out
// in each engine, so the two siblings can't drift on how a cycle that hits the
// gate more than once accumulates.
export function recordBlocked(outcome: SyncOutcome, count: number): void {
  outcome.blocked = true;
  outcome.blockedCount += count;
}

// The indicator a COMPLETED cycle settles to. Owned here so both providers turn
// an outcome into a status identically.
export function bgStatusForOutcome(outcome: SyncOutcome): BgSyncStatus {
  return outcome.blocked ? 'blocked-capacity' : 'idle';
}

// The collapsed one-dimensional phase, in priority order: the gate (store)
// outranks the indicator (bg) — while the store is still checking/pulling/failed
// there's no background cycle to report (cycles only run post-'ready').
export type SyncPhase =
  | 'checking' // reading the first-sync flag from the local store
  | 'initial-syncing' // first-ever pull on this device
  | 'initial-error' // initial pull failed → retryInitialSync
  | 'syncing' // a background cycle is in flight
  | 'cycle-error' // the last background cycle failed → requestSync retries
  | 'capacity-blocked' // cycle fine, but the byte/object quota refused part of it
  | 'idle'; // settled; the last cycle (if any) succeeded

// Shared derivation of the user-facing sync status. Every status surface —
// bracemark-web's Settings→Data card, the extension popup's pill and detail view —
// collapses the two fields into ONE phase the same way. This owns that collapse
// so the surfaces can't drift; each surface still picks its own presentation
// (icons, actions, short pill labels) on top of the phase.
export function getSyncPhase(store: StoreStatus, bg: BgSyncStatus): SyncPhase {
  if (store === 'checking') return 'checking';
  if (store === 'syncing-initial') return 'initial-syncing';
  if (store === 'error') return 'initial-error';
  if (bg === 'syncing') return 'syncing';
  if (bg === 'error') return 'cycle-error';
  // After 'error': a cycle that both failed AND hit the quota gate is reported
  // as failed, since the failure is the part a retry can still fix.
  if (bg === 'blocked-capacity') return 'capacity-blocked';
  return 'idle';
}

// The default user-facing label per phase. Surfaces may override where they
// have better information (e.g. "Last synced 5 min ago" instead of idle's
// "Up to date" when lastSyncAt is known).
export const SYNC_PHASE_LABELS: Record<SyncPhase, string> = {
  checking: 'Checking your data…',
  'initial-syncing': 'Setting up this device…',
  'initial-error': 'Initial sync failed',
  syncing: 'Syncing…',
  'cycle-error': 'Sync failed',
  // Names the effect first, not the cause: the user's library is fine and their
  // other changes did sync, so this must not read as breakage. The surfaces add
  // the call to action on top.
  'capacity-blocked': 'Some changes aren’t syncing — storage full',
  idle: 'Up to date',
};

// The detail line under the label, given how many ops the gate refused. Shared
// because all three status surfaces (both Data cards, the extension popup) want
// the same sentence; `count` is SyncOutcome.blockedCount as carried on the
// context. Falls back to the vaguer wording at 0, which a surface can still
// reach if it renders a blocked phase restored from a mirror that predates the
// count.
export function syncBlockedDetail(phase: SyncPhase, count: number): string | null {
  const what = count > 0 ? `${count} ${count === 1 ? 'change' : 'changes'}` : 'Some changes';
  if (phase === 'capacity-blocked') {
    return `${what} can’t sync because your storage is full. Free up space to sync them.`;
  }
  return null;
}

// A coarse "N min ago" for last-synced lines — good enough for a status blurb,
// no date lib needed.
export function formatSyncedAt(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return new Date(ts).toLocaleDateString();
}
