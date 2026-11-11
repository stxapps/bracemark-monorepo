import type { PageCaptureRequest } from '@stxapps/shared';
// Values from zod-free subpaths, types from the barrel (a whole `import type` statement
// is erased at build) — this file runs inside a stranger's page; see
// reader-doc-from-page.ts.
import {
  PAGE_CAPTURE_MESSAGE,
  PAGE_CAPTURE_PREVIEW_KEY,
} from '@stxapps/shared/reader/page-capture';
import {
  READER_CAPTURE_MAX_PAYLOAD_CHARS,
  READER_IMAGE_MAX_SOURCE_BYTES,
} from '@stxapps/shared/reader/reader-doc-core';

import { collectPageMeta } from './page-meta';
import { readerCaptureFromPage } from './reader-doc-from-page';
import { collectReaderImages } from './reader-images';
import { resizeImage } from './resize-image';

// The page half of expo's capture screen — what runs INSIDE the page in its WebView,
// answering one request from the app (the protocol, and why its nonce is no defence
// against the page: @stxapps/shared reader/page-capture.ts). Bundled, with everything
// it imports, into one string by tools/scripts/generate-reader-capture.ts and injected
// per request (apps/bracemark-expo features/capture/page-capture-script.generated.ts).
// docs/link-extraction-keep.md, _per client_, the capture screen.
//
// Four requests:
//
//   - `readMode` — the read-mode capture, `{ doc, images }`, the converter every
//     live-page capture runs (reader-doc-from-page.ts), as JSON TEXT;
//   - `meta` — the title and preview-image candidates (page-meta.ts), the same
//     collector the browser extension injects;
//   - `readerImages` — fetch the article's images FROM THE PAGE and re-encode them here
//     (reader-images.ts → reader-image.ts, the encoder bracemark-web and the browser
//     extension use);
//   - `previewImage` — fetch the selected preview image from the page and cap it
//     (resize-image.ts, the preview path's encoder).
//
// WHY THE PAGE FETCHES. The app's own fetch is native: no CORS, but none of the page's
// cookies either, so an image behind the site's sign-in is a placeholder. Fetched
// here, a request carries what the page's own would — the page's session for an image
// on its own origin — at the cost of the browser's cross-origin rule for an image
// host that sends no CORS header. The app covers that gap by fetching natively
// whatever the page could not post, so each image gets whichever of the two reaches it.
// `credentials` is left at its default (`same-origin`): `include` would make every
// cross-origin read fail against a host that answers `Access-Control-Allow-Origin: *`,
// which is most image CDNs.
//
// WHY THE PAGE ENCODES. A picture crosses to the app as base64 in a message, so it
// crosses at the size it will be stored — a 1024 px JPEG — rather than as an 8 MB
// original inflated by a third. The app still treats what arrives as untrusted bytes
// (it sniffs and measures them: expo-react lib/reader-images.ts).
//
// It never throws, and every image request ends with an `imagesDone`, so the app never
// waits on a page that failed halfway.

// A few at a time, as every other client fetches an article's images: the page is the
// user's, on a phone's radio.
const READER_IMAGE_CONCURRENCY = 3;

function hrefOf(page: Document): string {
  return page.location?.href ?? page.URL;
}

// Fetch an image the way the page itself would, and only while the page is still the
// one the capture came from — a fetch from another page would file that page's picture
// under this link.
async function fetchFromPage(
  page: Document,
  url: string,
  capturedFrom: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (hrefOf(page) !== capturedFrom) return undefined;
  const res = await fetch(url, { signal });
  if (!res.ok) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Measured here, before the bytes are decoded or copied across to the app.
  if (bytes.length === 0 || bytes.length > READER_IMAGE_MAX_SOURCE_BYTES) return undefined;
  return bytes;
}

// Bytes → base64, through the platform's own encoder rather than a string built a byte
// at a time (an image is hundreds of KB).
function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(new Blob([bytes as BlobPart]));
  });
}

export async function runPageCapture(
  request: PageCaptureRequest,
  post: (message: string) => void,
  page: Document = document,
): Promise<void> {
  const nonce = String(request.nonce);

  const postImage = async (key: string, bytes: Uint8Array) => {
    const base64 = await toBase64(bytes);
    if (base64) post(JSON.stringify({ type: PAGE_CAPTURE_MESSAGE.image, nonce, key, base64 }));
  };
  const postDone = () => post(JSON.stringify({ type: PAGE_CAPTURE_MESSAGE.imagesDone, nonce }));

  switch (request.kind) {
    case 'readMode': {
      // Serialised once, here, and spliced in as text: the capture is the largest thing
      // that crosses, and the app parses it once on the other side.
      let json: string | null = null;
      try {
        const capture = readerCaptureFromPage(page);
        if (capture) {
          const text = JSON.stringify(capture);
          if (text.length <= READER_CAPTURE_MAX_PAYLOAD_CHARS) json = text;
        }
      } catch {
        json = null;
      }
      post(
        `{"type":${JSON.stringify(PAGE_CAPTURE_MESSAGE.readMode)},"nonce":${JSON.stringify(nonce)},` +
          `"href":${JSON.stringify(hrefOf(page))},"doc":${json ?? 'null'}}`,
      );
      return;
    }

    case 'meta': {
      let meta: ReturnType<typeof collectPageMeta>;
      try {
        meta = collectPageMeta(page);
      } catch {
        meta = { href: hrefOf(page), collected: {} };
      }
      post(JSON.stringify({ type: PAGE_CAPTURE_MESSAGE.meta, nonce, ...meta }));
      return;
    }

    case 'readerImages': {
      try {
        const entries = await collectReaderImages(
          Array.isArray(request.sources) ? request.sources : [],
          (url, signal) => fetchFromPage(page, url, request.capturedFrom, signal),
          { deadlineMs: request.deadlineMs, concurrency: READER_IMAGE_CONCURRENCY },
        );
        for (const entry of entries) await postImage(entry.key, entry.bytes);
      } catch {
        // Whatever was not posted is the app's to fetch natively.
      } finally {
        postDone();
      }
      return;
    }

    case 'previewImage': {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.deadlineMs);
      try {
        const bytes = await fetchFromPage(
          page,
          request.url,
          request.capturedFrom,
          controller.signal,
        );
        // Capped to the preview size where this runtime can decode it, passed through
        // where it can't — the app sniffs and measures what arrives either way.
        if (bytes) await postImage(PAGE_CAPTURE_PREVIEW_KEY, await resizeImage(bytes));
      } catch {
        // A refused or slow image — the app fetches it natively instead.
      } finally {
        clearTimeout(timer);
        postDone();
      }
      return;
    }

    default:
      return;
  }
}
