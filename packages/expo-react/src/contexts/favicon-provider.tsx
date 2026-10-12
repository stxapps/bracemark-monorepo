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
  // And the account signed in when the host was ADMITTED, which is the only
  // account it may be fetched or written for (the pump below) — this provider's
  // account as of its latest render, not the account whose link the caller holds.
  const queueRef = useRef<{ host: string; gestured: boolean; owner: string }[]>([]);
  // Queued or in flight — the single-flight guard, shared by both entry points so
  // a host asked for twice is fetched once. A host stays here after it resolves:
  // the row (`ok` or `none`) is the durable answer, so re-asking is pointless, and
  // the hook won't anyway once its live read sees the row.
  const handledRef = useRef(new Set<string>());
  const inFlightRef = useRef(0);

  // The account the session memory above belongs to; the reset below COMPARES it
  // rather than trusting `[username]` alone. Web's file-content-provider carries the
  // reasoning: a bare dependency also fires on mount, and a parent's effect runs after
  // its children's, so the wipe would take anything asked inside this provider's own
  // first commit — and a first-run flag doesn't survive StrictMode's double mount.
  const memoryUsernameRef = useRef(username);

  // A different account's hosts mean nothing here — drop the session memory.
  // (The ROWS are dropped separately, by clearData on sign-out.)
  useEffect(() => {
    if (memoryUsernameRef.current === username) return;
    memoryUsernameRef.current = username;
    queueRef.current = [];
    handledRef.current.clear();
  }, [username]);

  // The account signed in as of the latest render: stamped onto a host as it is
  // admitted, and compared with that stamp as its entry reaches the front (the
  // pump below is identity-stable, so it can't close over a render's value).
  const usernameRef = useRef(username);
  usernameRef.current = username;

  // THE DRAIN ENDS WITH THE PROVIDER. Nothing above stops it: the queue is a ref
  // and each fetch re-arms the next from its own `finally`, so a sign-out with
  // hosts still queued used to leave the loop running on its own — one request
  // per host to the signed-out account's saved sites, from a screen that no
  // longer existed, each answer then written into the store clearData had just
  // emptied. The effect above can't catch it: it needs a render, and the
  // provider is under the auth gate, so sign-out is an unmount, not a new
  // username. So unmounting empties the queue and marks the drain dead; a fetch
  // already in flight finishes and then finds the mark (or, in the commit
  // between the wipe and this cleanup, the store's own fence — favicon-store.ts).
  //
  // A flag that only ever goes one way — never "alive", set by the mount effect: a
  // row's effect runs BEFORE this provider's (children first), so a request made
  // in the provider's own first commit would find it not yet alive and be dropped.
  const stoppedRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    // The Set is never replaced, only cleared, so this is the one the cleanup wants.
    const handled = handledRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Decided a microtask later, not here. StrictMode's mount → cleanup → mount
      // runs this cleanup and re-mounts in the same synchronous commit; taken at
      // face value that reads as the provider going away, and it would drop every
      // host the rows asked for in that first commit — for good, since they stay
      // marked handled. A real unmount is still unmounted by then.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        stoppedRef.current = true;
        queueRef.current = [];
        handled.clear();
      });
    };
  }, []);

  const pump = useCallback(() => {
    while (inFlightRef.current < MAX_IN_FLIGHT && queueRef.current.length > 0) {
      const entry = queueRef.current.shift();
      if (entry === undefined) return;
      // `owner` is the account that ADMITTED this host — not whoever is signed
      // in as it reaches the front, and not whoever is signed in when the answer
      // lands. A render can hand this provider a different account without an
      // unmount, and the reset above is an EFFECT: it runs after the render that
      // already moved `usernameRef`, and a timer can pump in between — this
      // drain's own stagger, or a row's settle (use-favicon-uri.ts). An owner
      // read HERE would be the new account's, whose ownership row the store's
      // fence accepts
      // (data/favicon-store.ts): the previous account's host, fetched from this
      // device and written into the next account's cache.
      const { host, gestured, owner } = entry;
      inFlightRef.current += 1;
      void (async () => {
        try {
          if (usernameRef.current !== owner) {
            // Left over from the previous account (above). A gestured entry is
            // NOT exempt — its licence was a save by the account that made it.
            // Dropped at once, ahead of the cache read, so it holds its slot no
            // longer than this call: with slots free, a request the new account
            // makes before the reset runs is pumped now, where it would otherwise
            // wait behind a full burst of these and be swept by the reset. (With
            // every slot held by requests still out, it is swept all the same.)
            // Forgotten, so that account can ask for the host itself.
            handledRef.current.delete(host);
            return;
          }
          if (!gestured && !enabledRef.current) {
            // Switched off mid-queue: forget the host so turning the opt-in
            // back on can re-ask, and write no row (a `none` here would be a
            // lie about the SITE rather than about our permission to look).
            // A gestured entry is exempt — its licence was the save, which
            // already happened and can't be revoked by a later toggle.
            handledRef.current.delete(host);
            return;
          }
          if (stoppedRef.current) return;
          // Re-check under the single-flight guard: an earlier request may have
          // resolved this host since it was queued.
          const existing = await readFavicon(host);
          if (stoppedRef.current || usernameRef.current !== owner) return;
          if (!isFaviconStale(existing)) return;

          let bytes: Uint8Array | undefined;
          try {
            bytes = await fetchFaviconBytes(host);
          } catch {
            // Every failure mode lands here alike — DNS, timeout, TLS, transport.
            // All record `none`: the icon is decoration, so there's no case where
            // retrying it on the next render is worth a request, and the row ages
            // out via FAVICON_RETRY_MS (web's rationale, verbatim).
            bytes = undefined;
          }
          // Unmounted while the request was out: the answer belongs to nobody.
          if (stoppedRef.current) return;
          if (bytes === undefined) await putFaviconNone(owner, host);
          else await putFavicon(owner, host, bytes);
        } catch {
          // The write itself failed, or the store fenced it (the account signed
          // out under the fetch). Nothing to do — the row stays absent, the icon
          // stays a monogram, and a later mount re-asks.
        } finally {
          inFlightRef.current -= 1;
          if (!stoppedRef.current && queueRef.current.length > 0) setTimeout(pump, STAGGER_MS);
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
      const owner = usernameRef.current;
      if (!owner) return;
      if (handledRef.current.has(host)) return;
      handledRef.current.add(host);
      queueRef.current.push({ host, gestured: false, owner });
      pump();
    },
    [enabled, pump],
  );

  // The gestured entry point (see the header). Reads its one reactive input through
  // a ref, so its identity never changes — which is what lets `extractNow` stay
  // usable from ShareBridge's effect deps.
  const requestFaviconNow = useCallback(
    (hosts: string[]) => {
      const owner = usernameRef.current;
      if (offRef.current || !owner) return;
      let queued = false;
      for (const host of hosts) {
        if (host === '' || handledRef.current.has(host)) continue;
        handledRef.current.add(host);
        queueRef.current.push({ host, gestured: true, owner });
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
