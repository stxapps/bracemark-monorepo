import {
  bgStatusForOutcome,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  LISTS_PREFIX,
  SETTINGS_PREFIX,
  TAGS_PREFIX,
} from '@stxapps/shared';
import {
  getSession,
  isFirstSyncDone,
  runIncrementalSync,
  runInitialSync,
  type SyncDeps,
} from '@stxapps/web-react';

import { apiClient } from './api-client';
import {
  INITIAL_MIRRORED_SYNC_STATE,
  type MirroredSyncState,
  writeMirroredSyncState,
} from './mirrored-sync-state';

// The background's sync runner. Builds the engine's SyncDeps from the persisted
// session (hydrated from IndexedDB — available in the worker) and the mode-bound api
// client, runs one cycle, and mirrors the result into browser.storage.local so the
// popup / options page can render status without mounting the sync engine.
//
// SELECTIVE SYNC: the extension materializes `links/` + `extractions/` (+ lazy
// `files/`) for the library, plus `settings/`, `lists/`, and `tags/` — it still
// skips downloading `pins/` blobs (a browse-only concern the popup never reads).
// `settings/` is pulled because the popup/options ThemeProvider resolves the synced
// theme (and links layout / serverExtraction) through `useSettings()` →
// `readSettingsGeneral()`, which reads `settings/general.enc` out of the local store;
// without it materialized here that read is always undefined and the synced theme
// silently falls back to the default (the same file the pre-paint FOUC script's
// localStorage mirror is warmed from). `lists/` and `tags/` are pulled because the
// popup's save Editor (Editor.tsx) lets you pick a list and tags: its shared
// ListSelect / TagsField pickers read the options from the local store
// (`useLists()` → `readLists()`, `useTags()` → `readTags()`), so without those blobs
// materialized the editor shows only the system lists and zero existing tags. All
// three are small blob sets, so the cost is negligible. The cursor still advances
// across ALL ops (the engine filters downloads, not the op pull), so the next cycle
// resumes correctly.
const pathFilter = (path: string): boolean =>
  path.startsWith(LINKS_PREFIX) ||
  path.startsWith(EXTRACTIONS_PREFIX) ||
  path.startsWith(FILES_PREFIX) ||
  path.startsWith(SETTINGS_PREFIX) ||
  path.startsWith(LISTS_PREFIX) ||
  path.startsWith(TAGS_PREFIX);

function buildDeps(): SyncDeps | null {
  // Synchronous read of the in-memory mirror the api client's authFetch reads —
  // the background's withSession() hydrates it from IndexedDB before every trigger
  // (alarm / startup / message), so there's no stale-session hazard here.
  const session = getSession();
  if (!session) return null;

  return {
    username: session.username,
    encryptionKey: session.encryptionKey,
    api: apiClient,
    pathFilter,
  };
}

// Single-flight at the worker level too: overlapping triggers (alarm + a KICK_SYNC
// from a save) share the in-flight run. The engine single-flights per account
// internally as well, but coalescing here keeps the state mirror tidy.
//
// Like the engine, single-flight needs a TRAILING RERUN: a trigger that lands while a
// cycle is mid-flight (e.g. the post-EXTRACT kick while the save's KICK_SYNC cycle is
// still uploading) may have enqueued pending ops the running cycle already collected
// past. Without the rerun those ops sit locally until the next wake — worst case the
// hourly alarm. Overlapping triggers coalesce into at most ONE extra cycle; like the
// engine, a failed cycle drops the rerun (the error is mirrored; retry is a fresh kick).
let inflight: Promise<void> | null = null;
let rerunRequested = false;

let state: MirroredSyncState = INITIAL_MIRRORED_SYNC_STATE;
async function setState(patch: Partial<MirroredSyncState>): Promise<void> {
  state = { ...state, ...patch };
  await writeMirroredSyncState(state);
}

export function runSync(): Promise<void> {
  if (inflight) {
    rerunRequested = true;
    return inflight;
  }

  inflight = (async () => {
    try {
      do {
        rerunRequested = false;

        const deps = buildDeps();
        if (!deps) {
          // Signed out: nothing to sync; present a ready, idle store.
          await setState({ storeStatus: 'ready', bgSyncStatus: 'idle' });
          return;
        }

        await setState({ bgSyncStatus: 'syncing' });
        // A cycle that COMPLETES can still have had part of its push refused by
        // the plan/quota gate — the engine resolves with that rather than
        // throwing (SyncOutcome, shared sync/status.ts). Reporting a flat 'idle'
        // here would tell the popup everything synced while the user's links sit
        // queued, and would leave the pill's "Limit reached" wording unreachable.
        // The initial sync never pushes, so it has no outcome to report.
        let bgSyncStatus: MirroredSyncState['bgSyncStatus'] = 'idle';
        let blockedCount = 0;
        if (await isFirstSyncDone(deps.username)) {
          const outcome = await runIncrementalSync(deps);
          bgSyncStatus = bgStatusForOutcome(outcome);
          blockedCount = outcome.blockedCount;
        } else {
          await setState({ storeStatus: 'syncing-initial' });
          await runInitialSync(deps);
        }
        await setState({
          storeStatus: 'ready',
          bgSyncStatus,
          blockedCount,
          lastSyncAt: Date.now(),
          lastError: null,
        });
      } while (rerunRequested);
    } catch (err) {
      await setState({
        bgSyncStatus: 'error',
        blockedCount: 0,
        lastSyncAt: Date.now(),
        lastError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight = null;
      rerunRequested = false;
    }
  })();

  return inflight;
}
