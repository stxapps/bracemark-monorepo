import { File, Paths } from 'expo-file-system';

import { newId } from '@stxapps/expo-crypto';
import {
  type ExtractVerdict,
  hostFromUrl,
  idFromPath,
  isRenderableIconBytes,
  LINKS_PREFIX,
  mapLimit,
  newFacet,
  selectFaviconUrl,
  selectTitleImage,
  sniffImageMime,
  verdictForStatus,
} from '@stxapps/shared';

import { putFavicon, readFavicon } from '../data/favicon-store';
import {
  type ExtractionFields,
  type ExtractionPatch,
  writeExtraction,
  writeFile,
} from '../data/mutations';
import { type LinkItem, readExtraction } from '../data/queries';
import { probeImageSize, resizeImage } from './image';
import { decodeHtmlBytes, parseHtmlHead } from './parse-html-head';
import { USER_AGENT } from './user-agent';

// The ON-DEVICE extraction worker: fill a page of links' `titleImage` facet by fetching
// each page HERE, on the phone, then write back — the (resized) image into `files/`, the
// title/imageId display fields + the facet's done/failed bookkeeping into
// `extractions/{id}.enc`. The expo sibling of web-react's `runServerTitleImageBatch`
// (that header is canonical for the WRITE half: writer-split — never `links/{id}.enc`;
// titles before images; per-link outcomes recorded, never thrown; `titleImage` only).
//
// What differs is the FETCH half, and it differs completely:
//
//  - NO `bracemark-extractor`, ever (docs/link-extraction.md — _expo drains in the
//    foreground_). Native HTTP has no CORS, so there's nothing the server buys back
//    here; routing through it would downgrade the tier (`server` = 1 vs `expo:fg` = 3),
//    spend a paid rate-limited request, disclose the URL to a party that would otherwise
//    never see it, and sit behind a plan gate on-device extraction doesn't need.
//  - NO BATCH REQUEST. Web sends one `extractMany` and the server fans out; here each
//    link is its own fetch, pooled at CONCURRENCY. So there is no "the request failed"
//    event to propagate — see _when this throws_ below, which is the one place the
//    web worker's error contract had to be rebuilt rather than ported.
//  - The IMAGE lands as a FILE, not bytes: fetched bytes go to a temp file, get probed
//    for dimensions and resized path-to-path, and only the resized file is stored
//    (file-store.ts's doctrine — content stays out of the JS heap).
//  - The page's DECLARED FAVICON is captured in the same breath (the doc's carve-out):
//    we already hold the HTML of a host this device just contacted, so `<link rel=icon>`
//    costs no disclosure the page fetch didn't already pay, and beats favicon-provider's
//    `/favicon.ico` guess on accuracy. It happens ONLY here, never as a standalone fetch —
//    and with the un-gestured opt-in OFF it's restricted to the page's OWN host, since the
//    "already paid for" argument doesn't reach the third-party CDN an icon href may name.
//
// WHEN THIS THROWS. Web propagates a wholesale transport failure because one failed
// request tells it nothing about any link, and recording `failed` on all of them would
// burn every link's backoff. The same hazard exists here in one shape only: the device
// is OFFLINE (or the radio dropped), where every fetch rejects for a reason that has
// nothing to do with the hosts. So a link whose fetch threw at the TRANSPORT level (no
// HTTP response at all) is held back rather than recorded; at the end of the batch, if
// some other link in it did get a response, the held-back ones are genuinely per-host
// failures and are recorded as such — but if NOTHING got a response, the original
// `TypeError` is rethrown, which `isRetryableTransportError` classifies as retryable, so
// the drain stops and backs off with no backoff burned. Every other per-link outcome
// (HTTP status, unparseable page, image failure) is RECORDED and never thrown, so the
// drain always makes progress and never re-picks the same link forever.

// The `platform:env` tier string this run writes into every facet (`tierOf` ranks quality
// from it — `:fg` = 3, the active-page ceiling). Foreground drains pass `expo:fg`; the
// deferred `BGAppRefreshTask`/WorkManager sweep will pass `expo:bg`, which ranks below it
// so a later foreground sighting can UPGRADE what a background sweep wrote.
export type DeviceExtractionTier = 'expo:fg' | 'expo:bg';

export interface DeviceExtractionOptions {
  // Is the extraction mode `all` — i.e. is UN-GESTURED work permitted? The drain only ever
  // runs when it is; `extractNow` also runs at `saves`, because the save IS the gesture
  // (neither runs at `off`, which the provider checks). It licenses exactly
  // one extra thing in here: fetching a declared favicon from a host OTHER than the page's
  // own. The carve-out that lets us capture an icon at all is "this costs no disclosure the
  // page fetch didn't already pay" — true for the page's own host, false for the third-party
  // CDN a `<link rel=icon>` may point at, which the save gesture never implied. So with the
  // opt-in off, a cross-origin icon is skipped rather than fetched.
  optedIn: boolean;
}

