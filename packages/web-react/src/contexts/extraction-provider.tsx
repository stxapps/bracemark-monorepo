'use client';

// The server-extraction LOOP DRIVER for a web React app — the counterpart of the
// extension's background-alarm sweep (apps/bracemark-extension/entrypoints/background.ts),
// realized as a React provider because bracemark-web has no background service worker:
// the sync engine already runs in-page (SyncProvider), and so does this.
//
// It does NOT hang off the save path (useLinkMutations.create is untouched). Per
// docs/link-extraction.md ("the queue is a query, not a structure"; "everything is
// async; nothing blocks the save"), the trigger is OBSERVING pending state, not the
// save call — which is what makes it cover cross-device saves and bulk imports for
// free (all just rows the same pending-titleImage queries return), and keeps
// the save off the network.
//
// COST CONTROL — why this isn't a naive "drain everything while the tab is open".
// Each pending link is a paid `bracemark-extractor` request (HTML fetch + maybe an image
// proxy). A bulk import (tens of thousands of links) left draining unbounded in an
// open — possibly ABANDONED — tab would bill the server for work no one is watching.
// The doc sizes the SYNC poll to the backlog but never the SERVER-REQUEST rate, so
// that ceiling is imposed here, in three layers:
//
//   1. Visibility gate (AUTO mode). The incidental displayed-scoped drain runs only while
//      the tab is VISIBLE; hiding it pauses, revealing it resumes. An abandoned/backgrounded
//      tab spends nothing on extraction the user never asked for. EXTRACT-ALL is EXEMPT (see
//      layer 3) — it's explicit and finite, so it keeps running while hidden.
//   2. Displayed-scoped auto drain. The automatic drain extracts only the pending
//      subset of the links the main pane is currently SHOWING (`reportDisplayedLinkPaths`
//      → `readLinksPendingTitleImageForLinkPaths`), so cost tracks ATTENTION: a 30k-link
//      bulk import never extracts past what the user scrolled into view. A
//      `AUTO_BUDGET`-per-session backstop still caps a user who deep-scrolls a huge
//      library in one sitting — past it the drain stops and flips `autoLimitReached`.
//   3. Explicit "extract all". Draining the WHOLE library is a CONSCIOUS, user-driven
//      job: `extractAll()` switches the source to the full-library scan
//      (`readLinksPendingTitleImagePage`, cursor-paginated newest-first), lifts the auto cap,
//      and — unlike auto — keeps running while the tab is HIDDEN, so the user can click once
//      and walk away instead of babysitting the tab. It isn't visibility-bounded because it's
//      bounded by being FINITE: the cursor walk drains to the end of the library and then
//      CLEARS extract-all mode (it does NOT stay armed to re-fire on later synced/imported links),
//      with the server's per-IP caps as the hard floor. `pause()` stops it early. Surfaced via
//      the context below (controls + running/mode flags; the exact numbers come from the
//      on-demand useExtractionCounts hook) so the app can confirm at the button ("Enrich all
//      X links?") and show "X of Y enriched — [Enrich all] / [Pause]" rather than draining
//      behind the user's back.
//
// The loop, gated on the opt-in + a ready store (+ visibility for AUTO mode):
//   a wake signal kicks it → drain in paced batches, until the backlog is empty, the auto
//   budget is spent or the tab hides (auto mode), the library end is reached (extract-all,
//   which then ends the job), or the user pauses. The SOURCE
//   depends on mode: auto re-scans the displayed page's pending subset each batch;
//   `extractAll()` pages the whole library newest-first via a forward cursor (no top
//   re-scan). Per batch:
//     runServerTitleImageBatch (one extract — server fans out — → titles first, then
//     images pooled → write `files/` + `extractions/`) → requestSync() to push →
//     next page / re-scan → repeat.
// A `failed` link is marked + backed-off, so it drops out of the scan and the loop
// always terminates (no tight retry spin).
//
// The server's per-IP egress budget + rate/size/time caps (docs/link-extraction.md
// "server extraction") remain the non-negotiable FLOOR: the gates here are UX/cost
// shaping for the honest client; the extractor's own caps bound the bill regardless.

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
import { useLiveQuery } from 'dexie-react-hooks';

import { useExtractClient } from '@stxapps/react';
import {
  isRetryableTransportError,
  jitteredDelayMs,
  MAX_EXTRACT_URLS,
  retryAfterMsOf,
} from '@stxapps/shared';

