// The on-device extraction LOOP DRIVER — the expo port of web-react's
// contexts/extraction-provider (that header is canonical: the trigger is OBSERVING
// pending state rather than hooking the save path, which is what makes it cover
// cross-device saves and imports for free; the three cost layers; the single-flight
// drain with a queued rerun; the backed-off self-resume). What follows is only what
// DIFFERS on this platform, and why.
//
//  - THE GATE IS `deviceExtractionMode`, not `serverExtraction`, and there is no extractor
//    client to check (docs/link-extraction.md — _expo drains in the foreground_). Expo
//    never calls `bracemark-extractor`: native HTTP has no CORS, so the server buys back
//    nothing and would only downgrade the tier, cost a paid request, and disclose the URL.
//    It's a LADDER, not a boolean (entities.ts DEVICE_EXTRACTION_MODES), and the two ends
//    land in different places here: `all` is what arms the drain below (`enabled`), while
//    `off` is checked inside `extractNow` — the only gate that can stop a gestured save.
//
//  - `extractNow` IS NEW — the gestured path (see below). Web has no equivalent because
//    on web every extraction goes through a server and is therefore gated regardless.
//
//  - THE COST LAYERS SURVIVE, BOUNDING SOMETHING ELSE. On web they bound a BILL (every
//    pending link is a paid request). Here every fetch is free, so the same three layers
//    exist for battery, cellular data, politeness to the hosts being fetched, and not
//    doing invisible work for an app the user backgrounded. Two calibration consequences:
//    "Generate all" needs no cost confirmation, and AUTO_BUDGET can sit looser than web's
//    (overshooting spends the user's battery, not the project's money).
//
//  - APPSTATE REPLACES `visibilitychange`, with a caveat worth stating plainly: web's
//    layer-3 promise that "extract-all keeps running while hidden" is NOT literally
//    available on iOS — a backgrounded app is SUSPENDED, so JS stops whether we want it
//    to or not. We therefore do not CANCEL an extract-all on background (a quick app
//    switch resumes seamlessly from the in-memory cursor, which is the honest thing we
//    can offer), but we cannot promise progress the way a hidden browser tab can. That's
//    a platform divergence, not a bug; the real background sweep is the deferred
//    `expo:bg` task (BGAppRefreshTask / WorkManager).
//
//  - THE WAKE SIGNAL IS `useLiveRead` over ['items', 'item_facet_statuses'] instead of
//    liveQuery. Same reactive contract; naming both tables (and only those) keeps a sync
//    drain's `pending_ops` churn from re-firing the read on every queued op.
//
//  - THE STEP IS A SMALL LINK POOL, not `MAX_EXTRACT_URLS`. There's no batch endpoint to
//    fill: a step is STEP links fetched at CONCURRENCY (device-extraction.ts), so the
//    number is about the radio and the target hosts, not a server's fan-out.
//
//  - TWO PATHS REACH THE SAME WORKER, so they share an in-flight set (`inFlightPathsRef`).
//    Web has one path and needs none of this; here `extractNow` runs OUTSIDE the drain by
//    design, and at mode `all` both can pick the same link. See the ref's comment.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  hostFromText,
  isRetryableTransportError,
  jitteredDelayMs,
  retryAfterMsOf,
} from '@stxapps/shared';

import {
  type LinkItem,
  type LinkScanCursor,
  readLinksPendingTitleImageForLinkPaths,
  readLinksPendingTitleImagePage,
  readRawPendingTitleImageCount,
} from '../data/queries';
import { useLiveRead } from '../hooks/use-live-read';
import { useSettings } from '../hooks/use-settings';
import { runDeviceTitleImageBatch } from '../lib/device-extraction';
import { useAuth } from './auth-provider';
import { useFavicon } from './favicon-provider';
import { useSync } from './sync-provider';

// The tables whose changes wake the drain: a link arriving (`items`) or an outcome being
// recorded (`item_facet_statuses`). Deliberately NOT `pending_ops` — a sync drain writes
// one row per queued op, and re-running a read for each would be pure churn.
const WAKE_TABLES = ['items', 'item_facet_statuses'];

// How many links one drain step processes before pushing and re-scanning. A step is STEP
// page fetches pooled at device-extraction's CONCURRENCY — small on purpose, so the list
// visibly fills in a few links at a time and a background/pause is never more than a
// couple of seconds of over-commit (a step doesn't check mid-batch).
const STEP = 8;

