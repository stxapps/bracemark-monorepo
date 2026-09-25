import {
  type NetscapeBundle,
  type NetscapeFolder,
  type NetscapeLinkRow,
  toNetscapeHtml,
} from '../export/netscape';
import type { ImportedLink } from '../import/bundle';
import { parseRaindropCsv, scanCsv } from '../import/csv';
import { parseNetscapeHtml } from '../import/netscape';
import { canonicalUrlKey, normalizeUrl } from '../url/url';

export const BOOKMARK_CONVERTER_MAX_MB = 4;
export const BOOKMARK_CONVERTER_MAX_BYTES = BOOKMARK_CONVERTER_MAX_MB * 1024 * 1024;
const MAX_ROWS = 25_000;

export interface BookmarkConversionReceipt {
  sourceRows: number;
  webLinks: number;
  skippedRows: number;
  possibleDuplicates: number;
  folders: number;
  examples: { title: string; url: string; folder: string }[];
  excludedRows: { row: number; reason: string }[];
  losses: string[];
  warnings: string[];
}

export interface BookmarkConversion {
  html: string;
  receipt: BookmarkConversionReceipt;
}

function exportRow(link: ImportedLink): NetscapeLinkRow {
  return {
    url: link.url,
    title: link.customTitle ?? link.title ?? link.url,
    tagNames: link.tagNames,
    ...(link.note === undefined ? {} : { note: link.note }),
    ...(link.createdAt === undefined ? {} : { createdAt: link.createdAt }),
    ...(link.updatedAt === undefined ? {} : { updatedAt: link.updatedAt }),
  };
}

