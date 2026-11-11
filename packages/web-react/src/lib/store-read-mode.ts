import {
  applyReaderImages,
  encodeReaderImages,
  newFacet,
  type ReaderDoc,
  type ReaderImageEntry,
  readerImageKeys,
  withinReaderImageBudget,
} from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';

import { writeExtraction, writeFile } from '../data/mutations';
import { encodeReaderDoc } from './reader-doc-bytes';

// Store ONE read-mode copy: the text, and the images kept with it. The single writer
// for every web-side capture — the browser extension's active-tab capture
// (extraction-worker.ts) and bracemark-web's server path (server-read-mode.ts) — so a
// copy is the same two blobs and the same extraction fields whichever took it. The
// expo twin is expo-react `data/store-read-mode.ts`.
//
// `doc` is the document AS CAPTURED: its figures may carry keys the walker handed out.
// `images` is what the caller managed to fetch and encode, in page order — empty when
// images are off, when the article has none, or when none could be had. This function
// SETTLES the two against each other, which is why a caller must not skip it:
//
//   - `applyReaderImages` gives each kept figure its stored size and takes the key off
//     every figure whose image is not in `images` — so with an empty list the stored
//     document has no keys at all, and never promises a picture the pack doesn't hold;
//   - the pack holds exactly the images the settled document names, no more.
//
// Content before metadata, as everywhere: the pack, then the text copy, then the one
// extraction write that points at both. `readModeImagesId` is written even when it is
// undefined: a re-capture of a link whose earlier copy had images must CLEAR the old
// pack's ref, so writeExtraction reclaims that blob instead of leaving it attached to
// a document that no longer names it.
export async function storeReadModeCopy(
  username: string,
  linkId: string,
  doc: ReaderDoc,
  images: readonly ReaderImageEntry[],
  extractedBy: string,
): Promise<void> {
  const kept = withinReaderImageBudget(images);
  const settled = applyReaderImages(
    doc,
    new Map(kept.map(({ key, width, height }) => [key, { width, height }])),
  );
  const named = new Set(readerImageKeys(settled));
  const packed = kept.filter((entry) => named.has(entry.key));

  let readModeImagesId: string | undefined;
  if (packed.length > 0) {
    readModeImagesId = newId();
    await writeFile(username, readModeImagesId, encodeReaderImages(packed));
  }
  const readModeId = newId();
  await writeFile(username, readModeId, await encodeReaderDoc(settled));
  await writeExtraction(username, linkId, {
    fields: { readModeId, readModeImagesId },
    facet: 'readMode',
    state: newFacet('done', extractedBy),
  });
}
