import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';
import { parseEpoch } from './epoch';
import {
  csvHighlights,
  FAVORITES_TAG,
  isRaindropCsvHeader,
  withHighlights,
  withoutUnsorted,
} from './raindrop';

// CSV parser targeting Raindrop.io's export (and export/csv.ts's own output —
// the two share the url/folder/title/note/tags/created columns) plus Pocket's
// final shutdown export (title/url/time_added/tags/status, whose `archive`
// status lands as `systemList` rather than as a folder). HEADER-DRIVEN,
// not positional: a real Raindrop export carries extra columns (id, excerpt,
// cover, highlights, favorite) and may reorder them, so each field is looked up
// by its lowercased header name and unknown columns are ignored. A file whose
// header has no `url` column parses to [] — it isn't a links CSV. Of Raindrop's
// extras, `highlights` and `favorite` are read (raindrop.ts, shared with the
// HTML side of the same export); id, excerpt and cover are not.
//
// The grammar is RFC 4180 (quoted fields, doubled inner quotes, CRLF rows) plus
// the real-world relaxations: bare LF rows, a UTF-8 BOM, and newlines inside
// quoted fields (Raindrop notes have them).
//
// The `title` column crosses as `customTitle`: Raindrop, Pocket and our own
// export all write whatever title the user was looking at, renamed or not, and
// none of them says which — see ImportedLink.customTitle (bundle.ts).

// One pass, character-wise — small and total: every input yields SOME row
// split, garbage never throws, and the header gate above decides relevance.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Flush a final row that has no trailing newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A row that's one empty field is a blank line, not data.
  return rows.filter((r) => r.length > 1 || r[0].trim() !== '');
}

// A folder cell → the path it names. Our own export and the `a/b/c` shape
// Raindrop's IMPORT docs describe join the chain with a bare `/`. Raindrop's
// EXPORT joins it with ` / ` and writes each collection's name as-is, so there a
// collection named `AEO/GEO` survives only if the split is on the padded form —
// splitting on `/` would invent two lists. One named `SEO / AEO` is lost either
// way: the CSV can't say it, and the same library's HTML export can.
function folderPath(value: string, raindrop: boolean): string[] {
  const path = value
    .split(raindrop ? ' / ' : '/')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return raindrop ? withoutUnsorted(path) : path;
}

export function parseRaindropCsv(text: string): ImportedLink[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map((name) => name.trim().toLowerCase());
  const urlCol = header.indexOf('url');
  if (urlCol === -1) return [];
  const folderCol = header.indexOf('folder');
  const titleCol = header.indexOf('title');
  const noteCol = header.indexOf('note');
  const tagsCol = header.indexOf('tags');
  // `created` is Raindrop's/ours; `time_added` is Pocket's column for the same.
  const createdCol =
    header.indexOf('created') !== -1 ? header.indexOf('created') : header.indexOf('time_added');
  // Pocket's `status`. Neither Raindrop's export nor ours has this column.
  const statusCol = header.indexOf('status');
  // Raindrop's own two, folded the same way netscape.ts folds the HTML's
  // (raindrop.ts). Only its export writes them.
  const highlightsCol = header.indexOf('highlights');
  const favoriteCol = header.indexOf('favorite');
  const raindrop = isRaindropCsvHeader(header);

  // A missing column (col === -1) reads as '' — `at(-1)` semantics would grab
  // the last cell, so index guardedly.
  const cell = (row: string[], col: number) => (col === -1 ? '' : (row[col] ?? '')).trim();

  const links: ImportedLink[] = [];
  for (const row of rows.slice(1)) {
    const url = normalizeUrl(cell(row, urlCol));
    if (url === null) continue;

    const link: ImportedLink = {
      url,
      // Comma is Raindrop's separator, pipe is Pocket's; neither occurs in a
      // tag name, so splitting on both reads either file right.
      tagNames: cell(row, tagsCol)
        .split(/[,|]/)
        .map((name) => name.trim())
        .filter((name) => name !== ''),
      folderPath: folderPath(cell(row, folderCol), raindrop),
    };

    const title = cell(row, titleCol);
    if (title !== '') link.customTitle = title;
    const note = withHighlights(cell(row, noteCol), csvHighlights(cell(row, highlightsCol)));
    if (note !== undefined) link.note = note;
    if (cell(row, favoriteCol) === 'true' && !link.tagNames.includes(FAVORITES_TAG)) {
      link.tagNames.push(FAVORITES_TAG);
    }

    // ISO 8601 (what export/csv.ts and Raindrop both write) or a bare epoch
    // number (Pocket's time_added, unix seconds); anything neither reads is
    // simply no timestamp.
    const createdRaw = cell(row, createdCol);
    const created = parseEpoch(createdRaw) ?? Date.parse(createdRaw);
    if (!Number.isNaN(created)) link.createdAt = created;

    // Pocket's two statuses are `unread` and `archive`, and the second one is the
    // same statement `systemList` makes (see bundle.ts) — a Pocket library is
    // mostly archive, so reading the column as nothing put a decade of read items
    // into the user's main list, in one indistinguishable heap with the unread
    // ones. The value is matched, never the column's presence: an unknown status
    // leaves the row a normal link rather than guessing a list for it. `trash` is
    // deliberately NOT mapped — no exporter writes it, and a wrong guess there
    // files a live link as deleted.
    const status = cell(row, statusCol).toLowerCase();
    if (status === 'archive' || status === 'archived') link.systemList = 'archive';

    links.push(link);
  }
  return links;
}
