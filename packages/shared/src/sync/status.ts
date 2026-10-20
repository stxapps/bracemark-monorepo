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

import type { ProgressFn } from '../async/progress';

// The gate's phases — named for the LOCAL STORE, not the sync runs: on a
// returning visit no initial sync runs at all, yet the store is 'ready'.
export type StoreStatus =
  | 'checking' // reading the flag from the local store
  | 'syncing-initial' // first-ever pull on this device, UI is blocked
  | 'ready' // local store is usable; background sync may still be running
  | 'error'; // initial pull failed; offer retry

// Determinate progress for the BLOCKING first pull — the one wait long enough to
// deserve a number. `total` is how many index blobs this pull has to download and
// decrypt, and `done` climbs to meet it.
//
// The count is a FACT, not an estimate: the first sync lists every file before it
// fetches anything, then subtracts what the local store already has (the staleness
// skip that also makes an interrupted run resume), so the denominator is known
// before the first round trip. That is the whole reason the gate can show a real
// bar instead of an indeterminate one easing toward 90%.
//
// Reported by the initial sync ONLY. A background cycle never gates the UI — it
// reports on BgSyncStatus instead — so nothing is waiting on its count.
export interface InitialSyncProgress {
  // How many of `total` are downloaded, decrypted and stored. Every entry counts
  // exactly once, including the ones the pull skips (a path deleted mid-listing),
  // so `done` always reaches `total` rather than stalling short of it.
  done: number;
  // Always ≥ 1 where this is reported at all: a pull with nothing to download
  // reports no progress and the gate stays indeterminate for its (brief) life.
  total: number;
}

// How the engines hand a tick back: the generic done/total callback
// (async/progress.ts — which is where the two-numbers-not-a-struct reasoning
// lives), aliased here so the initial-sync signatures keep naming the counter
// they feed rather than a shape shared with the export flows.
export type InitialSyncProgressFn = ProgressFn;

// The counter line under the decrypting screen's headline. Shared so the two
// gates can't word the same number differently.
//
// "items", not "links". `total` counts every INDEX blob the pull materializes —
// `links/`, yes, but also `tags/`, `lists/`, `pins/`, `extractions/` and
// `settings/` — and since extraction blobs run about one per bookmark, the number
// typically lands near TWICE the link count the user believes they have. "2,048
// links" would be a claim they can check and find wrong, on the one screen whose
// job is to look trustworthy. The headline above still says links, because that
// is what the library is; only the count needs the wider word.
//
// The locale is pinned rather than left to the host, for the same reason every
// other string in this module is a literal: nothing here is translated, so an
// ambient locale would only buy a number that groups differently on a German
// phone than in the copy around it. A Hermes build without full ICU ignores the
// argument and returns the ungrouped digits — cosmetic, and the same string the
// unpinned call would have produced there anyway.
export function initialSyncProgressLabel(progress: InitialSyncProgress): string {
  const grouped = (n: number) => n.toLocaleString('en-US');
  return `${grouped(progress.done)} of ${grouped(progress.total)} items`;
}

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
  // The session is EXPIRED (docs/sessions.md, _the expired state on the
  // client_): the server wants a sign-in before it will sync again, so the
  // engine schedules no cycles. Not 'error' — nothing a retry could fix, and
  // the library is fully usable — and not 'idle', which would claim edits
  // made now are reaching other devices. Clears on resume.
  | 'paused'
  // The last cycle failed; requestSync retries (flips back to 'syncing'), and for
  // a failure that may clear by itself so does the provider's own timer
  // (sync/retry.ts).
  | 'error';

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
  // How many pending ops the gate refused this cycle, or held behind a refusal
  // (the metadata phase waits on refused content) — the "12 links aren't
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
  | 'paused' // the session expired; sync waits for a sign-in to resume
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
  // Ahead of everything a cycle reports: while paused no cycle runs, so a
  // leftover 'error' or 'blocked-*' from before the pause is history, and the
  // one thing the user can do is sign in.
  if (bg === 'paused') return 'paused';
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
  // Effect first, like capacity-blocked: nothing is broken and nothing is lost,
  // so the words must not read as an error. The surfaces add "Sign in to resume".
  paused: 'Sync paused',
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
