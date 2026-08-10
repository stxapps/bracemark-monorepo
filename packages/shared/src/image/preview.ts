// The stored-preview SIZING contract — the numbers every client caps an extracted
// preview image to before it lands in `files/{id}.enc`.
//
// Resizing is a CLIENT step by design (docs/link-extraction.md — _server extraction_:
// `bracemark-extractor` never resizes or transcodes), so each platform implements it against
// its own decoder — `createImageBitmap` + `OffscreenCanvas` on web
// (web-react `lib/resize-image.ts`, also the extension's path), `expo-image-manipulator`
// on native (expo-react `lib/image.ts`). Only the DECODERS differ; what "capped" means
// must not, or the same og:image would be stored at one size from a phone and another
// from a browser, against a shared byte quota, with no way to tell which a link got.
//
// So the two numbers live here, beside the byte-shape sniffs (`image/sniff.ts`) the same
// paths use — the same reason `backoff`/`tierOf` sit in `shared` rather than in each
// client. The output FORMAT is part of the contract too: both platforms re-encode to
// JPEG (universally encodable, right for photographic previews, and alpha is irrelevant
// for a thumbnail). It isn't a constant only because each platform names it differently
// — a MIME string for `convertToBlob`, a `SaveFormat` enum for the manipulator.

// Cap on the longest side, in CSS pixels. An image already within the cap is stored
// UNCHANGED on both platforms — no needless transcode, so a small preview never pays a
// re-encode's quality loss.
export const PREVIEW_MAX_DIMENSION = 1024;

// Lossy-encode quality (0..1) for the re-encode an OVERSIZED image gets.
export const PREVIEW_JPEG_QUALITY = 0.82;