// How many links are fetched at once. Sized for the RADIO and the target hosts, not a
// server's fan-out: wide enough that a screenful fills quickly, narrow enough that a
// scroll through 20 distinct hosts doesn't open 20 sockets, drain the battery in a burst,
// or look like a crawler to any one of them.
const CONCURRENCY = 3;

// Per-request leashes. The page fetch is what a user may be watching fill in, so it gets
// a short one; the image is decoration arriving after the title already landed, so it can
// wait a little longer.
const PAGE_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 20_000;

// Byte ceilings, enforced AFTER the body lands: RN's fetch has no streaming reader, so
// this can't abort mid-transfer (the same limitation favicon-provider documents). It
// still bounds what we DECODE, PARSE and STORE, which is the part that costs.
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// A declared favicon's own cap (and the sniff that goes with it) is `@stxapps/shared`'s
// `isRenderableIconBytes` — one verdict for every filler on both platforms, so they can't
// drift apart on what counts as an icon.

// Extract one page of links' `titleImage` facet on-device. Returns the number of links
// processed (for the caller's auto-budget). Throws only in the offline case described in
// the header; every per-link outcome is recorded.
export async function runDeviceTitleImageBatch(
  username: string,
  links: LinkItem[],
  tier: DeviceExtractionTier,
  opts: DeviceExtractionOptions,
): Promise<number> {
  if (links.length === 0) return 0;

  // De-dupe URLs (the same article saved twice shares one fetch) and map each URL back to
  // every link that carries it, so one result covers them all — web's grouping, verbatim.
  const linksByUrl = new Map<string, LinkItem[]>();
  for (const link of links) {
    const group = linksByUrl.get(link.url);
    if (group) group.push(link);
    else linksByUrl.set(link.url, [link]);
  }

  // Links whose fetch never reached a server, and the first such error — resolved once
  // the whole batch is in (see _when this throws_).
  const unreached: LinkItem[][] = [];
  let unreachedErr: unknown;
  let reachedSomething = false;

  await mapLimit([...linksByUrl.entries()], CONCURRENCY, async ([url, targets]) => {
    try {
      const reached = await extractOne(username, url, targets, tier, opts);
      if (reached) reachedSomething = true;
      else {
        unreached.push(targets);
        unreachedErr ??= new TypeError('device extraction: network request failed');
      }
    } catch (err) {
      // A throw from the WRITE half (store/file failure) or a bug — not a statement about
      // the host, but recording a transient failure is still the safe move: the link is
      // retried after a backoff instead of being re-picked on the very next scan.
      unreachedErr ??= err;
      await settle(username, targets, tier, 'failed');
      reachedSomething = true;
    }
  });

  if (unreached.length > 0) {
    // Some host answered, so the failures were about those hosts, not the connection.
    if (reachedSomething) {
      for (const targets of unreached) await settle(username, targets, tier, 'failed');
    } else {
      // Nothing answered — the device is offline. Record nothing (no backoff burned) and
      // let the drain back off: a TypeError is what `isRetryableTransportError` wants.
      throw unreachedErr ?? new TypeError('device extraction: network request failed');
    }
  }

  return links.length;
}

// One URL's whole life: fetch → parse → select → title write → image write → favicon.
// Returns false ONLY when the fetch never reached a server (the caller defers those);
// every other outcome is recorded here and returns true.
async function extractOne(
  username: string,
  url: string,
  targets: LinkItem[],
  tier: DeviceExtractionTier,
  opts: DeviceExtractionOptions,
): Promise<boolean> {
  const page = await fetchPage(url);
  if (page.kind === 'unreached') return false;
  if (page.kind === 'status') {
    const verdict = await verdictForStatus(page.status, () => priorAttempts(targets));
    await settle(username, targets, tier, verdict);
    return true;
  }

  // PASS 1 — the title, written on its own with the facet left PENDING, so the list fills
  // with real titles before any image is fetched (web's two-pass ordering; the image pass
  // below sets the terminal state). A page that genuinely has no title settles `done`
  // anyway: there's nothing to come back for, and `host(url)` is the render fallback.
  const collected = parseHtmlHead(decodeHtmlBytes(page.bytes, page.contentType));
  const { title, imageUrl } = selectTitleImage(collected, page.finalUrl);
  if (title) await writeAll(username, targets, { fields: { title } });

  // PASS 2 — the image, then the TERMINAL facet write. A transient image failure leaves
  // the facet `failed` so backoff retries it (the image isn't lost to a passing blip) with
  // the title from pass 1 already visible; anything else settles `done`.
  const image = await loadImage(imageUrl);
  const fields: ExtractionFields = {};
  if (image.kind === 'file') {
    try {
      const imageId = newId();
      await writeFile(username, imageId, image.file); // content before metadata
      fields.imageId = imageId;
    } finally {
      deleteQuietly(image.file);
    }
  }
  await writeAll(username, targets, {
    fields,
    facet: 'titleImage',
    state: newFacet(image.kind === 'transient' ? 'failed' : 'done', tier),
  });

  // The carve-out (header): capture the icon this page DECLARED, since we're already here.
  await captureDeclaredFavicon(collected, page.finalUrl, opts);
  return true;
}

