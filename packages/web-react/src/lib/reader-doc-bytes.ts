import {
  READER_DOC_MAX_JSON_BYTES,
  type ReaderDoc,
  readerDocSchema,
  readerDocWithinCaps,
  utf8,
} from '@stxapps/shared';

// The read-mode copy's byte format: a `ReaderDoc` (@stxapps/shared reader/reader-doc.ts)
// as UTF-8 JSON, gzipped. That is the plaintext of the `files/{id}.enc` blob
// `extraction.readModeId` names — encryption happens below this, at the store's write
// edge, like every other blob.
//
// Gzip because article text compresses ~3–5×, and the copy is a per-link blob charged to
// the byte quota on every save that keeps one. It goes BEFORE encryption because
// ciphertext doesn't compress. `CompressionStream` is in every browser this package runs
// in and in the extension's service worker; expo has no such global and decodes with
// fflate's gunzip, which reads the same bytes — gzip is the format, not this API.

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  // `as BlobPart`: the same generic-buffer cast resize-image.ts makes.
  const piped = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function encodeReaderDoc(doc: ReaderDoc): Promise<Uint8Array> {
  return pipe(utf8(JSON.stringify(doc)), new CompressionStream('gzip'));
}

// The inflate, with a ceiling: read the stream chunk by chunk and stop (cancelling it, so
// the rest is never produced) the moment it passes `limit`. The blob is not trusted — a
// backup is an outside file, and on the WebView door the walker is the page's own code —
// and a few KB of gzip can name a gigabyte. Undefined past the ceiling.
async function gunzipWithin(bytes: Uint8Array, limit: number): Promise<Uint8Array | undefined> {
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Undefined for anything that isn't a readable copy — bytes that won't gunzip or inflate
// past READER_DOC_MAX_JSON_BYTES, JSON that won't parse, a document the schema refuses, or
// one past the store edge's size ceilings (readerDocWithinCaps). A reader shows "no copy"
// for all of them; none is worth an error in front of the user, and a throw here would
// take the screen with it for one bad blob.
export async function decodeReaderDoc(bytes: Uint8Array): Promise<ReaderDoc | undefined> {
  try {
    const inflated = await gunzipWithin(bytes, READER_DOC_MAX_JSON_BYTES);
    if (!inflated) return undefined;
    const parsed = readerDocSchema.safeParse(JSON.parse(new TextDecoder().decode(inflated)));
    return parsed.success && readerDocWithinCaps(parsed.data) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