// The backstop ceiling for the AUTOMATIC (displayed-scoped) drain, per session. Web sizes
// this to bound a bill; here it bounds battery and data, so it can be looser — the
// displayed scope already tracks attention, and this only catches someone deep-scrolling
// a huge library in one sitting. Resets when the provider remounts (a fresh entry into the
// signed-in app), so a big library extracts a chunk per visit, or all at once when asked.
const AUTO_BUDGET = 40 * STEP;

// Backoff for auto-resuming after a RETRYABLE failure. On this platform that means one
// thing — the device was offline for the whole step (device-extraction's header: nothing
// answered, so nothing was recorded and no backoff was burned) — so the retry ladder is
// what gets the drain moving again when the radio comes back, before any wake fires.
// `retryAfterMsOf` is still consulted for completeness, but there's no server of ours to
// send one; only an origin site could.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface ExtractionContextValue {
  // Is un-gestured on-device extraction live at all (mode `all`, store ready)? When false,
  // the automatic drain and `extractAll` are no-ops — but `extractNow` still works, unless
  // the mode is `off`, which stops that too.
  enabled: boolean;
  // NO progress counts here — the exact numbers carry a trash-correction join, so they
  // live in the on-demand useExtractionCounts hook (web's split, verbatim).
  isRunning: boolean;
  isExtractingAll: boolean;
  autoLimitReached: boolean;
  // Start the explicit full-library drain: lifts the auto cap and walks the library
  // newest-first until it's drained, then ends the job. No cost confirmation needed
  // (nothing is billed) — but it uses the connection, so the button should say so.
  extractAll: () => void;
  pause: () => void;
  // Report the link paths currently DISPLAYED (FlashList's viewable rows). The automatic
  // drain extracts the pending subset of these and only these.
  reportDisplayedLinkPaths: (linkPaths: string[]) => void;
  // THE GESTURED PATH — extract these links ONCE, right now, outside the queue and the
  // budget, and above the `saves`/`all` line (it still needs a signed-in, ready store,
  // and it still honors `off`).
  //
  // This is the save the user just made ON THIS DEVICE: the app fetches a page the user
  // literally just handed it, so the save IS the consent — the same reason the browser
  // extension's active-tab capture has never carried a toggle (docs/link-extraction.md —
  // _the stance_: the axis is gestured vs. un-gestured, not client vs. server). Call it
  // from the add-link screen after a successful create, and from ShareBridge after the
  // outbox drain (share-extension saves reach the app only there).
  //
  // The rule that keeps this honest: ONE save is automatic, N-at-once is a prompt. An
  // import is a gesture too, but it's a thousand hosts — so it gets the explicit
  // "Generate previews for N links?" moment (i.e. `extractAll`) instead of auto-draining.
  //
  // It also fires the FAVICON guess for these links' hosts (favicon-provider's
  // `requestFaviconNow`), on the same licence: without it, a link saved here with the
  // opt-in off would get its title and preview image but a monogram where its icon goes,
  // which is not what the settings section and the previews prompt tell the user.
  extractNow: (linkPaths: string[]) => void;
}

const ExtractionContext = createContext<ExtractionContextValue | null>(null);

