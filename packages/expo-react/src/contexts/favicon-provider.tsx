// On-demand favicons for the UI — the expo port of web-react's
// contexts/favicon-provider (that header is canonical: keyed BY HOST and why
// that's the whole point, fire-and-forget + mounting as the display signal,
// the fan-out bound, why every failure records `none`). One call:
//
//   requestFavicon(host) — "a mounted row is showing this host and has no icon".
//
// Platform divergences:
//
//  - THE FETCH IS DIRECT — `https://{host}/favicon.ico` by native fetch, no
//    extractor proxy. Web needs the proxy because a browser can't read
//    cross-origin image bytes; native HTTP has no CORS, and the design is
//    clients-do-the-work (docs/link-extraction.md — _favicons_, the bracemark-expo
//    row: direct native fetch; the `<link rel="icon">` upgrade rides page
//    extraction when that lands here). The fetch itself — and the byte-sniff
//    verdict that decides whether what came back is an icon at all — is
//    lib/favicon-fetch.ts; what stays HERE is the policy around it: the queue,
//    the fan-out bound, the gate, and the rule that every miss records `none`.
//  - An `ok` icon lands as a plaintext file on disk, not bytes in the row
//    (favicon-store's split-storage header) — the UI renders its derived
//    `file://` uri, so this fetch is the ONE time the bytes cross the JS heap.
//  - GATED ON `deviceExtractionMode`, expo's own extraction ladder (the synced
//    account preference — entities.ts DEVICE_EXTRACTION_MODES, and
//    docs/link-extraction.md, _expo drains in the foreground_): this queue needs
//    `all`, since guessing at a host is un-gestured by construction. The gate is
//    load-bearing, not ceremony (the doc's
//    expo note): every fetch here is STANDALONE — nothing else on this device
//    contacted that host — so for a link saved on another device it's a NEW
//    disclosure of this device's IP to that site, and it must not happen before
//    the user opts into un-gestured network enrichment at all. The gate is NOT
//    `serverExtraction`: that one admits a third party (bracemark-extractor), which
//    expo never calls, and honoring it here would tie this device's fetching to
//    a decision about a server it doesn't use.
//    The carve-out lives elsewhere: an icon learned WHILE EXTRACTING a page
//    (lib/device-extraction.ts) is written straight to the store by that worker,
//    because it costs no disclosure the page fetch didn't already pay. This
//    queue is the guessing path, and stays behind the opt-in — with ONE
//    exception, `requestFaviconNow` below.
//  - HENCE TWO ENTRY POINTS, on the same axis the extraction provider splits on
//    (gestured vs. un-gestured, not client vs. server). `requestFavicon` is the
//    un-gestured one — a row scrolled past — and is gated. `requestFaviconNow`
//    is the gestured one: the links the user just saved ON THIS DEVICE, whose
//    page `extractNow` is fetching in the same breath, so a `/favicon.ico` GET
//    to that same host discloses nothing the save didn't already. Without it the
//    settings copy would be a half-truth — a link saved here would get its title
//    and preview image with the opt-in off, but a monogram where its icon goes
//    unless the page happened to declare one.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { isFaviconStale, putFavicon, putFaviconNone, readFavicon } from '../data/favicon-store';
import { useSettings } from '../hooks/use-settings';
import { fetchFaviconBytes } from '../lib/favicon-fetch';
import { useAuth } from './auth-provider';

// Favicons have no batch endpoint (one fetch per host), so the queue exists
// only to BOUND FAN-OUT — web's rationale, verbatim (there the cap protects
// the extractor's per-IP rate limit; here it keeps a scroll through distinct
// hosts from grabbing the radio with a burst of sockets).
const MAX_IN_FLIGHT = 4;

// A favicon is decoration: it must never compete with the link's own preview
// image (or a sync round trip) for the connection pool.
const STAGGER_MS = 60;

interface FaviconContextValue {
  // Ask for `host`'s favicon to be fetched and cached. Fire-and-forget: observe
  // the bytes reactively (useFaviconUri). Duplicate, in-flight, and
  // already-resolved hosts are no-ops. Gated on the opt-in — see the header.
  requestFavicon: (host: string) => void;
  // The GESTURED sibling: same fetch, licensed by a save the user just made on
  // this device rather than by the mode reaching `all` — though mode `off` stops
  // this too, since it declines the save fetch itself. Takes hosts in bulk
  // because its caller does — `extractNow` is handed a set of paths (one from
  // the add screen, N from the share outbox). Identity-STABLE, unlike
  // `requestFavicon`, so it can sit in an effect's dep array unguarded.
  requestFaviconNow: (hosts: string[]) => void;
}

