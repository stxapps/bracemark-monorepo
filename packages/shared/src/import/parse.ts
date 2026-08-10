// The interop text dispatch — detect the format, then run its parser. Trivial,
// and precisely because it's trivial it was written four times (each
// orchestrator ran it twice: once for a top-level text file, once per text
// entry inside a zipped export). One definition means a fourth interop format
// is added HERE and every caller gets it.
//
// Bytes-vs-text stays the caller's call: a Bracemark backup is a zip, so callers
// check isZipBytes (detect.ts) FIRST and only decode to text on the other
// branch.

import type { ImportedLink } from './bundle';
import { parseRaindropCsv } from './csv';
import { detectTextImportFormat } from './detect';
import { parseNetscapeHtml } from './netscape';
import { parseUrlText } from './text';

// `filename` only breaks ties in detection (see detect.ts — content decides);
// pass the zip entry's name when parsing inside an archive.
export function parseImportText(text: string, filename = ''): ImportedLink[] {
  const format = detectTextImportFormat(text, filename);
  if (format === 'netscape') return parseNetscapeHtml(text);
  if (format === 'csv') return parseRaindropCsv(text);
  return parseUrlText(text);
}
