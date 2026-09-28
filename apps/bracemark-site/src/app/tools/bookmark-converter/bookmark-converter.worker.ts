import { BlobReader, type FileEntry, ZipReader } from '@zip.js/zip.js/index-native.js';

import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  BOOKMARK_CONVERTER_BACKUP_MAX_ENTRIES,
  BOOKMARK_CONVERTER_BACKUP_TOO_LARGE,
  BOOKMARK_CONVERTER_MAX_BYTES,
  BOOKMARK_CONVERTER_MAX_ENTRIES,
  BOOKMARK_CONVERTER_MAX_MB,
  type BookmarkConversion,
  type BookmarkOutputFormat,
  type BookmarkSource,
  convertBookmarkFiles,
  isZipBytes,
} from '@stxapps/shared';

export type ConversionRequest = { file: File; output: BookmarkOutputFormat };
export type ConversionMessage =
  { ok: true; conversion: BookmarkConversion } | { ok: false; message: string };

const TOO_LARGE_ZIP =
  'This ZIP expands beyond the file size limit. Extract it and choose a smaller bookmark file.';

// One entry's text and byte count, refused once its emitted bytes pass `limit` —
// measured as it streams, not trusted from the declared size.
async function entryText(
  entry: FileEntry,
  limit: number,
  tooLarge: string,
): Promise<{ text: string; bytes: number }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await entry.getData(
    new WritableStream<Uint8Array>({
      write(chunk) {
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error(tooLarge);
        chunks.push(chunk);
      },
    }),
    { checkSignature: true },
  );
  const decoder = new TextDecoder();
  const text =
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
  return { text, bytes };
}

async function readSources(file: File): Promise<BookmarkSource[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZipBytes(head) && !file.name.toLowerCase().endsWith('.zip')) {
    if (file.size > BOOKMARK_CONVERTER_MAX_BYTES)
      throw new Error(
        `This file is too large. Choose an export up to ${BOOKMARK_CONVERTER_MAX_MB} MB.`,
      );
    return [{ name: file.name, text: await file.text() }];
  }
  // No size limit on the archive itself: a Bracemark backup is mostly `files/`
  // blobs this tool never reads, and the reader seeks to the entries it does
  // read. Every other ZIP is held to the portable limits below once the entry
  // list shows it is not a backup.
  // Native streams keep ZIP decoding within this worker, without another worker,
  // a fetched WASM module, or a broader site CSP.
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  const entries: FileEntry[] = [];
  let manifest: FileEntry | undefined;
  let items: FileEntry | undefined;
  try {
    let count = 0;
    let declaredBytes = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > BOOKMARK_CONVERTER_BACKUP_MAX_ENTRIES)
        throw new Error('This ZIP has too many entries. Extract it and choose a bookmark file.');
      if (entry.directory) continue;
      // Root entries only, as the app's restore reads them.
      if (entry.filename === BACKUP_MANIFEST_ENTRY) manifest = entry;
      else if (entry.filename === BACKUP_ITEMS_ENTRY) items = entry;
      else if (
        entries.length <= BOOKMARK_CONVERTER_MAX_ENTRIES &&
        /\.(csv|html?|txt|json)$/i.test(entry.filename) &&
        !entry.filename.startsWith('__MACOSX/')
      ) {
        declaredBytes += entry.uncompressedSize;
        entries.push(entry);
      }
    }
    for (const entry of [manifest, items])
      if (entry?.encrypted)
        throw new Error('This ZIP is password protected. Extract it and choose a bookmark file.');
    if (manifest) {
      // A Bracemark backup: everything but these two entries is left unread. A
      // missing items.jsonl reads as empty, as the app's restore reads it.
      const { text: backupManifest } = await entryText(
        manifest,
        BOOKMARK_CONVERTER_MAX_BYTES,
        'This ZIP isn’t a Bracemark backup (unreadable manifest).',
      );
      const { text } = items
        ? await entryText(items, BOOKMARK_CONVERTER_MAX_BYTES, BOOKMARK_CONVERTER_BACKUP_TOO_LARGE)
        : { text: '' };
      return [{ name: BACKUP_ITEMS_ENTRY, text, backupManifest }];
    }
    if (count > BOOKMARK_CONVERTER_MAX_ENTRIES)
      throw new Error('This ZIP has too many entries. Extract it and choose a bookmark file.');
    if (entries.some((entry) => entry.encrypted))
      throw new Error('This ZIP is password protected. Extract it and choose a bookmark file.');
    if (declaredBytes > BOOKMARK_CONVERTER_MAX_BYTES) throw new Error(TOO_LARGE_ZIP);
    if (!entries.length)
      throw new Error(
        'This ZIP contains no supported bookmark files. Extract it and choose an export.',
      );
    const sources: BookmarkSource[] = [];
    let remaining = BOOKMARK_CONVERTER_MAX_BYTES;
    for (const entry of entries) {
      const { text, bytes } = await entryText(entry, remaining, TOO_LARGE_ZIP);
      remaining -= bytes;
      sources.push({ name: entry.filename, text });
    }
    return sources;
  } finally {
    await reader.close();
  }
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ConversionRequest>) => void) | null;
  postMessage(message: ConversionMessage): void;
};

scope.onmessage = async (event) => {
  try {
    const { file, output } = event.data;
    let sources: BookmarkSource[];
    try {
      sources = await readSources(file);
    } catch (cause) {
      // Library errors may contain archive-controlled strings. Expose only our
      // actionable refusals; file contents never become an unhandled error.
      const message = cause instanceof Error ? cause.message : '';
      throw new Error(
        /^(This |Choose )/.test(message)
          ? message
          : 'Could not read this file. Extract ZIP files or export the bookmarks again.',
      );
    }
    const conversion = convertBookmarkFiles(sources, output);
    const backup = sources[0]?.backupManifest !== undefined;
    if (!backup && (sources.length > 1 || file.name.toLowerCase().endsWith('.zip'))) {
      conversion.receipt.sourceLabel = `ZIP · ${conversion.receipt.sourceLabel}`;
      conversion.receipt.warnings.push(
        'Only supported bookmark files inside the ZIP are read. Other archive entries aren’t included.',
      );
    }
    scope.postMessage({ ok: true, conversion });
  } catch (cause) {
    scope.postMessage({
      ok: false,
      message:
        cause instanceof Error ? cause.message : 'Could not check this file. Please try again.',
    });
  }
};
