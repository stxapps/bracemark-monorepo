import {
  newFacet,
  normalizeUrl,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_DIMENSION,
} from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';
import {
  encodeReaderDoc,
  type ExtractionFacet,
  type ExtractionFields,
  readLinkById,
  resizeImage,
  writeExtraction,
  writeFile,
} from '@stxapps/web-react';

import { captureReadMode, captureScreenshot, captureTitleImage } from './capture';

// `extractedBy` is a `platform:env` string, NOT a device id (entities.ts): quality is
// DERIVED from it by `tierOf()`, so there's no stored `tier` field. The extension only
// ever captures from the focused live DOM = foreground, active-page tier. (There is no
// `extension:bg` value: the extension is active-context only — no `<all_urls>` grant, no
// background bg-fetch sweep; that residual is owned by `bracemark-extractor` or Expo at `all`.
// See docs/link-extraction.md "the extension is active-context only".)
const EXTRACTED_BY = 'extension:fg';

// The extraction worker: capture one facet of one link from the ACTIVE TAB, then
// write back — the heavy bytes into `files/`, and BOTH the display refs and the
// facet's done/failed bookkeeping into `extractions/{id}.enc`. The extractor NEVER
// writes `links/{id}.enc` (the user's file): the writer-split keeps the machine half
// (title/imageId/readModeId/screenshotId + facet state) in `extractions/`, so a
// background capture can't clobber a concurrent user edit (link-extraction.md). One
// read-merge-write per completion carries the field + its facet status together. This
// client's tier is `active-page`.
//
// Driven by the popup's EXTRACT message (cheap facets auto on save, heavy ones on a
// button) — i.e. only while the tab is focused, which is exactly when active-page
// capture is valid. The background's periodic alarm runs SYNC, not extraction: an
// active-page client can't capture a backgrounded tab, so there's no headless sweep.
export async function runExtraction(
  username: string,
  linkId: string,
  facet: ExtractionFacet,
): Promise<void> {
  // Guard: the link must exist locally.
  const link = await readLinkById(linkId);
  if (!link) throw new Error(`runExtraction: link ${linkId} not found locally`);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null || tab.windowId == null) throw new Error('No active tab to extract from');
  const tabId = tab.id;

  // And the active tab must still BE this link's page. Active-tab capture doesn't need the
  // URL to fetch anything — it reads the live DOM — but it does need it to know the DOM is
  // the right one: the popup sends EXTRACT fire-and-forget and closes, the heavy facets are
  // button-driven, and every capture is seconds of async during which the user can switch
  // tabs or the page can navigate. `captureVisibleTab` is the sharpest case — it takes a
  // windowId, not a tabId, so it photographs whatever is frontmost when it runs. Storing
  // another page's title/screenshot under this link would be permanent: `extension:fg` is
  // `tierOf`'s ceiling, so nothing outranks it later.
  //
  // Compared through `normalizeUrl` because that's what the popup stored (App.tsx), not
  // `tab.url` raw. Thrown BEFORE the try below on purpose: this is our mistake, not the
  // host's, so it must not burn the facet's backoff — the link stays pending for a later
  // pass (here, or a lower tier elsewhere).
  const tabUrl = tab.url ?? '';
  if ((normalizeUrl(tabUrl) ?? tabUrl) !== link.url) {
    throw new Error('Active tab is no longer this link’s page');
  }

  try {
    switch (facet) {
      case 'titleImage': {
        // The title arrives already selected AND cleaned — capture.ts runs the shared
        // `selectTitleImage`, whose last step is `cleanTitle` (LINK_TITLE_MAX, satisfying
        // `extractionSchema.title`), so every tier's title is capped identically. Only
        // resizeImage is left here: it needs a canvas the injected func has no access to.
        const { title, image } = await captureTitleImage(tabId);

        // PASS 1 — the title alone, FIELDS-ONLY (the facet stays pending so pass 2 still
        // sets the terminal state). Both other tiers split the write this way so an image
        // failure can't cost the title, and the reason binds harder here: this tier's retry
        // needs the user back on this tab, so a title dropped now is realistically a title
        // that waits for some LOWER tier to re-derive it.
        if (title) await writeExtraction(username, linkId, { fields: { title } });

        // PASS 2 — the image, then the terminal write.
        const fields: ExtractionFields = {};
        if (image) {
          const resized = await resizeImage(image);

          const imageId = newId();
          await writeFile(username, imageId, resized); // content before metadata
          fields.imageId = imageId;
        }
        await markDone(username, linkId, facet, { fields });
        break;
      }
      case 'readMode': {
        const doc = await captureReadMode(tabId);
        if (!doc) {
          // Not an article — a product page, an app, a feed. That is the answer for this
          // page, from the best tier there is, so it's settled rather than retried: a
          // `failed` would have every drain re-ask it. The reason rides on the facet so a
          // surface can say "no article here" rather than "it failed". A user who wants
          // a copy anyway asks again, and an explicit ask is never gated on this.
          await writeExtraction(username, linkId, {
            facet,
            state: newFacet('permanent', EXTRACTED_BY, { reason: 'not-an-article' }),
          });
          break;
        }

        const readModeId = newId();
        await writeFile(username, readModeId, await encodeReaderDoc(doc)); // content first
        await markDone(username, linkId, facet, { fields: { readModeId } });
        break;
      }
      case 'screenshot': {
        const captured = await captureScreenshot(tab.windowId);
        const jpeg = await resizeImage(captured, {
          maxDimension: SCREENSHOT_MAX_DIMENSION,
          quality: SCREENSHOT_JPEG_QUALITY,
        });

        const screenshotId = newId();
        await writeFile(username, screenshotId, jpeg);
        await markDone(username, linkId, facet, { fields: { screenshotId } });
        break;
      }
      // No `pageCopy`: it falls to the refusal below, like any facet this tier doesn't
      // capture (capture.ts says why there is no page-copy capture).
      default:
        throw new Error(`runExtraction: facet "${facet}" is not an active-page capture`);
    }
  } catch (err) {
    // Transient failure: record it so the UI can show "retry" and the pending query backs
    // it off. `newFacet` stamps the shared base fields (`extractedAt` for backoff eligibility,
    // the `attempts: 0` placeholder `writeExtraction` overrides with prior + 1 on a `failed`
    // write so repeated failures escalate) — see its doc in shared/sync/extraction.ts.
    await writeExtraction(username, linkId, { facet, state: newFacet('failed', EXTRACTED_BY) });
    throw err;
  }
}

function markDone(
  username: string,
  linkId: string,
  facet: ExtractionFacet,
  opts: { fields?: ExtractionFields } = {},
): Promise<void> {
  const state = newFacet('done', EXTRACTED_BY);
  return writeExtraction(username, linkId, { fields: opts.fields, facet, state });
}