export function ExtractionProvider({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const { storeStatus, requestSync } = useSync();
  const { deviceExtractionMode } = useSettings();
  // The gestured favicon entry point, for `extractNow` — see its comment. Requires
  // <FaviconProvider> ABOVE this provider, which the (app) layout does.
  const { requestFaviconNow } = useFavicon();

  // Every condition the un-gestured loop needs, in one gate. The mode is the
  // privacy-load-bearing one: no un-gestured request leaves the device below `all`.
  const enabled = Boolean(username) && storeStatus === 'ready' && deviceExtractionMode === 'all';

  // Foreground state, AppState's answer to `visibilitychange`. `active` (state) re-runs the
  // effect to resume; `activeRef` lets a running loop notice mid-drain and stop at the next
  // iteration — the same pair web uses, and the reason a suspended-then-resumed app picks
  // up where it stopped rather than restarting the scan.
  const [active, setActive] = useState(() => AppState.currentState === 'active');
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const onChange = (next: AppStateStatus) => setActive(next === 'active');
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);

  const budgetRef = useRef(AUTO_BUDGET);
  const [autoLimitReached, setAutoLimitReached] = useState(false);

  const [displayedLinkPaths, setDisplayedLinkPaths] = useState<string[]>([]);
  const displayedLinkPathsRef = useRef(displayedLinkPaths);
  displayedLinkPathsRef.current = displayedLinkPaths;
  // Deduped on report so an unchanged page keeps a stable reference — load-bearing here,
  // since FlashList fires onViewableItemsChanged freely and this array is a read dep.
  const reportDisplayedLinkPaths = useCallback((linkPaths: string[]) => {
    setDisplayedLinkPaths((prev) =>
      prev.length === linkPaths.length && prev.every((path, i) => path === linkPaths[i])
        ? prev
        : linkPaths,
    );
  }, []);

  // Resume point for the whole-library walk — a ref, so the drain advances it across steps
  // without re-scanning from the top (what keeps extract-all O(library), not O(library²)).
  const extractAllCursorRef = useRef<LinkScanCursor | undefined>(undefined);

  const extractingAllRef = useRef(false);
  const [isExtractingAll, setIsExtractingAll] = useState(false);

  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(RETRY_BASE_MS);

  // The links a fetch is running for RIGHT NOW, in EITHER path. `runningRef` single-flights
  // the drain against itself; this is what keeps the drain and `extractNow` off the same
  // link, which they otherwise reach together at mode `all`: the save wakes the drain (a new
  // `items` row, displayed and still pending) while `extractNow`'s page fetch — up to 15s —
  // is in flight, and a link stays pending until its TERMINAL facet write lands in pass 2.
  // What losing that race costs is more than a wasted fetch: both runs reach extractOne's
  // pass 2, each writes a `files/` image blob, the second `extractions/` write wins, and the
  // loser's blob ends up referenced by nothing — synced, charged against the byte quota, and
  // never reclaimed (the delete paths only ever reach REFERENCED blobs, and
  // sweepDanglingExtractions is about extractions without links, not files without
  // referrers).
  //
  // Deliberately in-memory and released in a `finally`, never a persisted mark: a mark that
  // outlived the fetch (an offline `extractNow`, a killed app) would strand the link where
  // no path looks at it again. And deliberately in-PROCESS only — cross-DEVICE duplication
  // stays unguarded on purpose (docs/link-extraction.md — _the extraction entity_,
  // cross-device dedup: self-healing, and a lease would cost a write-then-sync on the
  // critical path). The asymmetry is the price: there coordination costs a synced lease,
  // here it costs a Set.
  const inFlightPathsRef = useRef(new Set<string>());

  // Take up to `limit` of these links that no other path is already fetching, marking them
  // in flight. The caller MUST hand the result to `releaseInFlight` in a `finally`.
  // Claiming (rather than filtering then slicing) is what keeps `limit` honest: a link
  // skipped here must not spend a slot the caller was going to pay for.
  const claimInFlight = useCallback((links: LinkItem[], limit = Infinity): LinkItem[] => {
    const claimed: LinkItem[] = [];
    for (const link of links) {
      if (claimed.length >= limit) break;
      if (inFlightPathsRef.current.has(link.path)) continue;
      inFlightPathsRef.current.add(link.path);
      claimed.push(link);
    }
    return claimed;
  }, []);

  const releaseInFlight = useCallback((links: LinkItem[]) => {
    for (const link of links) inFlightPathsRef.current.delete(link.path);
  }, []);

  // Cheap wake signal for the AUTO drain: is anything on the displayed page pending AND
  // eligible right now (backoff respected)? O(displayed), re-run on the two wake tables.
  // Inert in extract-all mode, where the raw count below is the signal instead.
  const probe = useLiveRead(
    () =>
      !enabled || isExtractingAll
        ? Promise.resolve([])
        : readLinksPendingTitleImageForLinkPaths(displayedLinkPaths, Date.now()),
    [enabled, isExtractingAll, displayedLinkPaths],
    WAKE_TABLES,
  );

  // Extract-all wakes off the RAW pending count (four index counts, no decode, no trash
  // join) — a strict over-count, so 0 always means "nothing to do" and a rare trashed-
  // pending false positive costs one library walk that finds nothing. Gated to extract-all
  // mode so no count query runs on writes in normal operation.
  const rawPending =
    useLiveRead(
      () => (enabled && isExtractingAll ? readRawPendingTitleImageCount() : Promise.resolve(0)),
      [enabled, isExtractingAll],
      WAKE_TABLES,
    ) ?? 0;

  const hasWork = isExtractingAll ? rawPending > 0 : (probe?.length ?? 0) > 0;

  const extractAll = useCallback(() => {
    extractingAllRef.current = true;
    extractAllCursorRef.current = undefined; // walk the whole library from the newest link
    setAutoLimitReached(false);
    setIsExtractingAll(true);
  }, []);

  const pause = useCallback(() => {
    extractingAllRef.current = false;
    // Spend the rest of the auto budget too, so Pause fully stops rather than letting the
    // incidental drain quietly carry on. A later extractAll() is the only resume.
    budgetRef.current = 0;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setIsExtractingAll(false);
  }, []);

  // The gestured path (see the context type). Deliberately NOT part of the drain: no
  // queue, no budget, no cursor, no opt-in — one pass over these links, fire and forget,
  // with the same per-link outcome recording as the drain so a failure backs off instead
  // of spinning. It runs at `expo:fg` like everything else here. The ONE thing it shares
  // with the drain is the in-flight set, which is not a gate on the gesture — it only
  // stops the two paths fetching the same link twice (see inFlightPathsRef).
  const extractNow = useCallback(
    (linkPaths: string[]) => {
      if (!username || storeStatus !== 'ready' || linkPaths.length === 0) return;
      // `off` is the one position that reaches in here: it means "this device never
      // contacts a site you save", and a save gesture is not an exception to it —
      // it's the exact thing being declined. `saves` and `all` both proceed.
      if (deviceExtractionMode === 'off') return;
      void (async () => {
        let links: LinkItem[] = [];
        try {
          // Anything the drain already has in flight is dropped, not waited on — it's the
          // same fetch at the same tier, so the gesture is already being served (see
          // inFlightPathsRef). Only reachable at mode `all`; at `saves` the drain can't run,
          // so nothing is ever dropped here.
          links = claimInFlight(
            await readLinksPendingTitleImageForLinkPaths(linkPaths, Date.now()),
          );
          if (links.length === 0) return;
          // The icon rides the same gesture as the page (favicon-provider's two entry
          // points): fired FIRST so a ~1 KB `/favicon.ico` isn't queued behind a page
          // fetch that can take 15s. Both fillers may now race for these hosts — the
          // capture below and this guess — which is safe by favicon-store's rule that
          // `ok` never gets downgraded, and mostly moot since each re-checks the row.
          // Hosts come from the CLAIMED links, so a re-save of an already-extracted link
          // doesn't re-ask (its icon was captured when it was extracted), and a link the
          // drain is mid-fetch on gets its icon from that run's capture instead.
          requestFaviconNow([...new Set(links.map((link) => hostFromText(link.url)))]);
          await runDeviceTitleImageBatch(username, links, 'expo:fg', {
            optedIn: deviceExtractionMode === 'all',
          });
          requestSync();
        } catch {
          // Offline, or a store hiccup: nothing was recorded (device-extraction's header),
          // so the link stays pending and the normal drain picks it up on the next wake —
          // no reason to surface anything at the save site.
        } finally {
          releaseInFlight(links);
        }
      })();
    },
    [
      username,
      storeStatus,
      requestSync,
      requestFaviconNow,
      deviceExtractionMode,
      claimInFlight,
      releaseInFlight,
    ],
  );

  useEffect(() => {
    // Foreground gates the AUTO drain only (cost layer 1). Extract-all is exempt in the
    // same sense web means it — we don't stop it — though on iOS the OS suspends us
    // anyway; see the header's caveat.
    if (!enabled || !username || !hasWork || (!active && !isExtractingAll)) return;

    let cancelled = false;

    const scheduleRetry = (err: unknown) => {
      if (retryTimerRef.current !== null) return;
      const hintMs = retryAfterMsOf(err);
      const baseMs = hintMs !== undefined ? Math.max(hintMs, RETRY_BASE_MS) : retryDelayRef.current;
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, RETRY_MAX_MS);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!cancelled) void drain();
      }, jitteredDelayMs(baseMs));
    };

    const drain = async () => {
      if (runningRef.current) {
        rerunRef.current = true;
        return;
      }
      runningRef.current = true;
      setIsRunning(true);
      try {
        for (;;) {
          if (cancelled) return;

          if (extractingAllRef.current) {
            // Page the whole library newest-first via the forward cursor — each step
            // resumes where the last left off.
            const page = await readLinksPendingTitleImagePage(
              Date.now(),
              STEP,
              extractAllCursorRef.current,
            );
            // A link `extractNow` is mid-fetch on is skipped for this walk, not deferred:
            // the cursor moves past it either way, and its outcome is being written by the
            // run that holds it (see inFlightPathsRef).
            const claimed = claimInFlight(page.links);
            try {
              if (claimed.length > 0) {
                await runDeviceTitleImageBatch(username, claimed, 'expo:fg', { optedIn: true });
                retryDelayRef.current = RETRY_BASE_MS; // a clean step clears accrued backoff
                requestSync(); // push this step's `files/` + `extractions/` writes
              }
            } finally {
              releaseInFlight(claimed);
            }
            if (page.cursor === null) {
              // End of library: the job is FINITE, so end it rather than staying armed to
              // re-fire on every later synced/imported link. A fresh extractAll() re-arms.
              extractingAllRef.current = false;
              extractAllCursorRef.current = undefined;
              setIsExtractingAll(false);
              break;
            }
            extractAllCursorRef.current = page.cursor;
            continue;
          }

          // Auto mode: the displayed page's pending subset, capped by the session budget.
          if (!activeRef.current) return;
          if (budgetRef.current <= 0) {
            setAutoLimitReached(true);
            break;
          }
          const take = Math.min(STEP, budgetRef.current);
          // The claim doubles as the step's slice — a link `extractNow` holds is skipped
          // without spending a slot of `take` (see claimInFlight). Breaking when the whole
          // displayed page is claimed is safe: the run holding it writes an outcome to
          // `item_facet_statuses`, which is a wake table, so the drain re-fires with the
          // real remainder rather than sitting on a lost wakeup.
          const links = claimInFlight(
            await readLinksPendingTitleImageForLinkPaths(displayedLinkPathsRef.current, Date.now()),
            take,
          );
          if (links.length === 0) break;

          try {
            // `optedIn: true` is not an assumption — `enabled` gates this whole effect on
            // mode `all`, so the drain cannot run at a lower position.
            const processed = await runDeviceTitleImageBatch(username, links, 'expo:fg', {
              optedIn: true,
            });
            retryDelayRef.current = RETRY_BASE_MS;
            budgetRef.current -= processed;
            requestSync();
          } finally {
            releaseInFlight(links);
          }
        }
      } catch (err) {
        // The only wholesale failure this platform has: the whole step failed at the
        // transport level, i.e. the device is offline (device-extraction records nothing in
        // that case, so no backoff was burned and the cursor/budget are untouched). Clear a
        // queued rerun so a mid-drain trigger doesn't restart us straight back into it.
        rerunRef.current = false;
        if (
          !cancelled &&
          isRetryableTransportError(err) &&
          (activeRef.current || extractingAllRef.current)
        ) {
          scheduleRetry(err);
        }
      } finally {
        runningRef.current = false;
        setIsRunning(false);
        if (rerunRef.current && !cancelled && (activeRef.current || extractingAllRef.current)) {
          rerunRef.current = false;
          void drain();
        }
      }
    };

    void drain();
    return () => {
      cancelled = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [
    enabled,
    username,
    hasWork,
    active,
    isExtractingAll,
    requestSync,
    claimInFlight,
    releaseInFlight,
  ]);

  const value = useMemo<ExtractionContextValue>(
    () => ({
      enabled,
      isRunning,
      isExtractingAll,
      autoLimitReached,
      extractAll,
      pause,
      reportDisplayedLinkPaths,
      extractNow,
    }),
    [
      enabled,
      isRunning,
      isExtractingAll,
      autoLimitReached,
      extractAll,
      pause,
      reportDisplayedLinkPaths,
      extractNow,
    ],
  );

  return <ExtractionContext.Provider value={value}>{children}</ExtractionContext.Provider>;
}

// Read drain state + drive the explicit controls. Throws outside a provider rather than
// returning null-safe defaults, which would hide a mounting bug — mount
// <ExtractionProvider> above any consumer (the (app) layout does).
export function useExtraction(): ExtractionContextValue {
  const ctx = useContext(ExtractionContext);
  if (!ctx) throw new Error('useExtraction must be used within <ExtractionProvider>');
  return ctx;
}