const FaviconContext = createContext<FaviconContextValue | null>(null);

export function FaviconProvider({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const { deviceExtractionMode } = useSettings();

  // No UN-GESTURED request leaves the device below `all` — see the header.
  const enabled = Boolean(username) && deviceExtractionMode === 'all';

  // Latest identity for the async drain, so a fetch started before a render
  // never runs after the mode was lowered.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // `off` stops the GESTURED path too (the mode's whole point: this device never
  // contacts a site you save). Read through a ref so `requestFaviconNow` keeps a
  // stable identity — see its comment.
  const offRef = useRef(deviceExtractionMode === 'off');
  offRef.current = deviceExtractionMode === 'off';

  // Each entry carries WHY it was queued, because that's what decides whether the
  // opt-in still applies when it reaches the front (see the header's two entry
  // points) — a gestured host must survive an opt-in that is, and stays, off.
  const queueRef = useRef<{ host: string; gestured: boolean }[]>([]);
  // Queued or in flight — the single-flight guard, shared by both entry points so
  // a host asked for twice is fetched once. A host stays here after it resolves:
  // the row (`ok` or `none`) is the durable answer, so re-asking is pointless, and
  // the hook won't anyway once its live read sees the row.
  const handledRef = useRef(new Set<string>());
  const inFlightRef = useRef(0);

  // A different account's hosts mean nothing here — drop the session memory.
  // (The ROWS are dropped separately, by clearData on sign-out.)
  useEffect(() => {
    queueRef.current = [];
    handledRef.current.clear();
  }, [username]);

  const pump = useCallback(() => {
    while (inFlightRef.current < MAX_IN_FLIGHT && queueRef.current.length > 0) {
      const entry = queueRef.current.shift();
      if (entry === undefined) return;
      const { host, gestured } = entry;
      inFlightRef.current += 1;
      void (async () => {
        try {
          if (!gestured && !enabledRef.current) {
            // Switched off mid-queue: forget the host so turning the opt-in
            // back on can re-ask, and write no row (a `none` here would be a
            // lie about the SITE rather than about our permission to look).
            // A gestured entry is exempt — its licence was the save, which
            // already happened and can't be revoked by a later toggle.
            handledRef.current.delete(host);
            return;
          }
          // Re-check under the single-flight guard: an earlier request may have
          // resolved this host since it was queued.
          const existing = await readFavicon(host);
          if (!isFaviconStale(existing)) return;

          const bytes = await fetchFaviconBytes(host);
          if (bytes === undefined) await putFaviconNone(host);
          else await putFavicon(host, bytes);
        } catch {
          // Every failure mode lands here alike — DNS, timeout, TLS, transport.
          // All record `none`: the icon is decoration, so there's no case where
          // retrying it on the next render is worth a request, and the row ages
          // out via FAVICON_RETRY_MS (web's rationale, verbatim).
          try {
            await putFaviconNone(host);
          } catch {
            // The write itself failed. Nothing to do — the row stays absent,
            // the row stays a monogram, and a later mount re-asks.
          }
        } finally {
          inFlightRef.current -= 1;
          if (queueRef.current.length > 0) setTimeout(pump, STAGGER_MS);
        }
      })();
    }
  }, []);

  // `enabled` is a dep (not just read off the ref) so flipping the opt-in
  // changes this callback's IDENTITY, which re-runs the mounted rows' request
  // effects and fills their icons in place — web's rationale, verbatim.
  const requestFavicon = useCallback(
    (host: string) => {
      if (!enabled || host === '') return;
      if (handledRef.current.has(host)) return;
      handledRef.current.add(host);
      queueRef.current.push({ host, gestured: false });
      pump();
    },
    [enabled, pump],
  );

  // The gestured entry point (see the header). Reads its one reactive input through
  // a ref, so its identity never changes — which is what lets `extractNow` stay
  // usable from ShareBridge's effect deps.
  const requestFaviconNow = useCallback(
    (hosts: string[]) => {
      if (offRef.current) return;
      let queued = false;
      for (const host of hosts) {
        if (host === '' || handledRef.current.has(host)) continue;
        handledRef.current.add(host);
        queueRef.current.push({ host, gestured: true });
        queued = true;
      }
      if (queued) pump();
    },
    [pump],
  );

  const value = useMemo<FaviconContextValue>(
    () => ({ requestFavicon, requestFaviconNow }),
    [requestFavicon, requestFaviconNow],
  );

  return <FaviconContext.Provider value={value}>{children}</FaviconContext.Provider>;
}

export function useFavicon(): FaviconContextValue {
  const ctx = useContext(FaviconContext);
  if (!ctx) throw new Error('useFavicon must be used within <FaviconProvider>');
  return ctx;
}
