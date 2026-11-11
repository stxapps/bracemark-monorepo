import { File, Paths } from 'expo-file-system';
import { gzipSync } from 'fflate';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import {
  applyReaderImages,
  encodeReaderImages,
  isReaderHref,
  newFacet,
  readerDocSchema,
  type ReaderImageEntry,
  readerImageKeys,
  type ReaderImageSource,
  utf8,
  withinReaderImageBudget,
} from '@stxapps/shared';

import { collectReaderImages, collectReaderImagesPreferring } from '../lib/reader-images';
import { writeExtraction, writeFile } from './mutations';

// Store a read-mode copy taken on this device from a LIVE page — the expo half of the
// browser extension's write in extraction-worker.ts. Two callers, both in the APP'S
// process, both after deciding the account keeps the copy (the plan's `keptCopies`,
// and for a save, the synced setting):
//
//   - drainShareOutbox, for a copy a Safari share carried: the iOS share extension's
//     preprocessing ran the converter inside the shared page (share-extension/
//     preprocessing.js) and the draft brought the capture across;
//   - the capture screen, for a copy taken from its WebView
//     (features/capture/capture-screen.tsx), through useKeptCopyMutations.
//
// Both are the user's own session on the live page, so the copy is written at the
// active-page tier (`expo:fg`), like the browser extension's. It is re-validated
// against `readerDocSchema` here: a share draft is read back off the App Group
// container, and a WebView message is whatever the page's context posted.
// docs/link-extraction-keep.md, _expo_.
//
// `readMode` is the CAPTURE — `{ doc, images }`, the document and beside it the
// address of each figure it gave a key to — or that as JSON TEXT, or a bare document
// (what a draft written before captures carried images holds). A share draft carries
// text — the iOS share extension passes the copy along without ever parsing it, and
// this is where it first becomes objects (docs/share-sheet.md, _what the sheet does
// and doesn't do_). Text that isn't JSON is a copy that can't be stored, like any
// other.
//
// IMAGES are fetched here, natively, when `options.images` says the account keeps
// them and this caller may fetch (lib/reader-images.ts) — or, for the capture screen,
// asked of the page first (`options.fetchFromPage`, the WebView's in-page fetch) and
// fetched natively only where the page could not. Whatever is kept goes into
// ONE pack beside the text (@stxapps/shared reader/reader-images.ts), and the document
// is SETTLED against it either way — `applyReaderImages` takes the key off every
// figure whose picture is not in the pack, so with images off the stored document
// names none. The addresses are used for that one fetch and dropped.
//
// Returns whether a copy was written. Never throws: a copy that can't be stored
// costs the link its copy, never the caller the rest of its work — and a picture that
// can't be had costs the copy that picture, never its words.
const tempFileFor = (id: string, extension: string) =>
  new File(Paths.cache, `read-mode-${id}.${extension}`);

function deleteQuietly(file: File | undefined): void {
  try {
    if (file?.exists) file.delete();
  } catch {
    // A leftover in the cache directory is the OS's to reclaim.
  }
}

export interface StoreReadModeOptions {
  images?: boolean;
  // The capture screen's: ask the page for these images (fetched and encoded inside it)
  // and answer what came back by key. Consulted only when `images` is on; whatever it
  // doesn't answer — or all of it, if it throws — is fetched natively.
  fetchFromPage?: (
    sources: readonly ReaderImageSource[],
  ) => Promise<ReadonlyMap<string, Uint8Array>>;
}

export async function storeReadModeCopy(
  username: string,
  linkId: string,
  readMode: unknown,
  options: StoreReadModeOptions = {},
): Promise<boolean> {
  let candidate = readMode;
  if (typeof readMode === 'string') {
    try {
      candidate = JSON.parse(readMode);
    } catch {
      return false;
    }
  }
  // A capture has `doc`; a bare document has `blocks`.
  const capture = candidate as { doc?: unknown; images?: unknown } | null;
  const isCapture = typeof capture === 'object' && capture !== null && 'doc' in capture;
  const parsed = readerDocSchema.safeParse(isCapture ? capture.doc : candidate);
  if (!parsed.success) return false;

  const sources: ReaderImageSource[] =
    isCapture && Array.isArray(capture.images)
      ? capture.images.filter(
          (source: Partial<ReaderImageSource> | null): source is ReaderImageSource =>
            typeof source?.key === 'string' && isReaderHref(source.url),
        )
      : [];

  let images: ReaderImageEntry[] = [];
  if (options.images && sources.length > 0) {
    try {
      let fromPage: ReadonlyMap<string, Uint8Array> | undefined;
      if (options.fetchFromPage) {
        try {
          fromPage = await options.fetchFromPage(sources);
        } catch {
          fromPage = undefined;
        }
      }
      images = fromPage
        ? await collectReaderImagesPreferring(sources, fromPage)
        : await collectReaderImages(sources);
    } catch {
      images = [];
    }
  }
  const kept = withinReaderImageBudget(images);
  const doc = applyReaderImages(
    parsed.data,
    new Map(kept.map(({ key, width, height }) => [key, { width, height }])),
  );
  const named = new Set(readerImageKeys(doc));
  const packed = kept.filter((entry) => named.has(entry.key));

  const fileId = newId();
  const temp = tempFileFor(fileId, 'gz');
  let packTemp: File | undefined;
  try {
    // Content before metadata: the pack, then the text, then the one extraction write
    // that points at both. `readModeImagesId` is written even when undefined, so a
    // re-capture clears an earlier copy's pack and writeExtraction reclaims it.
    let readModeImagesId: string | undefined;
    if (packed.length > 0) {
      readModeImagesId = newId();
      packTemp = tempFileFor(readModeImagesId, 'pack');
      packTemp.write(encodeReaderImages(packed));
      await writeFile(username, readModeImagesId, packTemp);
    }
    temp.write(gzipSync(utf8(JSON.stringify(doc))));
    await writeFile(username, fileId, temp);
    await writeExtraction(username, linkId, {
      fields: { readModeId: fileId, readModeImagesId },
      facet: 'readMode',
      state: newFacet('done', 'expo:fg'),
    });
    return true;
  } catch {
    return false;
  } finally {
    deleteQuietly(temp);
    deleteQuietly(packTemp);
  }
}
