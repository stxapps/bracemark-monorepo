// The interop text dispatch — detect the format, then run its parser. Trivial,
// and precisely because it's trivial it was written four times (each
// orchestrator ran it twice: once for a top-level text file, once per text
// entry inside a zipped export). One definition means a fourth interop format
// is added HERE and every caller gets it.
//
// Bytes-vs-text stays the caller's call: a Bracemark backup is a zip, so callers
// check isZipBytes (detect.ts) FIRST and only decode to text on the other
// branch.
//
// The return is an ImportedBundle (rows + any blobs they reference), not bare
// rows: the four interop parsers never carry bytes and yield an empty map, but
// a Brace.to export does. Widening the ONE dispatch keeps the alternative —
// every caller special-casing the formats that have blobs — from coming back.

import { parseBraceExportSteps } from './brace';
import type { ImportedBundle, ImportedLink } from './bundle';
import { parseRaindropCsvSteps } from './csv';
import { detectTextImportFormat } from './detect';
import { parseLinkwardenExportSteps } from './linkwarden';
import { parseNetscapeHtmlSteps } from './netscape';
import { runSteps, runStepsWithPauses } from './steps';
import { parseUrlTextSteps } from './text';

// `filename` only breaks ties in detection (see detect.ts — content decides);
// pass the zip entry's name when parsing inside an archive.
export function parseImportText(text: string, filename = ''): ImportedBundle {
  return runSteps(parseImportTextSteps(text, filename));
}

// The same dispatch, handing the thread back between chunks: what both import
// orchestrators await, with their platform's `yieldToMain` as `pause`. On Hermes
// a 10,000-link file took 0.5–0.8 s to parse in any of the five formats, nearly
// all of it `new URL` in normalizeUrl (docs/data-lifecycle.md, _readings — expo_).
export function parseImportTextInChunks(
  text: string,
  filename: string,
  pause: () => Promise<void>,
): Promise<ImportedBundle> {
  return runStepsWithPauses(parseImportTextSteps(text, filename), pause);
}

function* parseImportTextSteps(text: string, filename: string): Generator<void, ImportedBundle> {
  const format = detectTextImportFormat(text, filename);
  if (format === 'brace') return yield* parseBraceExportSteps(text);

  let links: ImportedLink[];
  if (format === 'linkwarden') links = yield* parseLinkwardenExportSteps(text);
  else if (format === 'netscape') links = yield* parseNetscapeHtmlSteps(text);
  else if (format === 'csv') links = yield* parseRaindropCsvSteps(text);
  else links = yield* parseUrlTextSteps(text);

  return { links, images: new Map() };
}
