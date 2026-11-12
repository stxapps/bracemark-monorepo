import { sniffImageMime } from '../image/sniff';
import type { ReaderBlock, ReaderDoc } from './reader-doc';
import {
  READER_IMAGES_MAX_BYTES,
  READER_IMAGES_MAX_COUNT,
  READER_IMAGES_MAX_INDEX_BYTES,
} from './reader-doc-core';

// The images a read-mode copy keeps — `extraction.readModeImagesId`, a `files/{id}.enc`
// blob beside the text copy (`readModeId`). docs/link-extraction-keep.md, _images in
// read mode_, is the design; this file is the pack's byte format and the one step that
// ties a pack to its document.
//
// ONE PACK PER ARTICLE, not a blob per image and not bytes inside the `ReaderDoc`:
//
//   - the text copy stays a few KB, so it opens at once and is cheap to hold on every
//     device; the images are fetched only when the article is on screen;
//   - one field on the extraction names one blob, so every rule that finds an
//     extraction's blobs (destroy, replace, remove, the backup, the orphan sweep) covers
//     it with no change. ⚠ A blob named ONLY inside the `ReaderDoc` would be invisible
//     to the orphan sweep, which reads references out of entities, and would be deleted
//     on every device after its grace period.
//
// THE FORMAT. Not gzip (images don't compress) and not JSON with base64 (a third
// larger, and parsed whole):
//
//   bytes 0–3   "BMRI"
//   byte  4     the format version, 1
//   bytes 5–8   the index's length, big-endian
//   then        the index — ASCII JSON, `{ images: [{ key, type, width, height, length }] }`
//   then        each image's bytes, in index order, end to end
//
// The index is ASCII on purpose: keys are `i0`, `i1`, …, types are MIME strings, the
// rest are numbers — so it decodes with no TextDecoder, which Hermes has only by
// courtesy of a polyfill.

const MAGIC = [0x42, 0x4d, 0x52, 0x49]; // "BMRI"
const VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1 + 4;

// An image the capture found in the article and the client may fetch: `key` is what
// the figure block carries (`block.image`), `url` where the bytes are. The list is
// returned BESIDE the document and never stored — reader-doc.ts, the `image` field,
// says why the address must not be a field of the block.
export interface ReaderImageSource {
  key: string;
  url: string;
}

// One kept image. `bytes` on a decoded entry is a VIEW into the pack, not a copy.
export interface ReaderImageEntry {
  key: string;
  // What the bytes are — `image/jpeg` for anything this build re-encoded.
  type: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

interface IndexEntry {
  key: string;
  type: string;
  width: number;
  height: number;
  length: number;
}

export function encodeReaderImages(entries: readonly ReaderImageEntry[]): Uint8Array {
  const index: { images: IndexEntry[] } = {
    images: entries.map(({ key, type, width, height, bytes }) => ({
      key,
      type,
      width,
      height,
      length: bytes.length,
    })),
  };
  const json = JSON.stringify(index);
  const indexBytes = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    // Unreachable for what this build writes; a non-ASCII key would otherwise be
    // silently truncated to a byte and decode as a different string.
    if (code > 0x7f) throw new Error('encodeReaderImages: the index must be ASCII');
    indexBytes[i] = code;
  }

  const total = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const out = new Uint8Array(HEADER_BYTES + indexBytes.length + total);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  new DataView(out.buffer).setUint32(MAGIC.length + 1, indexBytes.length);
  out.set(indexBytes, HEADER_BYTES);
  let offset = HEADER_BYTES + indexBytes.length;
  for (const entry of entries) {
    out.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }
  return out;
}

const isIndexEntry = (value: unknown): value is IndexEntry => {
  const entry = value as Partial<IndexEntry> | null;
  return (
    typeof entry?.key === 'string' &&
    typeof entry.type === 'string' &&
    Number.isFinite(entry.width) &&
    Number.isFinite(entry.height) &&
    Number.isInteger(entry.length) &&
    (entry.length as number) >= 0
  );
};

