import {
  type ExtractClient,
  idFromPath,
  LINKS_PREFIX,
  newFacet,
  readerDocSchema,
  readModeVerdictOf,
} from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';

import { writeExtraction, writeFile } from '../data/mutations';
import { type LinkItem, readExtraction } from '../data/queries';
import { encodeReaderDoc } from './reader-doc-bytes';

// The SERVER tier's read-mode copy for ONE link — bracemark-web's way to keep a page's
// text, since a web page can't fetch another site (docs/link-extraction-keep.md, _per
// client_). `bracemark-extractor` fetches the page, honours its robots.txt for this facet,
// and returns the article as a `ReaderDoc`; this file encrypts it into `files/` and points
// `extraction.readModeId` at it, exactly as the browser extension's capture does, but
// `extractedBy: 'server'` — the lowest tier, which a live-page capture can later replace.
//
// Only ever an EXPLICIT per-link ask (useServerReadMode — the reader's _Keep read mode_),
// never a drain: read mode is a whole article, and a standing rule that fetched articles
// for links nobody is looking at is the un-gestured fetch the keep doc's "no rules engine"
// rules out. The caller has already checked the plan (`keptCopies`) and the opt-in
// (`serverExtraction`).
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

export type ServerReadModeOutcome =
  | { kind: 'kept' }
  // A copy was already there (or arrived meanwhile) — left alone.
  | { kind: 'exists' }
  // The page has no copy to give, for a settled reason (READ_MODE_REASONS) — or for a
  // passing one (`status: 'failed'`).
  | { kind: 'none'; status: 'failed' | 'permanent'; reason?: string };

export async function runServerReadMode(
  username: string,
  link: LinkItem,
  client: ExtractClient,
): Promise<ServerReadModeOutcome> {
  const linkId = idFromPath(link.path, LINKS_PREFIX);
  if ((await readExtraction(linkId))?.readModeId) return { kind: 'exists' };

  const result = await client.extractReadMode(link.url);
  const verdict = await readModeVerdictOf(
    result,
    async () => (await readExtraction(linkId))?.facets.readMode?.attempts ?? 0,
  );

  // Re-checked after the round trip, which can take a minute: a browser-extension save
  // of the same page may have kept a copy meanwhile.
  const current = await readExtraction(linkId);
  if (current?.readModeId) return { kind: 'exists' };

  if (verdict.status === 'done') {
    // The response was parsed against the contract already; parsed again here because
    // this is the boundary where a server's bytes become the user's stored copy.
    const doc = readerDocSchema.parse(result.readMode);
    const readModeId = newId();
    await writeFile(username, readModeId, await encodeReaderDoc(doc)); // content first
    await writeExtraction(username, linkId, {
      fields: { readModeId },
      facet: 'readMode',
      state: newFacet('done', EXTRACTED_BY),
    });
    return { kind: 'kept' };
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
  return {
    kind: 'none',
    status: verdict.status,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}
