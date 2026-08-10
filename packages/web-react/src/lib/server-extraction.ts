import {
  ApiError,
  base64ToBytes,
  cleanTitle,
  type ExtractClient,
  type ExtractResult,
  idFromPath,
  LINKS_PREFIX,
  mapLimit,
  MAX_EXTRACT_URLS,
  newFacet,
  verdictForExtractError,
} from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';

import {
  type ExtractionFields,
  type ExtractionPatch,
  writeExtraction,
  writeFile,
} from '../data/mutations';
import { type LinkItem, readExtraction } from '../data/queries';
import { resizeImage } from './resize-image';

// The SERVER-tier extraction worker: extract a PAGE of links' `titleImage` facet via
// `bracemark-extractor`, then write back — each (resized) image into `files/`, the
// title/imageId display fields + the facet's done/failed bookkeeping into
// `extractions/{id}.enc`. The shared counterpart of the extension's `runExtraction`
// (apps/bracemark-extension), but driven by an HTTP extract instead of an active-tab
// capture, so its `extractedBy` is `server` (the lowest tier — `tierOf` → 1) and a
// later active-page sighting can UPGRADE it.
//
// BATCHED for latency (docs/link-extraction.md "server extraction"): one `extractMany`
// returns every link's title + imageUrl in ~one round trip — the server resolves the
// URLs CONCURRENTLY — instead of N sequential single-URL calls. We then write TITLES
// FIRST (the page fills with real titles immediately) and fill IMAGES after, through the
// streaming proxy at a small concurrency. A single link short-circuits to the inline
// single-URL path (one round trip, no proxy) — the human-waiting save.
//
// Like the extension worker it writes ONLY `extractions/` + `files/`, NEVER
// `links/{id}.enc` (the writer-split — docs/link-extraction.md), so a backfill can't
// clobber a concurrent user edit. It only ever does `titleImage`: the server tier can't
// screenshot/page copy (no renderer) and read-mode parity isn't promised, so those facets
// stay active-context only.
//
// Throws on a wholesale TRANSPORT failure of the extract request itself
// (network/abort/non-2xx) — plus a fail-fast guard if handed more than MAX_EXTRACT_URLS
// links (a caller-contract violation; the drains bound a page to that cap). A transport
// failure isn't a per-link outcome — it tells us nothing about any link — so it propagates
// and the caller stops the drain to retry on the next wake, rather
// than mislabeling every link `failed` (which would burn each link's backoff, flood sync
// with no-op writes, and — in extractAll — march the cursor through the whole library
// writing failures). Every PER-LINK outcome (success, transient failure, permanent failure)
// is instead RECORDED as a facet write and never re-throws, so once the request succeeds the
// drain always makes progress — a processed link becomes settled (`done`, or
// `failed`/`permanent` which the pending query then skips via backoff) and is never
// re-picked on the next scan.
const EXTRACTED_BY = 'server';

// How many image-proxy fetches run at once during a batch's image pass. The extract call
// is ONE request (the server fans out), but each discovered image is its own streaming
// GET /v1/image against the same IP-rate-limited origin — so we pool them at a small
// width rather than firing one per link: fast enough to fill a page quickly, gentle
// enough not to trip the limiter into 429s.
const IMAGE_CONCURRENCY = 3;