// The pack's images, or undefined when the bytes are not a pack this build can read —
// the wrong magic, a newer version, an index that isn't one, lengths that run past the
// end, more images or more bytes than a writer ever packs. Never a throw: stored bytes are
// not trusted (a backup is an outside file), and a bad pack must cost the article its
// pictures, not the reader its screen.
//
// An entry's `type` is NOT read from the index: it is what the bytes are (sniffImageMime),
// and an entry whose bytes are not a raster image is dropped. A reader mints a Blob or a
// data URI with this type, and a type the pack merely claimed (`text/html`) would make a
// document of it in the app's own origin.
export function decodeReaderImages(pack: Uint8Array): ReaderImageEntry[] | undefined {
  if (pack.length < HEADER_BYTES) return undefined;
  if (MAGIC.some((byte, i) => pack[i] !== byte)) return undefined;
  if (pack[MAGIC.length] !== VERSION) return undefined;
  const indexLength = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(
    MAGIC.length + 1,
  );
  const indexEnd = HEADER_BYTES + indexLength;
  if (indexEnd > pack.length) return undefined;
  // Past what a writer packs: the index is ~100 bytes an image, the images stop at the budget.
  if (indexLength > READER_IMAGES_MAX_INDEX_BYTES) return undefined;
  if (pack.length - indexEnd > READER_IMAGES_MAX_BYTES) return undefined;

  let json = '';
  for (let i = HEADER_BYTES; i < indexEnd; i++) json += String.fromCharCode(pack[i]);
  let images: unknown;
  try {
    images = (JSON.parse(json) as { images?: unknown } | null)?.images;
  } catch {
    return undefined;
  }
  if (!Array.isArray(images) || !images.every(isIndexEntry)) return undefined;
  if (images.length > READER_IMAGES_MAX_COUNT) return undefined;

  const entries: ReaderImageEntry[] = [];
  let offset = indexEnd;
  for (const { key, width, height, length } of images) {
    if (offset + length > pack.length) return undefined;
    const bytes = pack.subarray(offset, offset + length);
    offset += length;
    const type = sniffImageMime(bytes);
    if (type) entries.push({ key, type, width, height, bytes });
  }
  return entries;
}

// Tie a captured document to the images that were actually KEPT. The walker gave a key
// to every figure it found an address for (`readerCaptureFromArticle`); this is the
// step after the fetch, and the only writer of a figure's `width` / `height`:
//
//   - a figure whose image was kept gains the stored size, so a reader can reserve
//     its space before the pack arrives;
//   - a figure whose image was NOT kept (refused, too small, not an image, past the
//     budget) loses its key and is the placeholder it would be with images off — and
//     if it then has no alt text and no caption either, it is dropped, since there is
//     nothing left of it to show.
//
// Every capture that asked for images runs its document through here before storing
// it, WITH AN EMPTY MAP if nothing was kept: a document stored with keys and no pack
// would promise pictures it doesn't have.
export function applyReaderImages(
  doc: ReaderDoc,
  kept: ReadonlyMap<string, { width: number; height: number }>,
): ReaderDoc {
  const blocks: ReaderBlock[] = [];
  for (const block of doc.blocks) {
    if (block.kind !== 'figure' || block.image === undefined) {
      blocks.push(block);
      continue;
    }
    const size = kept.get(block.image);
    if (size) {
      blocks.push({ ...block, width: size.width, height: size.height });
      continue;
    }
    const rest: ReaderBlock = { ...block };
    delete rest.image;
    delete rest.width;
    delete rest.height;
    if (rest.text || (rest.runs ?? []).length > 0) blocks.push(rest);
  }
  return { ...doc, blocks };
}

// The keys a document's figures name — what a reader needs from the pack, and what a
// capture checks a pack against.
export function readerImageKeys(doc: Pick<ReaderDoc, 'blocks'>): string[] {
  const keys = new Set<string>();
  for (const block of doc.blocks) {
    if (block.kind === 'figure' && typeof block.image === 'string') keys.add(block.image);
  }
  return [...keys];
}

// The images a pack takes: in the order given (page order), until the count or the
// byte budget is spent. Everything after the first one that doesn't fit is left out —
// not "the next that fits" — so which figures are placeholders is "the ones past this
// point in the article", something a reader can make sense of. Every capture packs
// through this, so the budget is one rule on every platform.
export function withinReaderImageBudget<T extends { bytes: Uint8Array }>(
  entries: readonly T[],
): T[] {
  const taken: T[] = [];
  let total = 0;
  for (const entry of entries) {
    if (taken.length >= READER_IMAGES_MAX_COUNT) break;
    if (total + entry.bytes.length > READER_IMAGES_MAX_BYTES) break;
    taken.push(entry);
    total += entry.bytes.length;
  }
  return taken;
}
