import {
  BOOKMARK_CONVERTER_MAX_BYTES,
  BOOKMARK_CONVERTER_MAX_MB,
  type BookmarkConversion,
  convertRaindropCsvToBookmarksHtml,
} from '@stxapps/shared';

export type ConversionMessage =
  { ok: true; conversion: BookmarkConversion } | { ok: false; message: string };

// `globalThis`, not `self`: the same object in a dedicated worker, but only
// `globalThis` exists under node, where the spec loads this module directly.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<File>) => void) | null;
  postMessage(message: ConversionMessage): void;
};

scope.onmessage = async (event) => {
  try {
    const file = event.data;
    if (file.size > BOOKMARK_CONVERTER_MAX_BYTES) {
      throw new Error(
        `This file is too large. Choose a CSV export up to ${BOOKMARK_CONVERTER_MAX_MB} MB.`,
      );
    }
    scope.postMessage({
      ok: true,
      conversion: convertRaindropCsvToBookmarksHtml(await file.text()),
    });
  } catch (cause) {
    scope.postMessage({
      ok: false,
      message:
        cause instanceof Error ? cause.message : 'Could not check this file. Please try again.',
    });
  }
};
