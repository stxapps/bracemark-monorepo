import { useEffect } from 'react';
import { AppState } from 'react-native';

import { drainShareOutbox, refreshShareTaxonomy } from '../data/share-store';
import { useExtraction } from './extraction-provider';
import { useSync } from './sync-provider';

// The MAIN APP's half of the share sheet (docs/share-sheet.md), as a renderless
// component mounted inside <SyncProvider> (it reads useSync): keeps the two App
// Group artifacts flowing in both directions.
//
//  - INBOUND (outbox → store): drain the iOS extension's queued drafts through
//    the write edge on mount and on every return to foreground — the moments
//    the user comes back after sharing. A drain that landed drafts calls
//    requestSync(), so the pending ops push now and the read edge shows the
//    user their own share immediately (localWriteNonce semantics). It also
//    hands the landed paths to `extractNow`: a share IS a save gesture made on
//    this device, so its page fetch needs no opt-in (docs/link-extraction.md —
//    _the stance_); the outbox is simply the only door it can arrive through,
//    since the separate-process extension can't fetch or write the store
//    itself. This is why the component now sits inside <ExtractionProvider>
//    as well as <SyncProvider>.
//  - OUTBOUND (store → snapshot): rewrite the taxonomy snapshot after every
//    drain (a draft can mint new lists/tags), after every completed sync cycle
//    (lastSyncAt — a pull may have changed lists/tags), and on every local
//    edit (localWriteNonce — a rename/new list must reach the sheet before
//    the cycle that pushes it finishes). Locks never enter the snapshot —
//    the sheet's pickers filter only Trash, like every editor picker
//    (docs/editors.md) — so lock edits are no concern here.
//
// Every call is a platform no-op on Android (the share activity reads live) and
// failure-tolerant: this bridge must never take the app tree down over a share
// artifact — a missed pass self-heals on the next signal.
export function ShareBridge() {
  const { lastSyncAt, localWriteNonce, requestSync } = useSync();
  const { extractNow } = useExtraction();

  useEffect(() => {
    const pass = () => {
      void (async () => {
        const applied = await drainShareOutbox();
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
    // re-run is harmless — the drain is idempotent and an empty outbox is a
    // no-op.
  }, [requestSync, extractNow]);

  useEffect(() => {
    // Skip the initial render (nothing synced/edited yet — the mount pass above
    // already refreshed); react to real signals only.
    if (lastSyncAt === null && localWriteNonce === 0) return;
    void refreshShareTaxonomy().catch(() => undefined);
  }, [lastSyncAt, localWriteNonce]);

  return null;
}