import {
  type LinkScanCursor,
  readLinksPendingTitleImageForLinkPaths,
  readLinksPendingTitleImagePage,
  readRawPendingTitleImageCount,
} from '../data/queries';
import { useSettings } from '../hooks/use-settings';
import { runServerTitleImageBatch } from '../lib/server-extraction';
import { useAuth } from './auth-provider';
import { useSync } from './sync-provider';

// How many links one drain step processes before pushing and re-scanning. One step is a
// SINGLE batched `extract` request — the server fans the URLs out concurrently — so we
// take the contract's full per-request cap (`MAX_EXTRACT_URLS`): a page's titles land
// together in ~one round trip instead of trickling one-by-one. Each step still re-scans
// and syncs, so the list keeps filling in incrementally, just a page at a time. The cap
// also bounds how much a visibility-hide can over-commit (a step doesn't check mid-batch).
const BATCH = MAX_EXTRACT_URLS;

// The backstop ceiling: how many links the AUTOMATIC (displayed-scoped) drain processes
// per session before it stops and waits for an explicit `extractAll()`. The displayed
// scope already bounds normal browsing to a page or three; this only catches a user who
// deep-scrolls a huge library in one sitting, so a bulk import can't auto-bill the server
// for thousands of requests even with the tab in front of them. Resets when the provider
// remounts — i.e. per fresh entry into the signed-in app (the provider sits above the
// initial-sync gate, so it survives that gate's loading/error/ready content swaps and is
// NOT torn down on a sync retry) — so a big library extracts a chunk per visit, or
// all-at-once when the user asks. Expressed as a whole number of batched extract requests
// (`BATCH`) so the per-session ceiling is always a round number of round trips.
const AUTO_BUDGET = 10 * BATCH;

// Backoff for auto-resuming a drain after a RETRYABLE transport failure — a 429 from the
// extractor's per-IP cap, a 5xx, or a network blip (isRetryableTransportError). A 429 carries
// the server's Retry-After (the rate-limit window's period), which the retry waits out instead
// of guessing; a hintless failure paces itself: start at RETRY_BASE_MS, double per consecutive
// failure up to RETRY_MAX_MS, and reset to BASE after the first clean batch. Either delay is
// jittered upward so parallel tabs sharing the IP bucket don't retry in lockstep.
// This is what lets an extract-all job RESUME after a 429 instead of stalling — a failed batch
// writes no facets, so the wake count/probe (and thus the drain effect's deps) never change, and
// the scheduled retry is the only thing that re-wakes it.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface ExtractionContextValue {
  // Is server extraction live at all (opted in, store ready, extractor configured)?
  // When false, the controls are no-ops.
  enabled: boolean;
  // NO progress counts here — the exact done/pending/failed numbers carry an O(trash)
  // trash-correction join (readExtractionFacetCounts), so they live in the ON-DEMAND
  // useExtractionCounts hook, mounted only where the numbers render. This always-on
  // provider keeps only its cheap internal wake signals (the displayed-scoped probe;
  // the raw pending count while extracting all).
  // A drain is actively processing right now (some request is in flight).
  isRunning: boolean;
  // User-initiated "extract all" mode is on (the auto cap is lifted until `pause()` or the
  // walk drains the library, which ends the job).
  isExtractingAll: boolean;
  // The automatic drain hit AUTO_BUDGET with work still pending — the app should
  // surface "extract the rest?" rather than continue silently.
  autoLimitReached: boolean;
  // Start the explicit full-library drain: lifts the auto cap AND runs even while the tab is
  // hidden (a finite, consented job — it drains to the end of the library, then clears
  // extract-all mode rather than staying armed). Potentially thousands of paid requests, so the
  // app should confirm at the button before calling this; useExtractionCounts().pending is the
  // count to show.
  extractAll: () => void;
  // Stop the running drain; nothing auto-resumes until `extractAll()` is called again.
  pause: () => void;
  // Report the link paths currently DISPLAYED in the main pane (the page the user is
  // browsing). The automatic drain extracts the pending subset of these — and only
  // these — so work tracks attention: an abandoned bulk import never extracts past
  // what was scrolled into view. Pass the page's link paths whenever they change; pass an
  // empty array when no links are shown. A no-op while extraction is disabled.
  reportDisplayedLinkPaths: (linkPaths: string[]) => void;
}

const ExtractionContext = createContext<ExtractionContextValue | null>(null);

