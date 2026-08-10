// The favicon VERDICT — "are these bytes an icon we should cache?" — shared by
// every filler on every platform, so the answer can't drift between them.
//
// Four fillers ask it today: expo's guess (`fetchFaviconBytes`) and its
// declared-icon capture (lib/device-extraction.ts), and web's guess through the
// extractor proxy (contexts/favicon-provider.tsx) — plus web's RENDER path,
// which needs the mime this returns to build a Blob an `<img>` will decode.
// Their FETCHES are legitimately different (direct native GET vs. proxied,
// different timeouts, different failure policy); this verdict is the one part
// that genuinely is the same question, which is why only it lives here.
//
// WHY THE CAP IS A CLIENT CONCERN ON BOTH PLATFORMS. Neither transport bounds
// this for us:
//
//  - expo fetches directly, and RN's fetch has no streaming reader — the check
//    can only run after the body lands, so it bounds what gets CACHED rather
//    than what crosses the wire.
//  - web fetches through bracemark-extractor's `GET /v1/image`, whose
//    `MAX_IMAGE_BYTES` ceiling is 10 MB. That is the PROXY's abuse floor, sized
//    for a hero og:image and shared with that path — it is not, and shouldn't
//    become, a statement about icons. Without the check below, a host serving a
//    multi-megabyte body at `/favicon.ico` had it streamed through and written
//    to `db.favicons`, charged against the origin's storage quota, where `ok`
//    rows never expire (favicon-store.ts).
//
// So the ceiling that means "not an icon" belongs here, at the write edge both
// platforms share, applied to bytes already in hand.

import { isSvgBytes, sniffImageMime } from '../image/sniff';

// A favicon is ~1–2 KB; anything past this is not an icon (a misconfigured
// server streaming a page or media at the guessed path, or a `<link rel=icon>`
// pointing at a hero image). Generous by two orders of magnitude, because the
// cost of being wrong in the strict direction is a permanent monogram on a site
// that does have an icon.
export const MAX_FAVICON_BYTES = 512 * 1024;

// The icon path's mime, or undefined if these bytes aren't one we can render.
// WIDER than `sniffImageMime` alone, and deliberately: an icon is only ever
// RENDERED (never probed, resized or re-encoded), so the bar is whatever the
// icon renderers decode — which includes SVG. That's the whole gap between the
// two sniffs; image/sniff.ts's headers own the reasoning.
//
// The mime is returned rather than a bare boolean because web needs it: an
// object URL for a typeless Blob is served as no content-type, and while
// browsers content-sniff RASTER bytes in an `<img>`, they do NOT sniff SVG —
// `image/svg+xml` has to be declared or the icon silently fails to paint. Expo
// needs no such thing (expo-image sniffs the file itself) and takes the boolean
// below.
export function sniffIconMime(bytes: Uint8Array): string | undefined {
  // A zero-byte 200 is a "sure, whatever" response, not an icon; the cap rejects
  // non-icons and the sniffs reject non-images.
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FAVICON_BYTES) return undefined;
  return sniffImageMime(bytes) ?? (isSvgBytes(bytes) ? 'image/svg+xml' : undefined);
}

// The same verdict as a boolean, for the fetching paths that only gate on it.
export function isRenderableIconBytes(bytes: Uint8Array): boolean {
  return sniffIconMime(bytes) !== undefined;
}
