// The favicon GUESS — `https://{host}/favicon.ico` by direct native fetch.
//
// Transport only: no queue, no gate, no store write. The policy around this
// fetch (the fan-out bound, the stagger, the `deviceExtractionMode` gate, and
// the rule that every failure records `none`) stays in
// contexts/favicon-provider.tsx, which is the module that owns it.
//
//  - DIRECT, no extractor proxy. Web needs the proxy because a browser can't
//    read cross-origin image bytes; native HTTP has no CORS, and the design is
//    clients-do-the-work (docs/link-extraction.md — _favicons_, the bracemark-expo
//    row).
//  - Validity is a BYTE SNIFF, not a content-type: only bytes the render path
//    can decode count, so an HTML error page served at the guessed path is a
//    miss. An SVG is NOT — icons render through expo-image, which decodes it.
//    That verdict is `@stxapps/shared`'s `isRenderableIconBytes`, shared with
//    web's filler (which needs it MORE, since the extractor proxy's
//    `MAX_IMAGE_BYTES` is a 10 MB og:image ceiling, not a statement about
//    icons) — see extract/favicon.ts.
//
// Deliberately NOT in lib/device-extraction.ts, whose header draws the line this
// module sits on the other side of: that worker captures a `<link rel=icon>` as a
// byproduct of a page fetch it already paid for — "no disclosure the page fetch
// didn't already pay" — and it says plainly that this happens ONLY there, never
// as a standalone fetch. THIS is the standalone fetch: nothing on this device has
// contacted the host, which is why its caller keeps it behind the opt-in. Two
// different licences, two different modules; what they legitimately share is the
// icon verdict (now in `@stxapps/shared`, since web's filler shares it too) and
// the User-Agent, neither of which lives here.

import { isRenderableIconBytes } from '@stxapps/shared';

import { USER_AGENT } from './user-agent';

// One site not answering must not pin a queue slot — decoration, so a short leash;
// the caller records `none` like every other miss.
const FETCH_TIMEOUT_MS = 10_000;

// Bytes if the host serves a renderable icon at the guessed path, undefined
// otherwise. Throws only on transport errors — the caller records `none` for
// those too, so the split is cosmetic.
export async function fetchFaviconBytes(host: string): Promise<Uint8Array | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${host}/favicon.ico`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return isRenderableIconBytes(bytes) ? bytes : undefined;
  } finally {
    clearTimeout(timer);
  }
}