// --- the fetches -------------------------------------------------------------

type PageResult =
  | { kind: 'html'; bytes: Uint8Array; contentType: string | undefined; finalUrl: URL }
  // The server answered, but not with a page we can use — classified by status.
  | { kind: 'status'; status: number }
  // No HTTP response at all (offline, DNS, TLS, timeout) — the caller defers this.
  | { kind: 'unreached' };

// Fetch a link's HTML. Non-http(s) is reported as a synthetic `0` status (permanent —
// nothing to fetch); a non-HTML content-type is reported as `415` (also permanent: a PDF
// or an image URL is never going to become a page with an og:title).
async function fetchPage(url: string): Promise<PageResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: 'status', status: 0 };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { kind: 'status', status: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(target.toString(), {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
      // Follow redirects: the page we end up at is the one whose metadata we mean, and
      // its FINAL url is what relative og:image/icon hrefs resolve against.
      redirect: 'follow',
    });
    if (!res.ok) return { kind: 'status', status: res.status };

    const contentType = res.headers.get('content-type') ?? undefined;
    if (contentType !== undefined && !/^\s*(text\/html|application\/xhtml)/i.test(contentType)) {
      return { kind: 'status', status: 415 };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    // Over the cap we keep the PREFIX rather than discarding the response: everything we
    // want is in `<head>`, so a truncated giant page still extracts correctly.
    const body = bytes.byteLength > MAX_PAGE_BYTES ? bytes.subarray(0, MAX_PAGE_BYTES) : bytes;
    if (body.byteLength === 0) return { kind: 'status', status: 204 };

    // `res.url` is the post-redirect location; RN leaves it empty on some paths, so fall
    // back to the requested URL rather than resolving relative hrefs against nothing.
    let finalUrl = target;
    try {
      if (res.url) finalUrl = new URL(res.url);
    } catch {
      // keep `target`
    }
    return { kind: 'html', bytes: body, contentType, finalUrl };
  } catch {
    // Transport: offline, DNS, TLS, or our own abort. Indistinguishable per-link, which
    // is exactly why the batch — not this function — decides what it meant.
    return { kind: 'unreached' };
  } finally {
    clearTimeout(timer);
  }
}

type ImageOutcome =
  // A temp file holding the (already resized) preview. The caller stores it and deletes it.
  | { kind: 'file'; file: File }
  // Nothing to fetch, or nothing usable came back — settle `done`, title-only.
  | { kind: 'none' }
  // Retryable image failure — leave the facet for a retry.
  | { kind: 'transient' };

// Fetch the selected preview image and prepare it for `files/`: bytes → temp file → probe
// dimensions → resize. All three primitives are image.ts's; the PROBE is required, not
// incidental — see its header for why a downloaded image can't skip it.
async function loadImage(imageUrl: string | undefined): Promise<ImageOutcome> {
  if (!imageUrl) return { kind: 'none' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  let temp: File | undefined;
  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Same split as the web worker's proxy errors: a throttle/5xx is worth retrying,
      // a plain 4xx means this image is simply not available to us.
      return res.status === 429 || res.status >= 500 ? { kind: 'transient' } : { kind: 'none' };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    // The sniff is the real content check: an og:image pointing at an HTML error page has
    // to become `none`, not a file the UI can't render. It stays the RASTER sniff even
    // though the icon path's is now wider — a stored preview is measured, capped and
    // re-encoded on its way in (probeImageSize → resizeImage, both raster-only), so an SVG
    // accepted here would skip the cap and land whole in the user's quota.
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return { kind: 'none' };
    if (sniffImageMime(bytes) === undefined) return { kind: 'none' };

    temp = newTempFile();
    temp.write(bytes);

    const size = await probeImageSize(temp.uri);
    if (!size) return { kind: 'none' }; // decoder refused it — not an image we can show.

    const capped = await resizeImage({ uri: temp.uri, width: size.width, height: size.height });
    if (capped.uri === temp.uri) {
      const file = temp;
      temp = undefined; // handed to the caller; don't delete it here
      return { kind: 'file', file };
    }
    return { kind: 'file', file: new File(capped.uri) };
  } catch {
    // Transport error on the image alone — the title already landed, so this is worth one
    // more try later rather than settling the link without a preview.
    return { kind: 'transient' };
  } finally {
    clearTimeout(timer);
    if (temp) deleteQuietly(temp);
  }
}

