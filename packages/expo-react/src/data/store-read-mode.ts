import { File, Paths } from 'expo-file-system';
import { gzipSync } from 'fflate';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import { newFacet, readerDocSchema, utf8 } from '@stxapps/shared';

import { writeExtraction, writeFile } from './mutations';

// Store a read-mode copy taken on this device from a LIVE page — the expo half of the
// browser extension's write in extraction-worker.ts. Two callers, both in the APP'S
// process, both after deciding the account keeps the copy (the plan's `keptCopies`,
// and for a save, the synced setting):
//
//   - drainShareOutbox, for a copy a Safari share carried: the iOS share extension's
//     preprocessing ran the converter inside the shared page (share-extension/
//     preprocessing.js) and the draft brought the `ReaderDoc` across;
//   - the capture screen, for a copy taken from its WebView
//     (features/capture/capture-screen.tsx), through useKeptCopyMutations.
//
// Both are the user's own session on the live page, so the copy is written at the
// active-page tier (`expo:fg`), like the browser extension's. It is re-validated
// against `readerDocSchema` here: a share draft is read back off the App Group
// container, and a WebView message is whatever the page's context posted.
// docs/link-extraction-keep.md, _expo_.
//
// `readMode` is the doc, or the doc as JSON TEXT. A share draft carries text — the
// iOS share extension passes the copy along without ever parsing it, and this is
// where it first becomes objects (docs/share-sheet.md, _what the sheet does and
// doesn't do_). The capture screen hands over the parsed doc, and so does a draft
// written before the sheet carried text. Text that isn't JSON is a copy that can't
// be stored, like any other.
//
// Returns whether a copy was written. Never throws: a copy that can't be stored
// costs the link its copy, never the caller the rest of its work.
const tempFileFor = (id: string) => new File(Paths.cache, `read-mode-${id}.gz`);

export async function storeReadModeCopy(
  username: string,
  linkId: string,
  readMode: unknown,
): Promise<boolean> {
  let candidate = readMode;
  if (typeof readMode === 'string') {
    try {
      candidate = JSON.parse(readMode);
    } catch {
      return false;
    }
  }
  const parsed = readerDocSchema.safeParse(candidate);
  if (!parsed.success) return false;

  const fileId = newId();
  const temp = tempFileFor(fileId);
  try {
    temp.write(gzipSync(utf8(JSON.stringify(parsed.data))));
    await writeFile(username, fileId, temp); // content before metadata
    await writeExtraction(username, linkId, {
      fields: { readModeId: fileId },
      facet: 'readMode',
      state: newFacet('done', 'expo:fg'),
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (temp.exists) temp.delete();
    } catch {
      // A leftover in the cache directory is the OS's to reclaim.
    }
  }
}
