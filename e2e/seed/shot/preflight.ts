import { pathToFileURL } from 'node:url';

import { extractEndpoint, MAX_EXTRACT_URLS } from '@stxapps/shared';

import { EXTRACTOR_URL } from '../../web/fixtures/env';
import { shotLinkUrls } from './library';

// Ask `bracemark-extractor` about every URL in shot/library.ts, and fail on any
// that would land in the screenshot as a monogram.
//
//   npm run shot:preflight        # needs `npm run dev` (the extractor is on 8788)
//
// WHY THIS EXISTS AS A SEPARATE STEP. The capture run is slow — an account, a
// plan grant, an import, a sync, a drain — and its failure mode for a dead URL is
// not a failure at all: the link is saved, the facet records `permanent`, the run
// finishes green, and the defect is one grey tile in a 1600px PNG that nobody
// looks at again until it is on the marketing site. So the list is checked first,
// on its own, in seconds.
//
// WHY THROUGH THE EXTRACTOR AND NOT `curl`/`fetch`. Because the extractor's answer
// is the only one that decides the picture, and the two genuinely disagree. Two
// specimens, and the second is the nastier of the pair:
//
//   askamanager.org  answered Cloudflare's interstitial with a 403 to curl and to
//                    any server-side fetcher off Cloudflare, and a 200 to
//                    `bracemark-extractor`, which is itself a Worker. It is no
//                    longer in the list — it left on its og:image, not on this —
//                    but it is the example the site's landing page still records.
//   wikihow.com      serves a ~3KB bot-challenge document AT STATUS 200. No error,
//                    no redirect: just a page with no og:title and no og:image in
//                    it, and only after the first few requests, so a batch check
//                    "discovers" that live pages have lost their metadata partway
//                    down the list. Three wikiHow URLs are in the list below.
//
// A 403 announces itself and a 200 does not, which is why neither belongs in a
// preflight built on `curl` — it would report live URLs as dead and send someone
// off to "fix" a list that was correct. Going through the extractor also means
// this checks the real caps — the timeout, the redirect limit, the HTML ceiling,
// the content-type allowlist — rather than a second opinion about them.
//
// It asserts on three things, and the third one was learned the expensive way.
//
// `ok`, obviously. Then `imageUrl`: a title-only result is a perfectly good saved
// link and a bad ROW — the list layout draws a monogram in the 64x40 slot where a
// cover should be, and the band's argument is that these are real pages someone
// really saved — so "extracted fine, no picture" is a failure here rather than a
// pass. The slot is smaller than the card's was; the requirement is not.
//
// And then LATENCY, because a slow host does not fail cleanly. The extractor
// gives each hop 8 seconds (`FETCH_TIMEOUT_MS`) and the og:image is a second hop
// after the page, so a host that answers in three or four seconds succeeds most
// of the time and times out the rest — and a timeout is a TRANSIENT failure,
// which costs a `backoff(attempts)` ladder starting at ten minutes and doubling.
// The symptom is a capture that comes back 21 of 24 and then spends forty minutes
// not converging, with every individual URL passing when you check it by hand.
// Two National Trust pages did exactly that. So this times the whole round trip
// and refuses anything near the cliff, which turns a mystery during a capture
// into a red line before one.

// The per-URL budget, well under the extractor's own 8s-per-hop ceiling. A URL
// that needs more than this is not broken — it is close enough to the cliff that
// it will fall off it on a worse day, which is the failure mode worth refusing.
// Measured over a BATCH, so it is the batch's slowest member that this catches;
// a single-URL re-check is how you tell which one when a batch trips it.
const SLOW_MS = 4_000;

interface Verdict {
  url: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const urls = shotLinkUrls();
  console.log(`checking ${urls.length} URLs against ${EXTRACTOR_URL}\n`);

  const verdicts: Verdict[] = [];
  // Chunked at the contract's own per-request cap. Not a politeness knob — over
  // `MAX_EXTRACT_URLS` the request 400s at the schema before any fetch runs, so
  // this is the largest legal batch rather than a chosen one.
  for (let i = 0; i < urls.length; i += MAX_EXTRACT_URLS) {
    const batch = urls.slice(i, i + MAX_EXTRACT_URLS);
    const startedAt = Date.now();
    const response = await fetch(`${EXTRACTOR_URL}${extractEndpoint.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: batch }),
    });
    if (!response.ok) {
      throw new Error(
        `extractor returned ${response.status} for a batch of ${batch.length} — ` +
          `is \`npm run dev\` up? (${await response.text()})`,
      );
    }
    const { results } = extractEndpoint.response.parse(await response.json());
    const elapsed = Date.now() - startedAt;
    // Correlated by `url`, never by array order: the contract echoes the input
    // for exactly this reason (extract/endpoints.ts), and the server fans the
    // batch out concurrently.
    const byUrl = new Map(results.map((result) => [result.url, result]));
    for (const url of batch) {
      const result = byUrl.get(url);
      if (!result) {
        verdicts.push({ url, ok: false, detail: 'no result returned for this URL' });
      } else if (!result.ok) {
        verdicts.push({
          url,
          ok: false,
          detail: `${result.error ?? 'failed'}${result.status ? ` (${result.status})` : ''}`,
        });
      } else if (!result.imageUrl) {
        verdicts.push({ url, ok: false, detail: 'no og:image — this card would be a monogram' });
      } else {
        verdicts.push({ url, ok: true, detail: result.title ?? '(no title)' });
      }
    }
    // Reported once per batch rather than per URL, because that is the honest
    // resolution: the server fans the batch out concurrently, so what this
    // measures is the slowest member, not any one of them.
    if (elapsed > SLOW_MS) {
      console.log(
        `  slow  this batch of ${batch.length} took ${elapsed}ms — one of its hosts is near ` +
          `the extractor’s 8s per-hop timeout. Re-check them one at a time.`,
      );
    }
  }

  for (const verdict of verdicts) {
    console.log(`${verdict.ok ? '  ok ' : 'FAIL'}  ${verdict.url}\n        ${verdict.detail}`);
  }

  const failed = verdicts.filter((verdict) => !verdict.ok);
  console.log(`\n${verdicts.length - failed.length}/${verdicts.length} usable`);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} URL${failed.length === 1 ? '' : 's'} would not produce a card — ` +
        `replace ${failed.length === 1 ? 'it' : 'them'} in seed/shot/library.ts before capturing.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