function toBundle(links: ImportedLink[]): NetscapeBundle {
  const bundle: NetscapeBundle = { folders: [], rootLinks: [] };
  const folders = new Map<string, NetscapeFolder>();

  for (const link of links) {
    let siblings = bundle.folders;
    let folder: NetscapeFolder | undefined;
    const path: string[] = [];
    for (const name of link.folderPath) {
      path.push(name);
      const key = JSON.stringify(path);
      folder = folders.get(key);
      if (!folder) {
        folder = { name, links: [], children: [] };
        folders.set(key, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    if (folder) folder.links.push(exportRow(link));
    else bundle.rootLinks?.push(exportRow(link));
  }
  return bundle;
}

function signature(link: ImportedLink): string {
  return JSON.stringify([
    link.url,
    link.customTitle ?? link.title ?? link.url,
    link.folderPath,
    link.tagNames,
    link.note ?? null,
    link.createdAt === undefined ? null : Math.floor(link.createdAt / 1000),
  ]);
}

/** One deliberately narrow, local conversion. No importer fallback or account data. */
export function convertRaindropCsvToBookmarksHtml(text: string): BookmarkConversion {
  if (new TextEncoder().encode(text).length > BOOKMARK_CONVERTER_MAX_BYTES) {
    throw new Error(
      `This file is too large. Choose a CSV export under ${BOOKMARK_CONVERTER_MAX_MB} MB.`,
    );
  }

  const { rows, malformed } = scanCsv(text);
  if (malformed) throw new Error('This CSV has an incomplete or misplaced quote. Export it again.');
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const required = [
    'id',
    'title',
    'note',
    'excerpt',
    'url',
    'folder',
    'tags',
    'created',
    'cover',
    'highlights',
    'favorite',
  ];
  if (!required.every((name) => header.includes(name))) {
    throw new Error('Choose a Raindrop.io CSV export. Other CSV layouts are not supported yet.');
  }
  if (new Set(header).size !== header.length) {
    throw new Error('This CSV repeats a column name. Export it again.');
  }
  if (rows.length < 2) throw new Error('This CSV has no bookmark rows to convert.');
  if (rows.length - 1 > MAX_ROWS) {
    throw new Error('This CSV has too many rows for this tool. Split the export and try again.');
  }
  if (rows.slice(1).some((row) => row.length !== header.length)) {
    throw new Error('Some CSV rows have a different number of columns. Export the file again.');
  }

  const index = (name: string) => header.indexOf(name);
  const cell = (row: string[], name: string) => row[index(name)]?.trim() ?? '';
  const sourceRows = rows.slice(1);
  const excludedRows: BookmarkConversionReceipt['excludedRows'] = [];
  let skippedRows = 0;
  let ambiguousFolders = 0;
  let notes = 0;
  let excerpts = 0;
  let covers = 0;
  let highlights = 0;
  let ids = 0;
  let normalizedUrls = 0;
  for (const [position, row] of sourceRows.entries()) {
    const rawUrl = cell(row, 'url');
    const normalizedUrl = normalizeUrl(rawUrl);
    if (normalizedUrl === null) {
      skippedRows++;
      excludedRows.push({
        row: position + 2,
        reason: rawUrl === '' ? 'No address' : 'Not a web address',
      });
      continue;
    }
    if (normalizedUrl !== rawUrl) normalizedUrls++;
    if (cell(row, 'folder').includes(' / ')) ambiguousFolders++;
    if (cell(row, 'note')) notes++;
    if (cell(row, 'excerpt')) excerpts++;
    if (cell(row, 'cover')) covers++;
    if (cell(row, 'highlights')) highlights++;
    if (cell(row, 'id')) ids++;
  }

  const links = parseRaindropCsv(text);
  if (links.length !== sourceRows.length - skippedRows) {
    throw new Error('Could not account for every row in this CSV. Export the file again.');
  }
  if (links.length === 0) throw new Error('This CSV has no web addresses to convert.');

  const html = toNetscapeHtml(toBundle(links), { includeNotes: true });
  const reparsed = parseNetscapeHtml(html);
  const expected = links.map(signature).sort();
  const actual = reparsed.map(signature).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Could not verify the converted file. No download was prepared.');
  }

  const seen = new Set<string>();
  let possibleDuplicates = 0;
  const folderKeys = new Set<string>();
  for (const link of links) {
    const key = canonicalUrlKey(link.url) ?? link.url;
    if (seen.has(key)) possibleDuplicates++;
    else seen.add(key);
    for (let length = 1; length <= link.folderPath.length; length++) {
      folderKeys.add(JSON.stringify(link.folderPath.slice(0, length)));
    }
  }

  const losses: string[] = [];
  if (excerpts) losses.push(`${excerpts} excerpts are not included.`);
  if (covers) losses.push(`${covers} cover image references are not included.`);
  if (ids) losses.push(`${ids} Raindrop.io item IDs are not included.`);
  if (links.some((link) => link.createdAt !== undefined && link.createdAt % 1000 !== 0)) {
    losses.push('Saved times are rounded down to whole seconds in bookmarks HTML.');
  }

  const warnings: string[] = [];
  if (ambiguousFolders) {
    warnings.push(
      `${ambiguousFolders} rows have folder paths separated by “ / ”. A folder name containing those characters cannot be distinguished from nested folders in this CSV. Use Raindrop.io’s HTML export when exact nesting matters.`,
    );
  }
  if (links.some((link) => link.tagNames.length > 0)) {
    warnings.push(
      'Tags and favorites are written as HTML bookmark tags, but browsers may ignore them.',
    );
  }
  if (notes || highlights) {
    warnings.push(
      `${notes} notes and ${highlights} highlight sets are written as HTML descriptions, but browsers may ignore them.`,
    );
  }
  if (skippedRows)
    warnings.push(`${skippedRows} rows without a web address are excluded from the download.`);
  if (normalizedUrls) {
    warnings.push(`${normalizedUrls} addresses were trimmed or given an https:// prefix.`);
  }
  warnings.push('Repeated addresses stay in the file. No links are merged.');

  return {
    html,
    receipt: {
      sourceRows: sourceRows.length,
      webLinks: links.length,
      skippedRows,
      possibleDuplicates,
      folders: folderKeys.size,
      examples: links.slice(0, 5).map((link) => ({
        title: link.customTitle ?? link.title ?? link.url,
        url: link.url,
        folder: link.folderPath.join(' / ') || 'Top level',
      })),
      excludedRows,
      losses,
      warnings,
    },
  };
}
