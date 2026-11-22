import {
  type ExtractClient,
  idFromPath,
  keepOnSaveOf,
  LINKS_PREFIX,
  MAX_READ_MODE_PROXY_IMAGES,
  newFacet,
  READ_MODE_REASONS,
  readerDocSchema,
  readerDocWithinCaps,
  type ReaderImageEntry,
  readModeVerdictOf,
} from '@stxapps/shared';

import { assertExtractionWritable, writeExtraction } from '../data/mutations';
import { type LinkItem, readExtraction, readSettingsGeneral } from '../data/queries';
import { storeReadModeCopy } from '../data/store-read-mode';
import { collectReaderImages } from './reader-images';

// The SERVER tier's read-mode copy for ONE link — bracemark-web's way to keep a page's
// text, since a web page can't fetch another site (docs/link-extraction-keep.md, _per
// client_). `bracemark-extractor` fetches the page, honours its robots.txt for this facet,
// and returns the article as a `ReaderDoc`; this file encrypts it into `files/` and points
// `extraction.readModeId` at it, exactly as the browser extension's capture does, but
// `extractedBy: 'server'` — the lowest tier, which a live-page capture can later replace.
//
// Only ever an EXPLICIT per-link ask (useServerReadMode — the reader's _Keep a read-mode copy_),
// never a drain: read mode is a whole article, and a standing rule that fetched articles
// for links nobody is looking at is the un-gestured fetch the keep doc's "no rules engine"
// rules out. The caller has already checked the plan (`keptCopies`) and the opt-in
// (`serverReadMode` — its own, not the preview opt-in; entities.ts says why).
//
// A copy that EXISTS is never replaced from here: it may be a live-page capture (a better
// tier, and the one a signed-in or paywalled page needs), and a copy with highlights is
// never replaced automatically at all (docs/reader.md, _re-anchoring_). So the store is
// checked before anything is written, and a copy that landed while the request ran wins.
//
// Throws on a TRANSPORT failure (network, a 429/5xx from the extractor, a timeout) —
// nothing about the page was learned, so nothing is recorded. Every answer about the page
// is recorded on the `readMode` facet, the same verdicts the other tiers reach.
const EXTRACTED_BY = 'server';

// The article's images come through the extractor's image proxy, ONE REQUEST EACH —
// where the browser extension's are fetches the page makes itself. The proxy is
// rate-limited per address for every caller (it is what a bulk import's previews go
// through too), so this path asks for fewer than a pack could hold, a few at a time:
// one article must not spend the minute's allowance. Past the count, and for any image
// the proxy refuses, the figure is a placeholder — a live-page capture of the same
// link keeps the rest. docs/link-extraction-keep.md, _images in read mode_. The count
// is MAX_READ_MODE_PROXY_IMAGES (@stxapps/shared), because /extractor publishes it.
const SERVER_IMAGES_CONCURRENCY = 3;
const SERVER_IMAGES_DEADLINE_MS = 45_000;

export type ServerReadModeOutcome =
  | { kind: 'kept' }
  // A copy was already there (or arrived meanwhile) — left alone.
  | { kind: 'exists' }
  // The page has no copy to give, for a settled reason (READ_MODE_REASONS) — or for a
  // passing one (`status: 'failed'`). `siteRefused`: the SITE turned the extractor away
  // (SITE_REFUSED_STATUSES), which the verdict alone can't tell from our own fault.
  | { kind: 'none'; status: 'failed' | 'permanent'; reason?: string; siteRefused?: true };

// The upstream answers that mean "this site won't serve our server", not "something
// broke": a sign-in wall, a bot wall, a rate limit on the extractor's addresses. YouTube
// answers every watch page with a 429 from Cloudflare's data centres (measured
// 2026-11-22 on staging, both hosts, both facets), and the reader said "Please try
// again" over it — a press that never works. The facet's verdict is NOT changed by this:
// a 429 stays transient there (retry.ts, `verdictForStatus`), as it is from every tier.
// Only what the reader SAYS changes — the site's refusal, and the way that still works,
// the page itself. docs/link-extraction-keep.md, _per client_, bracemark-web.
const SITE_REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

