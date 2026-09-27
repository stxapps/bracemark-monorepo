import { BlobReader, type FileEntry, ZipReader } from '@zip.js/zip.js/index-native.js';

import {
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

async function readSources(file: File): Promise<BookmarkSource[]> {
  if (file.size > BOOKMARK_CONVERTER_MAX_BYTES) {
    throw new Error(
      `This file is too large. Choose an export up to ${BOOKMARK_CONVERTER_MAX_MB} MB.`,
    );
  }
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZipBytes(head) && !file.name.toLowerCase().endsWith('.zip'))
    return [{ name: file.name, text: await file.text() }];
  // Native streams keep ZIP decoding within this worker, without another worker,
  // a fetched WASM module, or a broader site CSP.
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  const entries: FileEntry[] = [];
  try {
    let count = 0;
    let declaredBytes = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > BOOKMARK_CONVERTER_MAX_ENTRIES)
        throw new Error('This ZIP has too many entries. Extract it and choose a bookmark file.');
      if (entry.directory) continue;
      if (/(^|\/)manifest\.json$/i.test(entry.filename))
        throw new Error(
          'This is a backup archive. Restore Bracemark backups in Settings → Data, or choose a portable bookmark export.',
        );
      if (entry.encrypted)
        throw new Error('This ZIP is password protected. Extract it and choose a bookmark file.');
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > BOOKMARK_CONVERTER_MAX_BYTES)
        throw new Error(
          'This ZIP expands beyond the file size limit. Extract it and choose a smaller bookmark file.',
        );
      if (
        /\.(csv|html?|txt|json)$/i.test(entry.filename) &&
        !entry.filename.startsWith('__MACOSX/')
      )
        entries.push(entry);
    }
    if (!entries.length)
      throw new Error(
        'This ZIP contains no supported bookmark files. Extract it and choose an export.',
      );
    const sources: BookmarkSource[] = [];
    let expandedBytes = 0;
    for (const entry of entries) {
      const chunks: Uint8Array[] = [];
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            expandedBytes += chunk.byteLength;
            if (expandedBytes > BOOKMARK_CONVERTER_MAX_BYTES)
              throw new Error(
                'This ZIP expands beyond the file size limit. Extract it and choose a smaller bookmark file.',
              );
            chunks.push(chunk);
          },
        }),
        { checkSignature: true },
      );
      const decoder = new TextDecoder();
      const text =
        chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
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
    if (sources.length > 1 || file.name.toLowerCase().endsWith('.zip')) {
      conversion.receipt.sourceLabel = `ZIP · ${conversion.receipt.sourceLabel}`;
      conversion.receipt.warnings.push(
        'Only supported bookmark files inside the ZIP are read. Other archive entries are not included.',
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