// The page's declared `<link rel="icon">`, cached for the host — the accuracy upgrade over
// favicon-provider's `/favicon.ico` guess, allowed here because this device just fetched
// the page (docs/link-extraction.md — _favicons_, the expo carve-out). Never records
// `none` on failure: "this page's declared icon didn't load" is not "this host has no
// icon", and writing `none` would poison the guess path that might still succeed.
//
// Keyed by the FINAL (post-redirect) host, which is the host that actually declared the
// icon. A cross-host redirect (`t.co/x` → `example.com`) therefore fills `example.com`'s
// row while the UI, keyed on the SAVED url's host, still asks for `t.co` — a miss, not a
// wrong answer, and the guess path fetches `t.co/favicon.ico`, which is the correct icon
// for a row labelled `t.co`. Re-keying this to the saved host would paint the first
// destination's icon on every other link saved through the same shortener.
async function captureDeclaredFavicon(
  collected: ReturnType<typeof parseHtmlHead>,
  finalUrl: URL,
  { optedIn }: DeviceExtractionOptions,
): Promise<void> {
  try {
    const iconUrl = selectFaviconUrl(collected, finalUrl);
    if (!iconUrl) return;

    const host = hostFromUrl(finalUrl);
    if (host === '') return;
    // Un-gestured opt-in off ⇒ we're here on a save gesture, which pays for this page's own
    // host and nothing else. See DeviceExtractionOptions.
    if (!optedIn && hostFromUrl(new URL(iconUrl)) !== host) return;
    // Only when the host has no bytes yet. NOT `isFaviconStale`: a fresh `none` row is not
    // stale, and deferring to it would let the guess path's miss block the more accurate
    // source for FAVICON_RETRY_MS — the exact inversion the two-filler rule (favicon-store's
    // `putFaviconNone` header) exists to prevent. `readFavicon` folds the file check, so an
    // `ok` here means real bytes on disk, which is the one thing worth skipping for.
    if ((await readFavicon(host))?.status === 'ok') return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(iconUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) return;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!isRenderableIconBytes(bytes)) return;
      await putFavicon(host, bytes);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Decoration on top of decoration: a failure here can never affect the link's verdict.
  }
}

// --- outcome classification --------------------------------------------------

// The status → `failed`/`permanent` rules are `@stxapps/shared`'s `verdictForStatus`
// (extract/retry.ts), NOT expo's own: the verdict SYNCS (a `permanent` facet stops every
// device retrying), so the server tier — which reaches the same rules through
// `verdictForExtractError` once bracemark-extractor relays the upstream code — and this one
// must classify a 404 identically, or a link's fate would depend on which device saw it
// first. Our synthetic statuses (`0`/`415`/`204` from fetchPage) are part of that shared
// vocabulary. All that's left here is reading the attempt count the 403 ladder asks for.

// How many times this link's `titleImage` has already failed. Passed as a THUNK so it's
// read only for the `403` ladder and the common paths stay decode-free. Group members share
// a URL but not a facet, so the MAX is the honest count for the decision.
async function priorAttempts(targets: LinkItem[]): Promise<number> {
  let attempts = 0;
  for (const link of targets) {
    const extraction = await readExtraction(idFromPath(link.path, LINKS_PREFIX));
    attempts = Math.max(attempts, extraction?.facets.titleImage?.attempts ?? 0);
  }
  return attempts;
}

// --- writes + small helpers --------------------------------------------------

// Apply one extraction patch to every link in a group (links sharing a URL). Identity comes
// from the PATH — the one authority a round-tripped blob can't drift from — same as the
// pending query, not from any `id` copy inside the blob.
function writeAll(username: string, links: LinkItem[], patch: ExtractionPatch): Promise<unknown> {
  return Promise.all(
    links.map((link) => writeExtraction(username, idFromPath(link.path, LINKS_PREFIX), patch)),
  );
}

// Record a terminal outcome with no fields — the "we never got a usable page" write.
function settle(
  username: string,
  links: LinkItem[],
  tier: DeviceExtractionTier,
  status: ExtractVerdict,
): Promise<unknown> {
  return writeAll(username, links, { facet: 'titleImage', state: newFacet(status, tier) });
}

// A scratch location for one in-transit image. The cache dir on purpose (transient by
// definition — an OS purge costs nothing) and uniquely named so pooled links never collide;
// the caller deletes it when the write settles. file-store's `newTempEncFile` sibling.
function newTempFile(): File {
  return new File(Paths.cache, `bracemark-extract-${newId()}`);
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // A leftover in the cache dir is the OS's problem, not a reason to fail an extraction.
  }
}
