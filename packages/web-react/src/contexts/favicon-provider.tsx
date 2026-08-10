'use client';

// On-demand favicons for the UI — the FaviconProvider is to `db.favicons` what
// FileContentProvider is to `files/` blobs: the seam that lets a rendered row pull
// bytes it can't fetch itself. It exposes one call:
//
//   requestFavicon(host) — "a mounted row is showing this host and has no icon".
//
// Fire-and-forget: the fetch writes the bytes into `db.favicons`, and the
// requesting row's liveQuery repaints when they land (useFaviconUrl does both
// halves). Mounting is the display signal, same as the preview images.
//
// KEYED BY HOST, WHICH IS THE WHOLE POINT. A page of 200 Hacker News links asks 200
// times and buys exactly ONE fetch; the second link on a known host buys none, ever
// again on this device. That's what makes an icon-per-site affordable when an
// icon-per-link would not be — see FaviconRecord in db.ts.
//
// WHY THE PROXY. The web app can't read cross-origin image bytes (CORS / tainted
// canvas), and pointing an <img> straight at `https://host/favicon.ico` is the
// per-paint third-party leak the design forbids — the same reason the og:image goes
// through GET /v1/image (extract/endpoints.ts). So a favicon rides that existing
// proxy verbatim: no new endpoint, and POST /v1/extract is untouched, so the
// metadata path does no extra work.
//
// WHAT THE PROXY DOESN'T DECIDE: whether the bytes are an ICON. Its `image/*`
// allowlist is a passthrough of the UPSTREAM's declared content-type (an HTML 404
// served as `image/x-icon` sails through it), and its `MAX_IMAGE_BYTES` ceiling is
// 10 MB — the og:image abuse floor it shares with the preview path, sized for a
// hero image and no statement about icons. Both would land here as an `ok` row
// that NEVER expires (favicon-store.ts), charged to the origin's storage quota.
// So the verdict is applied on THIS side, to bytes in hand, by the same
// `isRenderableIconBytes` expo's fillers use (@stxapps/shared extract/favicon.ts)
// — one definition of "is this an icon" across both platforms. The proxy ceiling
// stays the outer bound; we just don't mistake it for the inner one.
//
// We guess `/favicon.ico` rather than reading `<link rel="icon">` from the page,
// which resolves on most sites and costs no contract change. Hosts that declare an
// icon elsewhere record `none` and show the monogram; teaching the extractor's
// HTMLRewriter to return a `faviconUrl` (it already scans `link[rel~="image_src"]`)
// is the accuracy upgrade, and this store is where it would land.
//
// GATED ON THE serverExtraction OPT-IN, unlike FileContentProvider: that provider
// fetches the user's own encrypted bytes from our own R2, whereas this is a
// third-party origin fetch through the extractor — the same trust decision as the
// og:image, so it rides the same switch. With the opt-in off (or no extractor
// configured) this is inert and every row shows its monogram.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { useExtractClient } from '@stxapps/react';
import { isRenderableIconBytes } from '@stxapps/shared';

import { isFaviconStale, putFavicon, putFaviconNone, readFavicon } from '../data/favicon-store';
import { useSettings } from '../hooks/use-settings';
import { useAuth } from './auth-provider';

// Favicons have no batch endpoint (one GET /v1/image each), so unlike
// FileContentProvider there's nothing to micro-batch — the queue exists only to
// BOUND FAN-OUT. Scrolling into a run of all-distinct hosts would otherwise fire a
// request per row at once, tripping the extractor's per-IP rate cap and getting
// them all rejected. A handful in flight keeps the icons filling in visibly while
// staying well under it.
const MAX_IN_FLIGHT = 4;

// A favicon is decoration: it must never compete with the link's own preview image
// (or a sync round trip) for the connection pool. Small enough not to be noticed.
const STAGGER_MS = 60;

interface FaviconContextValue {
  // Ask for `host`'s favicon to be fetched and cached. Fire-and-forget: observe the
  // bytes reactively (useFaviconUrl). Duplicate, in-flight, and already-resolved
  // hosts are no-ops.
  requestFavicon: (host: string) => void;
}

