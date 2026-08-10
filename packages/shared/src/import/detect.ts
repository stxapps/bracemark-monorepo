// Import-format detection — the dispatch in front of the parsers. Two layers,
// because a Bracemark backup is BYTES (a zip) while the interop formats are text:
// the caller first checks the raw bytes with isZipBytes (a zip is never sniffed
// as text), then routes decoded text through detectTextImportFormat.
//
// CONTENT decides, the filename only breaks ties: files travel through email
// and chat renamed to .txt all the time, and every misroute here still degrades
// gracefully (the text parser finds a bookmark file's URLs, just without its
// folders), so the sniff favors the richer format on any positive signal.

// The zip local-file-header magic, "PK\x03\x04" — what export/'s zip.js writes
// and any real bookmark/CSV/text file can't start with.
export function isZipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export type TextImportFormat = 'netscape' | 'csv' | 'text';

export function detectTextImportFormat(text: string, filename = ''): TextImportFormat {
  const lower = filename.toLowerCase();

  // Netscape HTML: the doctype every browser/Karakeep/LinkWarden export opens
  // with, or any anchor tag at all (a links CSV/text file never contains one —
  // the old client used the same `</a>` test), or an .html extension.
  if (
    /<!doctype netscape/i.test(text) ||
    /<\/a\s*>/i.test(text) ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm')
  ) {
    return 'netscape';
  }

  // CSV: a header row naming a `url` column (export/csv.ts's and Raindrop's
  // both do), or a .csv extension. Cheap header split — quoting never matters
  // for recognizing the word `url` among column names.
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const headerCells = firstLine
    .toLowerCase()
    .split(',')
    .map((cellText) => cellText.trim().replace(/^"|"$/g, ''));
  if ((headerCells.length > 1 && headerCells.includes('url')) || lower.endsWith('.csv')) {
    return 'csv';
  }

  return 'text';
}