function isDocumentVisible(): boolean {
  // SSR / first render before hydration: assume visible so the gate doesn't wedge.
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function ExtractionProvider({ children }: { children: ReactNode }) {
  // The app's env-bound `bracemark-extractor` client, or null when no extractor origin is
  // configured — in which case the loop is permanently inert (server extraction off).
  // Read from the ExtractClientProvider seam rather than a prop: it's a function-bearing
  // object, so passing it from the Server-Component app layout would fail to serialize
  // across the server→client boundary (mirrors how SyncProvider gets `api` via useApiClient).
  const extractClient = useExtractClient();
  const { username } = useAuth();
  const { storeStatus, requestSync } = useSync();
  const { serverExtraction } = useSettings();

  // Every condition the loop needs, in one gate. The opt-in is the privacy-load-
  // bearing one: no URL leaves the browser until `serverExtraction` is true.
  const enabled =
    Boolean(username) && storeStatus === 'ready' && serverExtraction && extractClient !== null;

  // Pause the drain while the tab is hidden, so an abandoned/backgrounded tab spends
  // nothing. `visible` (state) re-runs the effect to resume; `visibleRef` lets the
  // running loop notice mid-drain and stop at the next iteration.
  const [visible, setVisible] = useState(isDocumentVisible);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // Remaining AUTOMATIC budget for this session — decremented per link in auto mode,
  // ignored in extract-all mode. Held in a ref (not state) so spending it doesn't re-render.
  const budgetRef = useRef(AUTO_BUDGET);
  const [autoLimitReached, setAutoLimitReached] = useState(false);

  // The link paths the main pane is currently showing, reported by the app via
  // `reportDisplayedLinkPaths`. The AUTOMATIC drain works only this set; `extractAll()` ignores
  // it for the full-library scan. Mirrored to a ref so the running loop reads the latest
  // page mid-drain without the effect having to restart. Deduped on report so an
  // unchanged page keeps a stable reference (a stable liveQuery dep / no needless churn).
  const [displayedLinkPaths, setDisplayedLinkPaths] = useState<string[]>([]);
  const displayedLinkPathsRef = useRef(displayedLinkPaths);
  displayedLinkPathsRef.current = displayedLinkPaths;
  const reportDisplayedLinkPaths = useCallback((linkPaths: string[]) => {
    setDisplayedLinkPaths((prev) =>
      prev.length === linkPaths.length && prev.every((path, i) => path === linkPaths[i])
        ? prev
        : linkPaths,
    );
  }, []);

  // Resume point for the whole-library extract-all walk (extract-all mode). Held in a ref so the
  // drain advances it across batches without re-scanning from the top — the property that
  // keeps extract-all O(library), not O(library²). `undefined` = start at the newest link;
  // `extractAll()` resets it to start from the newest; on reaching the end the drain resets it
  // AND clears extract-all mode (the job is finite — see layer 3), so the NEXT extractAll() re-scans
  // from the newest rather than the walk resuming past the end on its own.
  const extractAllCursorRef = useRef<LinkScanCursor | undefined>(undefined);

  // User-initiated mode flag the loop reads live; mirrored to `isExtractingAll` state for the
  // UI and to re-trigger the drain effect (and the probe source) on toggle.
  // visibleRef = passive mirror of an event-driven state; extractingAllRef = imperatively-driven flag
  // that must be readable live mid-loop, with isExtractingAll state existing only to re-render the UI
  // and re-trigger the effect.
  const extractingAllRef = useRef(false);
  const [isExtractingAll, setIsExtractingAll] = useState(false);

  // Cheap local wake signal for the AUTO (displayed-scoped) drain: is any titleImage on the
  // currently-shown page pending AND ELIGIBLE right now (respects backoff — unlike the
  // display `pendingCount`, which excludes `failed`)? liveQuery re-runs it whenever
  // `db.items` changes — a fresh save, an import, or a sync landing a cross-device link —
  // and whenever the displayed page changes (a scroll / "show more" / navigation), so the
  // drain is reactive without a fixed poll. Bounded to O(displayed). Inert in extract-all mode,
  // where the wake comes from the raw pending count below instead (no per-write library scan).
  const probe = useLiveQuery(() => {
    if (!enabled || isExtractingAll) return Promise.resolve([] as unknown[]);
    return readLinksPendingTitleImageForLinkPaths(displayedLinkPaths, Date.now());
  }, [enabled, isExtractingAll, displayedLinkPaths]);

  // Extract-all mode wakes off the RAW pending count (links minus recorded outcomes — four
  // index counts, no decode, no trash join) rather than a per-write whole-library eligibility
  // scan or the exact trash-corrected tally: raw pending is a strict OVER-count of live work
  // (see readRawPendingTitleImageCount — a trashed link's outcome token cancels against its
  // own link-total entry), so 0 always means no eligible work, and a rare trashed-pending
  // false positive just walks the library once, finds nothing eligible (the walk skips Trash
  // inline), and ends the job — zero paid requests. Any cooled-`failed` links the walk passes
  // are still retried inline. GATED to extract-all mode: outside it this querier reads
  // nothing, so in normal operation NO count query re-runs on `db.items` writes (the
  // displayed-scoped probe above is the only always-on read; the exact display numbers are
  // the on-demand useExtractionCounts). The job is finite: once the walk reaches the end
  // of the library it clears extract-all mode (see the cursor reset in the drain), so it does NOT
  // stay armed to re-fire on a later import/synced link — that takes a fresh extractAll(). Auto
  // mode uses the displayed-scoped probe.
  const rawPending =
    useLiveQuery(
      () => (enabled && isExtractingAll ? readRawPendingTitleImageCount() : Promise.resolve(0)),
      [enabled, isExtractingAll],
    ) ?? 0;

  const hasWork = isExtractingAll ? rawPending > 0 : (probe?.length ?? 0) > 0;

  // Single-flight the drain: a wake while one is running sets `rerun` so it loops once
  // more at the end, instead of overlapping.
  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);

  // Pending auto-resume retry timer + its current backoff delay (grows per consecutive
  // retryable failure, reset to RETRY_BASE_MS on a clean batch). Set/cleared by the drain
  // effect's scheduleRetry; also cleared on pause() and unmount so a Pause or teardown
  // halts a backed-off outage rather than letting it fire later.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(RETRY_BASE_MS);

  const extractAll = useCallback(() => {
    extractingAllRef.current = true;
    extractAllCursorRef.current = undefined; // walk the whole library from the newest link
    setAutoLimitReached(false);
    setIsExtractingAll(true);
  }, []);

  const pause = useCallback(() => {
    extractingAllRef.current = false;
    // Spend the rest of the auto budget too, so Pause fully stops rather than letting
    // the incidental drain quietly carry on. A later extractAll() is the only resume.
    budgetRef.current = 0;
    // Drop any pending auto-resume retry so Pause halts a backed-off outage too.
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setIsExtractingAll(false);
  }, []);

  useEffect(() => {
    // Visibility gates AUTO mode only (cost-control layer 1): don't even start an incidental
    // displayed-scoped drain while the tab is hidden. EXTRACT-ALL is exempt — it's an
    // explicit, finite, consented job, so it may start/continue while hidden (the user clicked
    // once and walked away). `visible` stays a dep so revealing the tab re-wakes auto mode.
    if (!enabled || !username || !extractClient || !hasWork || (!visible && !isExtractingAll))
      return;

    let cancelled = false;

    // Auto-resume the drain after a RETRYABLE transport failure, backing off between tries.
    // A 429's Retry-After (when the error carries one) wins over the guessed delay — it's the
    // limiter window's period, so waiting it out is the earliest retry with a fresh bucket;
    // otherwise wait retryDelayRef. Either way the doubling (capped at RETRY_MAX_MS) still
    // accrues for the next consecutive failure, and a clean batch resets it to RETRY_BASE_MS.
    // Only ONE retry pending at a time; the effect cleanup and pause() clear it. This is what
    // makes extract-all survive a 429 — its failed batch changes no synced state, so nothing
    // else re-wakes the loop.
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
            // Extract-all: page the WHOLE library newest-first via a forward cursor —
            // each batch resumes where the last left off (no top re-scan, no blocked-set
            // rebuild), so the drain is O(library), not O(library²). A non-null cursor always
            // pairs with a full page; a null cursor means we hit the oldest link.
            const page = await readLinksPendingTitleImagePage(
              Date.now(),
              BATCH,
              extractAllCursorRef.current,
            );
            if (page.links.length > 0) {
              // One batched extract extracts the whole page — the server fans the URLs out,
              // so titles land together fast and images fill in pooled. Throws only on a
              // wholesale transport failure (caught below to stop the drain).
              await runServerTitleImageBatch(username, page.links, extractClient);
              retryDelayRef.current = RETRY_BASE_MS; // a clean batch clears any accrued backoff
              // Push this batch's `files/` + `extractions/` writes (and pull anything new).
              requestSync();
            }
            if (page.cursor === null) {
              // End of library reached: the extract-all backlog is fully drained. This is a
              // FINITE, consented job, so END it rather than staying armed — un-visibility-gated,
              // a still-extract-all mode would re-fire on every later synced/imported link and let an
              // abandoned tab keep billing. Clear the mode (and reset the cursor); a fresh
              // extractAll() re-arms and re-scans from the newest. After this, an in-view page
              // still gets the normal auto drain.
              extractingAllRef.current = false;
              extractAllCursorRef.current = undefined;
              setIsExtractingAll(false);
              break;
            }
            extractAllCursorRef.current = page.cursor;
            continue;
          }

          // Auto mode: drain the displayed page's pending subset, capped by the session budget.
          // Visibility gate (layer 1), auto-only: an abandoned tab must spend nothing on
          // incidental extraction. We only reach here when not extracting-all (that branch always
          // continues/breaks above), so no mode check is needed — EXTRACT-ALL keeps running while
          // hidden, bounded instead by the cursor walk reaching the library's end plus the
          // server's per-IP caps.
          if (!visibleRef.current) return;
          if (budgetRef.current <= 0) {
            setAutoLimitReached(true);
            break;
          }
          const take = Math.min(BATCH, budgetRef.current);
          const links = (
            await readLinksPendingTitleImageForLinkPaths(displayedLinkPathsRef.current, Date.now())
          ).slice(0, take);
          if (links.length === 0) break;

          // Returns the count processed (`take` already bounds it to the auto budget), or
          // throws on a wholesale transport failure (caught below — budget is left intact).
          const processed = await runServerTitleImageBatch(username, links, extractClient);
          retryDelayRef.current = RETRY_BASE_MS; // a clean batch clears any accrued backoff
          budgetRef.current -= processed;
          // Push writes; the next iteration re-scans, where just-settled links drop out.
          requestSync();
        }
      } catch (err) {
        // A wholesale transport failure from runServerTitleImageBatch (network/abort/non-2xx)
        // — nothing was learned about this page's links. The unprocessed page stays pending
        // (no facet writes, cursor/budget untouched), so a later wake re-picks it. Clear any
        // queued rerun so a trigger that fired mid-drain doesn't restart us straight back into
        // the same outage.
        rerunRef.current = false;
        // If the failure is RETRYABLE (a 429 from the extractor's per-IP cap, a 5xx, or a
        // network blip), schedule a backed-off self-resume instead of just waiting for a
        // natural wake. This is load-bearing for extract-all: its failed batch writes no
        // facets, so counts/probe (and the effect deps) don't change and nothing would ever
        // re-fire — the job would stall on the first 429. A non-retryable 4xx still just stops.
        // Gated like the auto drain (don't self-resume a hidden tab's incidental work), but
        // extract-all — explicit + finite — resumes even while hidden.
        if (
          !cancelled &&
          isRetryableTransportError(err) &&
          (visibleRef.current || extractingAllRef.current)
        ) {
          scheduleRetry(err);
        }
      } finally {
        runningRef.current = false;
        setIsRunning(false);
        if (rerunRef.current && !cancelled && (visibleRef.current || extractingAllRef.current)) {
          rerunRef.current = false;
          void drain();
        }
      }
    };

    void drain();
    return () => {
      cancelled = true;
      // Drop a pending backoff retry so a dep change / teardown doesn't fire a stale drain.
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [enabled, username, extractClient, hasWork, visible, isExtractingAll, requestSync]);

  const value = useMemo<ExtractionContextValue>(
    () => ({
      enabled,
      isRunning,
      isExtractingAll,
      autoLimitReached,
      extractAll,
      pause,
      reportDisplayedLinkPaths,
    }),
    [
      enabled,
      isRunning,
      isExtractingAll,
      autoLimitReached,
      extractAll,
      pause,
      reportDisplayedLinkPaths,
    ],
  );

  return <ExtractionContext.Provider value={value}>{children}</ExtractionContext.Provider>;
}

// Read extraction progress + drive the explicit "extract all" / "pause" controls.
// Returns null-safe defaults outside a provider would hide a mounting bug, so it
// throws instead — mount <ExtractionProvider> above any consumer (the app layout does).
export function useExtraction(): ExtractionContextValue {
  const ctx = useContext(ExtractionContext);
  if (!ctx) throw new Error('useExtraction must be used within <ExtractionProvider>');
  return ctx;
}
