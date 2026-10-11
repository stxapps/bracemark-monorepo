import { useEffect } from 'react';
import { AppState } from 'react-native';

import {
  drainShareOutbox,
  refreshShareTaxonomy,
  takeShareHandoffs,
  useExtraction,
  useSync,
} from '@stxapps/expo-react';

// The MAIN APP's half of the share sheet (docs/share-sheet.md), as a renderless
// component mounted inside <SyncProvider> (it reads useSync): keeps the two App
// Group artifacts flowing in both directions.
//
//  - INBOUND (outbox → store): drain the iOS share extension's queued drafts
//    through the write edge on mount and on every return to foreground — the
//    moments the user comes back after sharing — ONCE THE STORE IS READY (see
//    the effect). A drain that landed drafts calls
//    requestSync(), so the pending ops push now and the read edge shows the
//    user their own share immediately (localWriteNonce semantics). It also
//    hands the landed paths to `extractNow`: a share IS a save gesture made on
//    this device, so its page fetch needs no opt-in (docs/link-extraction.md —
//    _the stance_); the outbox is simply the only door it can arrive through,
//    since the separate-process extension can't fetch or write the store
//    itself. This is why the component now sits inside <ExtractionProvider>
//    as well as <SyncProvider>.
//
//    ANDROID arrives by the other door and ends in the same place. Its share
//    activity writes the store itself, so there is no draft to drain — but it
//    mounts no providers, so it cannot fetch the page either. It leaves a
//    handoff marker per save, and the pass collects them
//    (`takeShareHandoffs`) into the same list: the same two kicks, under the
//    same ready-store rule. The sync kick is not redundant there. The share
//    activity's own is best-effort — declined during a first sync, lost with a
//    reaped process, failed offline — and nothing else pushes on a return to
//    the foreground.
//  - OUTBOUND (store → snapshot): rewrite the taxonomy snapshot after every
//    drain (a draft can mint new lists/tags), after every completed sync cycle
//    (lastSyncAt — a pull may have changed lists/tags), and on every local
//    edit (localWriteNonce — a rename/new list must reach the sheet before
//    the cycle that pushes it finishes). Locks never enter the snapshot —
//    the sheet's pickers filter only Trash, like every editor picker
//    (docs/editors.md) — so lock edits are no concern here.
//
// The drain and the snapshot are platform no-ops on Android (the share activity
// writes and reads the store live), the handoff one on iOS. All of it is
// failure-tolerant: this bridge must never take the app tree down over a share
// artifact — a missed pass self-heals on the next signal.
export function ShareBridge() {
  const { storeStatus, lastSyncAt, localWriteNonce, requestSync } = useSync();
  const { extractNow } = useExtraction();
  const ready = storeStatus === 'ready';

  useEffect(() => {
    const pass = () => {
      void (async () => {
        // THE DRAIN WAITS FOR A READY STORE; the drafts wait in the outbox, where
        // they are durable. This component is mounted above InitialSyncGate, so it
        // is live through the whole first sync, and everything a drain hands on is
        // inert until that finishes: `extractNow` returns at once
        // (extraction-provider), and by the time it would not, the outbox is empty
        // and nothing offers the link again — at extraction mode `saves` that was
        // a share with no page fetch, ever. The sync kick is declined too (the
        // engine runs no cycle before the first sync is done — sync/engine.ts
        // carries what happened when it did), and the draft's list is checked
        // against a store that is still filling. `ready` is a dependency, so the
        // pass that was skipped runs the moment the gate opens.
        //
        // "Not ready" is not only a first sync. The status starts at `checking`
        // on EVERY launch, for as long as one read of the bookkeeping row takes,
        // and the mount pass runs inside that window, closed over the
        // `extractNow` of that first render. Draining there handed every share
        // a cold start found — the usual way one is found — to an `extractNow`
        // that returned at once.
        //
        // The Android handoff waits on the same line, for the same reason.
        //
        // The snapshot is NOT held back: its existence is what tells the sheet
        // there is a session at all (share-store's loadShareTaxonomy).
        const applied = ready ? [...(await drainShareOutbox()), ...takeShareHandoffs()] : [];
        await refreshShareTaxonomy();
        if (applied.length > 0) {
          requestSync();
          extractNow(applied);
        }
      })().catch(() => undefined);
    };
    pass();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') pass();
    });
    return () => sub.remove();
    // requestSync is identity-stable (sync-provider); extractNow changes only
    // when the session/store readiness or the extraction opt-in does, and a
    // re-run is harmless — the drain is idempotent, and an empty outbox or an
    // empty handoff is a no-op.
  }, [ready, requestSync, extractNow]);

  useEffect(() => {
    // Skip the initial render (nothing synced/edited yet — the mount pass above
    // already refreshed); react to real signals only.
    if (lastSyncAt === null && localWriteNonce === 0) return;
    void refreshShareTaxonomy().catch(() => undefined);
  }, [lastSyncAt, localWriteNonce]);

  return null;
}
