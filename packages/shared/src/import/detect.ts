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

export type TextImportFormat = 'brace' | 'linkwarden' | 'netscape' | 'csv' | 'text';

// A Brace.to export: a JSON array whose first entry is `{ "path": "<namespace>…`
// (the exporter always writes `path` before `data`, and always writes the link
// files first). A STRUCTURAL probe over the head of the file, not a JSON.parse —
// detection runs on every import and the file can be tens of MB, which the parser
// then reads in full exactly once.
//
// Brace names its export `.txt`, so without this the file sniffs as plain text and
// the URL regex mines the raw JSON: every dead revision, every `extractedResult`
// image URL, every favicon. It degrades to a plausible-looking mess rather than an
// error, which is what makes the structural check worth its precision.
// A leading \uFEFF is the UTF-8 BOM some editors/transfers prepend (written as
// an escape, not a literal — a bare BOM in source is invisible and lint-flagged).
const BRACE_HEAD_RE = /^\uFEFF?\s*\[\s*\{\s*"path"\s*:\s*"(links|sslts|pins|tags|images|settings)/;

// A LinkWarden backup: a JSON OBJECT carrying a `collections` array. Two parts,
// because one is not enough. The ANCHOR is the opening brace, which on its own
// separates this from every other format here — a Brace.to export is an array, a
// bookmarks file opens with a tag, and neither a CSV header nor a list of URLs
// starts with `{`. The KEY then has to be found by scanning rather than at a
// fixed offset: LinkWarden exports the user's Prisma row (linkwarden's
// `exportData.ts`), so its scalar columns come first and `collections` sits
// after however many of them that schema has — a number we don't control and
// can't anchor to. The scan is safe here precisely because the anchor already
// did the excluding, which is the same bargain BRACE_HEAD_RE makes in the other
// order.
//
// Without this probe the file is TEXT, and the URL-extracting parser mines the
// raw JSON: a flat pile of links with every collection, tag, note and pin gone,
// and no error anywhere. See import/linkwarden.ts.
const LINKWARDEN_OBJECT_RE = /^\uFEFF?\s*\{/;
const LINKWARDEN_COLLECTIONS_RE = /"collections"\s*:\s*\[/;

// The doctype a browser, Karakeep, Delicious, Shaarli or Google Bookmarks export
// opens with — verified against one file from each, in
// __fixtures__/netscape (netscape-exports.spec.ts). ANCHORED to the head of the
// file for the same reason BRACE_HEAD_RE is: unanchored, this
// matched the string anywhere, so a saved page titled
// `<!DOCTYPE NETSCAPE-Bookmark-file-1>` sent our own CSV export to the HTML
// tokenizer. Same shape as the `</a>` bug below it, one rung less reachable.
//
// Anchoring cannot lose a real bookmarks file: a browser writes the doctype at
// byte 0, and anything with it buried somewhere else still carries `</a>` and is
// claimed by the scan further down. `\s+` (not a literal space) tolerates a tab
// or a run of spaces; the BOM and leading blank lines are the same allowance the
// brace probe makes.
const NETSCAPE_DOCTYPE_RE = /^\uFEFF?\s*<!doctype\s+netscape/i;

// Precedence, strongest signal first — and "strongest" means POSITIONALLY
// ANCHORED, not most specific. A probe that reads a fixed place in the file
// (byte 0, the header line) can only be triggered by structure; a scan over the
// whole text can be triggered by any link's title, because a title carries
// whatever the page's <title> did. So: anchored probes, then whole-text scans,
// then the filename.
//
// That ordering is not theoretical. The `</a>` scan below used to run before the
// header check, which meant OUR OWN CSV export — `url,folder,title,note,tags,
// created` — sniffed as Netscape HTML the moment one saved page had `</a>` in its
// title. The tokenizer then found no anchors and the import reported zero links:
// a user's whole library, silently, with no error. The brace probe was already
// first for exactly this reason (see the comment on BRACE_HEAD_RE); the CSV half
// was one format short.
export function detectTextImportFormat(text: string, filename = ''): TextImportFormat {
  const lower = filename.toLowerCase();

  // A Brace link's stored title can contain any markup the page's <title> did,
  // so `</a>` is not the stronger signal here.
  if (BRACE_HEAD_RE.test(text.slice(0, 4096))) return 'brace';

  // Structural, and ahead of every scan below for the same reason the Brace
  // probe is: a LinkWarden link's `name` holds whatever the page's <title> did,
  // so a saved page called `</a>` or one with a comma would otherwise route this
  // file to the HTML tokenizer or the CSV reader.
  if (LINKWARDEN_OBJECT_RE.test(text) && LINKWARDEN_COLLECTIONS_RE.test(text)) return 'linkwarden';

  // The one HTML signal strong enough to outrank a CSV header row.
  if (NETSCAPE_DOCTYPE_RE.test(text)) return 'netscape';

  // CSV: a header row naming a `url` column (export/csv.ts's and Raindrop's both
  // do). Cheap header split — quoting never matters for recognizing the word
  // `url` among column names. Anchored to the FIRST LINE, which is what lets it
  // outrank the anchor scan below.
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const headerCells = firstLine
    .toLowerCase()
    .split(',')
    .map((cellText) => cellText.trim().replace(/^"|"$/g, ''));
  if (headerCells.length > 1 && headerCells.includes('url')) return 'csv';

  // Any anchor tag at all (the old client used the same `</a>` test), or an
  // .html name. Unanchored, so it runs after the header row above.
  if (/<\/a\s*>/i.test(text) || lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'netscape';
  }

  // The filename only breaks ties, so it goes last for CSV too.
  if (lower.endsWith('.csv')) return 'csv';

  return 'text';
}
