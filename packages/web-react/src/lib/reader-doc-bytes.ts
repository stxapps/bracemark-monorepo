import { type ReaderDoc, readerDocSchema, utf8 } from '@stxapps/shared';

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

// Undefined for anything that isn't a readable copy — bytes that won't gunzip, JSON
// that won't parse, or a document the schema refuses. A reader shows "no copy" for all
// three; none is worth an error in front of the user, and a throw here would take the
// screen with it for one bad blob.
export async function decodeReaderDoc(bytes: Uint8Array): Promise<ReaderDoc | undefined> {
  try {
    const json = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')));
    const parsed = readerDocSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
