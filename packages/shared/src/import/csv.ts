import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';
import { parseEpoch } from './epoch';

// CSV parser targeting Raindrop.io's export (and export/csv.ts's own output —
// the two share the url/folder/title/note/tags/created columns) plus Pocket's
// final shutdown export (title/url/time_added/tags/status). HEADER-DRIVEN,
// not positional: a real Raindrop export carries extra columns (id, excerpt,
// cover, highlights, favorite) and may reorder them, so each field is looked up
// by its lowercased header name and unknown columns are ignored. A file whose
// header has no `url` column parses to [] — it isn't a links CSV.
//
// The grammar is RFC 4180 (quoted fields, doubled inner quotes, CRLF rows) plus
// the real-world relaxations: bare LF rows, a UTF-8 BOM, and newlines inside
// quoted fields (Raindrop notes have them).

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
      // The slash-joined list path our own export writes and Raindrop's nested
      // collections use ("Parent/Child").
      folderPath: cell(row, folderCol)
        .split('/')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    };

    const title = cell(row, titleCol);
    if (title !== '') link.title = title;
    const note = cell(row, noteCol);
    if (note !== '') link.note = note;

    // ISO 8601 (what export/csv.ts and Raindrop both write) or a bare epoch
    // number (Pocket's time_added, unix seconds); anything neither reads is
    // simply no timestamp.
    const createdRaw = cell(row, createdCol);
    const created = parseEpoch(createdRaw) ?? Date.parse(createdRaw);
    if (!Number.isNaN(created)) link.createdAt = created;

    links.push(link);
  }
  return links;
}
