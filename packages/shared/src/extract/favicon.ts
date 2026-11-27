// The favicon VERDICT — "are these bytes an icon we should cache?" — shared by
// every filler on every platform, so the answer can't drift between them.
//
// Four fillers ask it today: expo's guess (`fetchFaviconBytes`) and its
// declared-icon capture (lib/device-link-previews.ts), and web's guess through the
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
//  - web fetches through bracemark-extractor's `POST /v1/fetch-image`, whose
//    `MAX_IMAGE_BYTES` ceiling is 10 MB. That is the PROXY's abuse floor, sized
//    for a hero og:image and shared with that path — it is not, and shouldn't
//    become, a statement about icons. Without the check below, a host serving a
//    multi-megabyte body at `/favicon.ico` had it streamed through and written
//    to `db.favicons`, charged against the origin's storage quota, where `ok`
//    rows never expire (favicon-store.ts).
//
// So the ceiling that means "not an icon" belongs here, at the write edge both
// platforms share, applied to bytes already in hand.

import { imageHeaderSize } from '../image/header-size';
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

// The most pixels a raster icon may decode to: 2048 × 2048, 16 MiB at four bytes a
// pixel. An icon is drawn at 16–64 pt and the largest any site declares is a 1024 px
// touch icon, so this refuses nothing real — but the byte cap doesn't bound a decode: a
// 76 KB PNG can claim 20000 × 20000, and expo-image decodes an icon at full size on iOS
// (1.6 GB, per row that shows it). Read from the header (image/header-size.ts), before
// any decoder sees the bytes.
export const FAVICON_MAX_DECODE_PIXELS = 2048 * 2048;

// The verdict every FILLER gates on before it stores an icon, on both platforms: an
// icon `sniffIconMime` takes, and — for a raster one — a header that says what it will
// decode to, within FAVICON_MAX_DECODE_PIXELS. SVG has no pixel size of its own (its
// renderer draws it at the size it's shown). The size check is not in `sniffIconMime`,
// which web runs at RENDER time to type the Blob.
export function isRenderableIconBytes(bytes: Uint8Array): boolean {
  return sniffIconMime(bytes) !== undefined && !isOversizedRasterIcon(bytes);
}

// The size half alone: a RASTER icon whose header can't be read or claims more than
// FAVICON_MAX_DECODE_PIXELS. False for anything that isn't a raster image, SVG included.
// Reads magic bytes and a header (for a GIF, every block to its trailer — at most
// MAX_FAVICON_BYTES), and decodes no text, so a store can run it over every icon it
// hands out. That is how icons cached before the size check existed
// (2026-11-26) are re-checked: web's `readFavicon` on every read, expo's favicon store
// once per install (docs/link-extraction-favicons.md, _what counts as
// an icon_).
export function isOversizedRasterIcon(bytes: Uint8Array): boolean {
  if (sniffImageMime(bytes) === undefined) return false;
  const size = imageHeaderSize(bytes);
  return size === undefined || size.width * size.height > FAVICON_MAX_DECODE_PIXELS;
}
