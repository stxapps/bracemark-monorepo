import type { File } from 'expo-file-system';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import { newFacet } from '@stxapps/shared';

import {
  assertExtractionWritable,
  type ExtractionFields,
  writeExtraction,
  writeFile,
} from './mutations';

// Store a link's title and preview image as read from the LIVE page in the capture
// screen's WebView — _Update preview_ (features/capture/capture-screen.tsx in the app).
// docs/link-extraction-keep.md, _per client_, the capture screen.
//
// The same write the drain makes (lib/device-link-previews.ts — the writer-split: never
// `links/{id}.enc`; the image into `files/`, the display fields and the facet into
// `extractions/{id}.enc`), with two differences that both come from it being a TAP:
//
//   - it is written whatever the facet held before, at whatever tier. The tier rule is
//     for automatic work deciding whether to redo a link; here the user is looking at
//     the page and has asked for its preview, and a stale or wrong preview from a
//     better-ranked tier is exactly what they are replacing. `expo:fg` is honest: it is
//     the live page, in the user's own session.
//   - only what was HAD is written. A title the page didn't yield leaves the old title,
//     and an image that couldn't be fetched leaves the old image — a failed fetch is not
//     "this page has no preview", and replacing a good preview with none would be a loss
//     the user didn't ask for. `writeExtraction` deletes a replaced image's blob.
//
// The user's own `customTitle` / `customImageId` live on the link and are never touched
// here; they keep winning in the UI, which the screen says.
//
// `image` is a temp file the caller made (lib/device-link-previews.ts,
// `previewFileFromBytes` / `fetchPreviewImageFile`) and deletes afterwards. Resolves
// whether anything was written.
export async function storePagePreview(
  username: string,
  linkId: string,
  { title, image }: { title?: string; image?: File },
): Promise<boolean> {
  if (!title && !image) return false;
  // Before the blob: a refusal after it would leave the image uploaded with no extraction
  // naming it.
  await assertExtractionWritable(username, linkId);
  const fields: ExtractionFields = {};
  if (title) fields.title = title;
  if (image) {
    const imageId = newId();
    await writeFile(username, imageId, image); // content before metadata
    fields.imageId = imageId;
  }
  await writeExtraction(username, linkId, {
    fields,
    facet: 'titleImage',
    state: newFacet('done', 'expo:fg'),
  });
  return true;
}