const FaviconContext = createContext<FaviconContextValue | null>(null);

export function FaviconProvider({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const extractClient = useExtractClient();
  const { serverExtraction } = useSettings();

  // No URL leaves the browser until the opt-in is on and an extractor is
  // configured — mirrors ExtractionProvider's `enabled` gate.
  const enabled = Boolean(username) && serverExtraction && extractClient !== null;

  // Latest identities for the async drain, so a fetch started before a render never
  // uses a stale client or runs after the opt-in was switched off.
  const clientRef = useRef(extractClient);
  clientRef.current = extractClient;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const queueRef = useRef<string[]>([]);
  // Queued or in flight — the single-flight guard. A host stays here after it
  // resolves: the Dexie row (`ok` or `none`) is the durable answer, so re-asking is
  // pointless, and the hook won't anyway once its liveQuery sees the row.
  const handledRef = useRef(new Set<string>());
  const inFlightRef = useRef(0);

  // A different account's hosts mean nothing here — drop the session memory. (The
  // ROWS are dropped separately, by clearData on sign-out.)
  useEffect(() => {
    queueRef.current = [];
    handledRef.current.clear();
  }, [username]);

  const pump = useCallback(() => {
    while (inFlightRef.current < MAX_IN_FLIGHT && queueRef.current.length > 0) {
      const host = queueRef.current.shift();
      if (host === undefined) return;
      inFlightRef.current += 1;
      void (async () => {
        try {
          const client = clientRef.current;
          if (!enabledRef.current || !client) {
            // Switched off mid-queue: forget the host so turning the opt-in back
            // on can re-ask, and write no row (a `none` here would be a lie about
            // the SITE rather than about our permission to look).
            handledRef.current.delete(host);
            return;
          }
          // Re-check under the single-flight guard: another tab or an earlier
          // request may have resolved this host since it was queued.
          const existing = await readFavicon(host);
          if (!isFaviconStale(existing)) return;

          const bytes = await client.fetchImage(`https://${host}/favicon.ico`);
          // The proxy got us bytes; whether they're an ICON is our call — see the
          // header. Anything else records `none`, so the row doesn't cache an
          // unrenderable (or oversized) blob under an `ok` that never expires.
          if (!isRenderableIconBytes(bytes)) await putFaviconNone(host);
          else await putFavicon(host, bytes);
        } catch {
          // Every failure mode lands here alike — 404 (no such icon),
          // unsupported_type (an HTML error page), blocked, or a transport error.
          // All record `none`: the icon is decoration, so there's no case where
          // retrying it on the next render is worth a request, and the row ages
          // out via FAVICON_RETRY_MS. Distinguishing them would buy a nicer retry
          // policy for a monogram nobody is waiting on.
          try {
            await putFaviconNone(host);
          } catch {
            // The write itself failed (quota, private mode). Nothing to do — the
            // row stays absent, the row stays a monogram, and a later mount re-asks.
          }
        } finally {
          inFlightRef.current -= 1;
          if (queueRef.current.length > 0) setTimeout(pump, STAGGER_MS);
        }
      })();
    }
  }, []);

  // `enabled` is a dep (not just read off the ref) so flipping the opt-in changes
  // this callback's IDENTITY, which re-runs the mounted rows' request effects and
  // fills their icons in place. Without it, turning server extraction on would only
  // take effect for rows mounted afterwards — which navigation happens to cause
  // today, but only by accident of /settings being its own route.
  const requestFavicon = useCallback(
    (host: string) => {
      if (!enabled || host === '') return;
      if (handledRef.current.has(host)) return;
      handledRef.current.add(host);
      queueRef.current.push(host);
      pump();
    },
    [enabled, pump],
  );

  const value = useMemo<FaviconContextValue>(() => ({ requestFavicon }), [requestFavicon]);

  return <FaviconContext.Provider value={value}>{children}</FaviconContext.Provider>;
}

export function useFavicon(): FaviconContextValue {
  const ctx = useContext(FaviconContext);
  if (!ctx) throw new Error('useFavicon must be used within <FaviconProvider>');
  return ctx;
}