export async function runServerReadMode(
  username: string,
  link: LinkItem,
  client: ExtractClient,
): Promise<ServerReadModeOutcome> {
  const linkId = idFromPath(link.path, LINKS_PREFIX);
  if ((await readExtraction(linkId))?.readModeId) return { kind: 'exists' };
  // Before the round trip and the image fetches: a link whose extraction this device
  // could not open cannot take a copy, so nothing is asked of the extractor for it.
  await assertExtractionWritable(username, linkId);

  const result = await client.extractReadMode(link.url);
  let verdict = await readModeVerdictOf(
    result,
    async () => (await readExtraction(linkId))?.facets.readMode?.attempts ?? 0,
  );

  // Re-checked after the round trip, which can take a minute: a browser-extension save
  // of the same page may have kept a copy meanwhile.
  const current = await readExtraction(linkId);
  if (current?.readModeId) return { kind: 'exists' };

  // The response was parsed against the contract already; parsed again here because this is
  // the boundary where a server's bytes become the user's stored copy. And held to the store
  // edge's size ceilings (READER_STORE_*): a document past them is not an article, and settles
  // as one rather than being kept or retried.
  const doc = verdict.status === 'done' ? readerDocSchema.parse(result.readMode) : undefined;
  if (doc && !readerDocWithinCaps(doc)) {
    verdict = { status: 'permanent', reason: READ_MODE_REASONS.notAnArticle };
  }

  if (doc && verdict.status === 'done') {
    // The images, when the account keeps them. A failure in here is a copy without
    // pictures, never a failed keep: the text is the copy.
    let images: ReaderImageEntry[] = [];
    const sources = result.readModeImages ?? [];
    if (sources.length > 0) {
      try {
        if (keepOnSaveOf(await readSettingsGeneral()).readModeImages) {
          images = await collectReaderImages(
            sources,
            (url, signal) => client.fetchImage(url, signal),
            {
              maxCount: MAX_READ_MODE_PROXY_IMAGES,
              concurrency: SERVER_IMAGES_CONCURRENCY,
              deadlineMs: SERVER_IMAGES_DEADLINE_MS,
            },
          );
        }
      } catch {
        images = [];
      }
      // Fetching them took a while longer; the same check as above, for the same reason.
      if ((await readExtraction(linkId))?.readModeId) return { kind: 'exists' };
    }

    // Settles the document against what was kept, so no figure names a picture the
    // pack doesn't hold — with no images at all, every key comes off.
    const stored = await storeReadModeCopy(username, linkId, doc, images, EXTRACTED_BY);
    return stored
      ? { kind: 'kept' }
      : { kind: 'none', status: 'permanent', reason: READ_MODE_REASONS.notAnArticle };
  }

  // Every `done` verdict with a document returned above; the one without was never a copy.
  if (verdict.status === 'done') {
    return { kind: 'none', status: 'permanent', reason: READ_MODE_REASONS.notAnArticle };
  }

  // A settled answer from a better tier stays: a server `failed` must not overwrite an
  // extension's `permanent` "not an article", nor reset its bookkeeping.
  const prior = current?.facets.readMode;
  if (!prior || prior.extractedBy === EXTRACTED_BY || prior.status === 'failed') {
    await writeExtraction(username, linkId, {
      facet: 'readMode',
      state: newFacet(
        verdict.status,
        EXTRACTED_BY,
        verdict.reason ? { reason: verdict.reason } : {},
      ),
    });
  }
  const siteRefused =
    !result.ok &&
    result.error === 'bad_status' &&
    result.status !== undefined &&
    SITE_REFUSED_STATUSES.has(result.status);
  return {
    kind: 'none',
    status: verdict.status,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(siteRefused ? { siteRefused: true as const } : {}),
  };
}
