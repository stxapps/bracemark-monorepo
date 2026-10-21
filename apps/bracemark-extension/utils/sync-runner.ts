import {
  bgStatusForOutcome,
  createProgressCoalescer,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  LISTS_PREFIX,
  SETTINGS_PREFIX,
  TAGS_PREFIX,
} from '@stxapps/shared';
import {
  claimIfStillSignedIn,
  getSession,
  isFirstSyncDone,
  runIncrementalSync,
  runInitialSync,
  type SyncDeps,
} from '@stxapps/web-react';

import { apiClient } from './api-client';
import {
  clearMirroredSyncProgress,
  type MirroredSyncProgress,
  type MirroredSyncState,
  readMirroredSyncState,
  writeMirroredSyncProgress,
  writeMirroredSyncState,
} from './mirrored-sync';

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

  // Key and token from this one record (docs/sessions.md, _one record per run_):
  // the popup or options page can sign out and into another account while this
  // cycle is still running, and a client that read the mirror per request would
  // send that account's token for the rest of it.
  return {
    username: session.username,
    encryptionKey: session.encryptionKey,
    api: apiClient.withSession(session),
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

// The worker's copy of the mirror, which every write patches. Seeded from the
// PERSISTED mirror on first use, not from INITIAL_MIRRORED_SYNC_STATE: an MV3
// worker is torn down soon after it goes idle and spun up cold for the next
// trigger, and a cold copy seeded with the initial state turned the first
// patch of every such cycle into `storeStatus: 'checking', lastSyncAt: null` —
// so the popup read "Checking…" and "Last sync: Never" for the whole of a cycle
// on a device that had synced a minute before.
let state: MirroredSyncState | null = null;
async function setState(patch: Partial<MirroredSyncState>): Promise<void> {
  state ??= await readMirroredSyncState();
  state = { ...state, ...patch };
  await writeMirroredSyncState(state);
}

// KEEP THE WORKER UP FOR THE RUN, AND BRING IT BACK IF IT GOES ANYWAY.
// Both browsers tear the background down after 30 s without extension-API
// activity — Firefox's event page and Chrome's service worker alike — and
// neither counts a `fetch` or an IndexedDB write as activity. A run is mostly
// those: a big library's first pull lists and downloads for minutes and makes no
// `browser.*` call until the listing ends and its progress count starts
// (`startPull`, web-react engine.ts). With the popup open the page is held up
// by the view; with it closed the run was killed ~30 s in, and resumed only on
// the next wake — the popup reopened, or the hourly alarm — so a large library
// crawled forward an hour at a time while the mirror still read "syncing".
//
// One call does both jobs: re-arming a one-shot alarm is an extension-API call,
// which resets the idle timer in both browsers (Firefox: every background call
// reaching the parent, `"parentapicall"`; Chrome ≥110: any API call), and the
// alarm it pushes forward is a dead-man's switch. A healthy run moves it out of
// reach every tick and clears it in its `finally`; a run the browser killed
// anyway (Chrome's 30 s cap on one fetch response, its 5 min cap on one event, a
// crash) leaves it standing, and it wakes a fresh worker a minute later, whose
// spin-up kick (background.ts) resumes the pull where it stopped. The alarm
// itself carries no work. A run that FAILED clears it too: retrying an error is
// a fresh kick's job, not this switch's (the trailing-rerun rule below).
//
// The tick sits under the 30 s timeout with room for a busy event loop; the
// delay is 1 min because Chrome below 120 floors an alarm there (120 dropped
// it to 30 s), and our floor is 111.
//
// This is NOT a keepalive for an idle worker — Mozilla calls that an
// anti-pattern, and Chrome's docs say the same. It lives exactly as long as
// `inflight`.
export const SYNC_RESUME_ALARM = 'bracemark-sync-resume';
const KEEPALIVE_TICK_MS = 20_000;
const RESUME_DELAY_MINUTES = 1;

function keepAliveForRun(): () => Promise<void> {
  const arm = (): void => {
    // Awaited inside an async fn rather than `.catch`ed: Firefox's
    // `alarms.create` returns undefined, not the promise the types declare.
    void (async () => {
      await browser.alarms.create(SYNC_RESUME_ALARM, { delayInMinutes: RESUME_DELAY_MINUTES });
    })().catch(() => undefined);
  };
  arm();
  const tick = setInterval(arm, KEEPALIVE_TICK_MS);
  return async () => {
    clearInterval(tick);
    await browser.alarms.clear(SYNC_RESUME_ALARM).catch(() => false);
  };
}

export function runSync(): Promise<void> {
  if (inflight) {
    rerunRequested = true;
    return inflight;
  }

  // The run's progress feed into storage.session (mirrored-sync.ts),
  // coalesced to PROGRESS_FLUSH_MS like the apps' renders — a write per decrypted
  // record would be hundreds a second. A write that fails costs one tick of a
  // readout, never the cycle.
  const progress = createProgressCoalescer<MirroredSyncProgress>((p) => {
    void writeMirroredSyncProgress(p).catch(() => undefined);
  });
  const stopKeepAlive = keepAliveForRun();

  inflight = (async () => {
    try {
      do {
        // Synchronously first, before any await: a trigger that lands during this
        // pass must still find the flag it sets standing at the `while`.
        rerunRequested = false;
        // A worker torn down mid-run left its last tick behind, and a rerun's
        // legs are its own; neither is this pass's.
        progress.cancel();
        await clearMirroredSyncProgress().catch(() => undefined);

        // EXPIRED (docs/sessions.md): the popup or options page recorded the
        // server's `session_expired` on the shared session record. This worker
        // never acts on a verdict itself — it runs no AuthProvider — but it reads
        // the state and calls nothing: a cycle could only earn the same answer.
        // Queued saves wait, as they would offline, and push after a resume.
        if (getSession()?.state === 'expired') {
          await setState({ bgSyncStatus: 'paused', blockedCount: 0 });
          return;
        }

        const deps = buildDeps();
        if (!deps) {
          // Signed out: nothing to sync; present a ready, idle store.
          await setState({ storeStatus: 'ready', bgSyncStatus: 'idle' });
          return;
        }

        // The gate's answer is read BEFORE the first write, and goes out with it:
        // a write of `bgSyncStatus` alone left whatever `storeStatus` the copy
        // held standing for the whole cycle (see `state` above).
        const firstSyncDone = await isFirstSyncDone(deps.username);
        await setState({
          storeStatus: firstSyncDone ? 'ready' : 'syncing-initial',
          bgSyncStatus: 'syncing',
        });
        // A cycle that COMPLETES can still have had part of its push refused by
        // the plan/quota gate — the engine resolves with that rather than
        // throwing (SyncOutcome, shared sync/status.ts). Reporting a flat 'idle'
        // here would tell the popup everything synced while the user's links sit
        // queued, and would leave the pill's "Limit reached" wording unreachable.
        // The initial sync never pushes, so it has no outcome to report.
        let bgSyncStatus: MirroredSyncState['bgSyncStatus'] = 'idle';
        let blockedCount = 0;
        if (firstSyncDone) {
          const outcome = await runIncrementalSync(deps, (step, done, total) =>
            progress.report({ step, done, total }),
          );
          bgSyncStatus = bgStatusForOutcome(outcome);
          blockedCount = outcome.blockedCount;
        } else {
          // The pull's writes are fenced on the account's ownership row, and the
          // engine never claims it. The popup's sign-in does; a session an older
          // build adopted may have none, and this worker may be the first to pull.
          // The claim takes the lifecycle lock and re-reads the persisted account,
          // so it is not this worker acting on a session (web-react sync-store.ts).
          await claimIfStillSignedIn(deps.username);
          // The count the popup's pill and detail view draw — the one wait in this
          // extension long enough to need a number, which used to show as a bare
          // "Setting up this device…" for as long as the pull took.
          await runInitialSync(deps, (done, total) =>
            progress.report({ step: 'initial', done, total }),
          );
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
        // A failed FIRST pull is the gate's failure, not a cycle's: left at
        // 'syncing-initial', the phase stayed "Setting up this device…" with no
        // Retry under the error. 'error' reads as `initial-error` (shared
        // getSyncPhase), whose Retry re-runs the pull, which resumes.
        ...(state?.storeStatus === 'syncing-initial' ? { storeStatus: 'error' as const } : {}),
        bgSyncStatus: 'error',
        blockedCount: 0,
        lastSyncAt: Date.now(),
        lastError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      progress.cancel();
      await clearMirroredSyncProgress().catch(() => undefined);
      await stopKeepAlive();
      inflight = null;
      rerunRequested = false;
    }
  })();

  return inflight;
}
