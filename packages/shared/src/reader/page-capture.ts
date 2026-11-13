import type { CollectedMeta } from '../extract/select';
import type { ReaderImageSource } from './reader-images';

// The protocol between expo's capture screen and the script it injects into the page
// in its WebView (web-react `lib/webview-capture.ts`, bundled by
// tools/scripts/generate-reader-capture.ts). docs/link-extraction-keep.md, _per
// client_, the capture screen.
//
// It is in `shared` because two platforms speak it: the page side is web code (it
// needs the page's DOM) and the app side is expo code, and neither may import the
// other. Types and string constants only — zod-free, so the in-page bundle can take
// it through its subpath export without the barrel.
//
// THE SHAPE. The app injects ONE request at a time, each carrying a fresh `nonce`; the
// page answers with messages that echo it. The app accepts a message only while a
// request is pending and only with that request's nonce, so a late answer to an
// earlier request (a timeout, a second tap) is never mistaken for this one.
//
// What the nonce is NOT: a defence against the page. The injected script runs in the
// page's own world, so the page's scripts can watch `ReactNativeWebView.postMessage`
// and forge a message with the right nonce. The app therefore treats every answer as it
// would the honest one, and bounds what a forged one can cost: the message's length
// (the longest an honest one is), the document against `readerDocSchema` for shape and
// `readerDocWithinCaps` for size, every image's bytes by sniff and probe, every address
// as absolute http(s) when it is fetched. A forged document can still be one the page
// itself could have served, and within the caps a forged one can still be costly to draw: they
// count characters, blocks, rows and columns, not every cell or run, so a document of many empty
// table cells or one-character runs passes them. What they do bound is what is stored, decoded
// and held in memory at once.

export const PAGE_CAPTURE_MESSAGE = {
  // `{ type, nonce, href, doc }` — `doc` is the CAPTURE (`{ doc, images }`), or null
  // when the page is not an article or the capture was too large to send.
  readMode: 'bracemark-read-mode',
  // `{ type, nonce, href, collected }` — the page's title and image candidates, for
  // the app to run `selectTitleImage` over.
  meta: 'bracemark-page-meta',
  // `{ type, nonce, key, base64 }` — one image's bytes. Article images are re-encoded
  // in the page; a preview image is capped to the preview size.
  image: 'bracemark-page-image',
  // `{ type, nonce }` — the end of an image request: whatever was not posted by now
  // was not had.
  imagesDone: 'bracemark-page-images-done',
} as const;

export type PageCaptureRequest =
  | { kind: 'readMode'; nonce: string }
  | { kind: 'meta'; nonce: string }
  // `capturedFrom` is the address the page reported with its capture; the page
  // re-checks it before every fetch, so an image is never fetched from (and filed
  // under) a page the user has since navigated to.
  | {
      kind: 'readerImages';
      nonce: string;
      capturedFrom: string;
      sources: ReaderImageSource[];
      deadlineMs: number;
    }
  | {
      kind: 'previewImage';
      nonce: string;
      capturedFrom: string;
      url: string;
      deadlineMs: number;
    };

export interface PageMetaMessage {
  type: typeof PAGE_CAPTURE_MESSAGE.meta;
  nonce: string;
  href: string;
  collected: CollectedMeta;
}

// The key a preview image's message carries — article images carry the figure's own
// (`i0`, `i1`, …).
export const PAGE_CAPTURE_PREVIEW_KEY = 'preview';