// Extract a batch of links' `titleImage` facet in one shot — the path behind the
// displayed-scoped / extract-all drains (extraction-provider). Returns the number of links
// processed (for the caller's auto-budget). Throws only on a transport failure or an
// oversized batch (see above); per-link outcomes are recorded, never thrown.
export async function runServerTitleImageBatch(
  username: string,
  links: LinkItem[],
  client: ExtractClient,
): Promise<number> {
  if (links.length === 0) return 0;
  if (links.length > MAX_EXTRACT_URLS) {
    throw new Error(`runServerTitleImageBatch: ${links.length} links exceeds MAX_EXTRACT_URLS`);
  }

  // De-dupe URLs (the same article saved twice shares one fetch) and map each URL back to
  // every link that carries it, so one result covers them all.
  const linksByUrl = new Map<string, LinkItem[]>();
  for (const link of links) {
    const group = linksByUrl.get(link.url);
    if (group) group.push(link);
    else linksByUrl.set(link.url, [link]);
  }
  const urls = [...linksByUrl.keys()];

  // N === 1 keeps inline (the human-waiting single save); N > 1 batches metadata. A
  // wholesale failure here (network/abort/non-2xx) is a TRANSPORT error, not a per-link
  // outcome, so we let it propagate: the caller's drain stops and retries on the next wake
  // instead of recording a bogus `failed` on every link. Per-link failures are still
  // recorded below, in passes 1–2.
  const results: ExtractResult[] =
    urls.length === 1 ? [await client.extract(urls[0])] : await client.extractMany(urls);

  const resultsByUrl = new Map(results.map((result) => [result.url, result]));

  // PASS 1 — titles, written immediately so the page fills with real titles before any
  // image is fetched. An ok result writes its title FIELDS-ONLY (facet left pending) so
  // the image pass can still set the terminal state; a failed result is terminal here
  // (the pending query then skips it via backoff). Carry the ok results into pass 2.
  const pending: { result: ExtractResult; targets: LinkItem[] }[] = [];
  await Promise.all(
    [...linksByUrl].map(async ([url, targets]) => {
      const result = resultsByUrl.get(url);
      if (!result) return; // server omitted this URL — leave pending for a later scan.
      if (!result.ok) {
        // The SAME verdict rules bracemark-expo applies to a page it fetched itself — the
        // extractor relays the upstream status on `bad_status`, so a 404 settles
        // `permanent` here too rather than being retried daily forever. The status
        // decides when present; otherwise the error enum's transient default holds.
        // `priorAttempts` is a thunk because only the 403 ladder reads it (a decode).
        const verdict = await verdictForExtractError(result.error, result.status, () =>
          priorAttempts(targets),
        );
        await writeAll(username, targets, {
          facet: 'titleImage',
          state: newFacet(verdict, EXTRACTED_BY),
        });
        return;
      }

      // cleanTitle caps to LINK_TITLE_MAX (the same normalizer the extension + the server
      // run), so the value satisfies `extractionSchema.title`.
      const title = cleanTitle(result.title);
      if (title) await writeAll(username, targets, { fields: { title } });
      pending.push({ result, targets });
    }),
  );

  // PASS 2 — images, pooled. Each ok link gets its preview (inline bytes or the proxy),
  // then the TERMINAL facet write: done (image stored, or none to fetch), or failed
  // when the image fetch was a retryable throttle/5xx — the title is already visible
  // either way. Per-item failures are swallowed into a transient facet write so the
  // pool (and the whole function) never throws.
  await mapLimit(pending, IMAGE_CONCURRENCY, async ({ result, targets }) => {
    try {
      const fields: ExtractionFields = {};

      const image = await loadImage(result, client);
      if (image.kind === 'bytes') {
        // Cap dimensions + re-encode before storing, to bound the quota (the deferred
        // client thumbnailing step — the extractor never resizes). Content before
        // metadata: write the `files/` blob, then reference it from `extractions/`.
        const resized = await resizeImage(image.bytes);
        const imageId = newId();
        await writeFile(username, imageId, resized);
        fields.imageId = imageId;
      }
      // A transient image failure leaves the facet `failed` so backoff retries it (the
      // image isn't lost to a passing throttle); otherwise the facet settles `done`. The
      // writer bumps the retry counter only on a `failed` state (done resets to attempts: 0).
      const state = newFacet(image.kind === 'transient' ? 'failed' : 'done', EXTRACTED_BY);
      await writeAll(username, targets, { fields, facet: 'titleImage', state });
    } catch {
      // resize/write threw — record a transient failure so the link is retried, the
      // title from pass 1 intact.
      await writeAll(username, targets, {
        facet: 'titleImage',
        state: newFacet('failed', EXTRACTED_BY),
      });
    }
  });

  return links.length;
}

// A wholesale failure THROWN by runServerTitleImageBatch (the extract request itself —
// never a per-link outcome, which is recorded, not thrown) is classified retryable-or-not
// by `isRetryableTransportError` from @stxapps/shared (api/retry.ts: 429 / 5xx / network
// TypeError — a 429 now carries the server's Retry-After, which the drain prefers over its
// guessed backoff), so the drain can auto-resume a transient outage instead of stalling.
// The drain imports it straight from @stxapps/shared, beside its sibling `retryAfterMsOf`.
// A non-retryable throw (a non-429 4xx, the oversized-batch guard, a bug) still stops the
// drain rather than spinning.

// How many times this link's `titleImage` has already failed. Read only for the `403`
// ladder in `verdictForStatus`, so the common paths stay decode-free. Group members share
// a URL but not a facet, so the MAX is the honest count for the decision. The expo sibling
// (device-extraction.ts) is identical over its own store.
async function priorAttempts(targets: LinkItem[]): Promise<number> {
  let attempts = 0;
  for (const link of targets) {
    const extraction = await readExtraction(idFromPath(link.path, LINKS_PREFIX));
    attempts = Math.max(attempts, extraction?.facets.titleImage?.attempts ?? 0);
  }
  return attempts;
}

// Apply one extraction patch to every link in a group (links sharing a URL). Identity
// comes from the PATH (the one authority a round-tripped blob can't drift from), same as
// the pending query — not from any `id` copy inside the blob.
function writeAll(username: string, links: LinkItem[], patch: ExtractionPatch): Promise<unknown> {
  return Promise.all(
    links.map((link) => writeExtraction(username, idFromPath(link.path, LINKS_PREFIX), patch)),
  );
}

type ImageOutcome =
  | { kind: 'bytes'; bytes: Uint8Array }
  // No image available, or a permanent image error — settle `done`, title-only.
  | { kind: 'none' }
  // Retryable image fetch failure (429 / 5xx / network) — leave the facet for a retry.
  | { kind: 'transient' };

// The preview image for one ok result, by the client-signaled tradeoff: inline base64 when
// the single-URL `inlineImage` fetch succeeded (one round trip), else the streaming proxy
// on the discovered `imageUrl` (a second round trip). A proxy 429/5xx/network error is
// TRANSIENT (the facet is retried so the image isn't lost to a passing throttle); a non-429
// 4xx is permanent (settle `done` with the title, no image — the `web-only gap` behavior:
// no preview rather than a leaky remote <img src>). No `imageUrl` at all → nothing to fetch.
async function loadImage(result: ExtractResult, client: ExtractClient): Promise<ImageOutcome> {
  if (result.imageBase64) return { kind: 'bytes', bytes: base64ToBytes(result.imageBase64) };
  if (!result.imageUrl) return { kind: 'none' };

  try {
    return { kind: 'bytes', bytes: await client.fetchImage(result.imageUrl) };
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return { kind: 'none' };
    }
    return { kind: 'transient' };
  }
}
