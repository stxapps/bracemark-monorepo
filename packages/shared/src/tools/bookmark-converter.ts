import { toRaindropCsv } from '../export/csv';
import {
  type NetscapeBundle,
  type NetscapeFolder,
  type NetscapeLinkRow,
  toNetscapeHtml,
} from '../export/netscape';
import { toUrlText } from '../export/text';
import { parseBraceExport } from '../import/brace';
import type { ImportedLink, ImportObserver } from '../import/bundle';
import { parseRaindropCsv, scanCsv } from '../import/csv';
import { detectTextImportFormat } from '../import/detect';
import { parseLinkwardenExport } from '../import/linkwarden';
import { parseNetscapeHtml } from '../import/netscape';
import { isRaindropCsvHeader } from '../import/raindrop';
import { parseUrlText } from '../import/text';
import { canonicalUrlKey, normalizeUrl } from '../url/url';

export const BOOKMARK_CONVERTER_MAX_MB = 16;
export const BOOKMARK_CONVERTER_MAX_BYTES = BOOKMARK_CONVERTER_MAX_MB * 1_000_000;
export const BOOKMARK_CONVERTER_MAX_ROWS = 25_000;
export const BOOKMARK_CONVERTER_MAX_ENTRIES = 100;

export const BOOKMARK_OUTPUTS = [
  {
    id: 'html',
    label: 'Browser bookmarks HTML',
    extension: 'html',
    mime: 'text/html',
    description: 'Folders, titles, notes, tags, and dates. For browsers and bookmark managers.',
  },
  {
    id: 'csv',
    label: 'CSV',
    extension: 'csv',
    mime: 'text/csv',
    description:
      'For spreadsheets and CSV imports. Folders become paths; updated dates are omitted.',
  },
  {
    id: 'text',
    label: 'URL text',
    extension: 'txt',
    mime: 'text/plain',
    description: 'One web address per line. All other fields are omitted.',
  },
] as const;
export type BookmarkOutputFormat = (typeof BOOKMARK_OUTPUTS)[number]['id'];

export interface BookmarkConversionReceipt {
  sourceLabel: string;
  outputLabel: string;
  sourceRowCount: number;
  linkCount: number;
  duplicateCount: number;
  uniqueUrlCount: number;
  folderCount: number;
  emptyFolderCount: number;
  examples: { title: string; url: string; folder: string }[];
  excludedRows: { row: number; reason: string; file: string }[];
  losses: string[];
  warnings: string[];
}

export interface BookmarkConversion {
  content: string;
  extension: string;
  mime: string;
  receipt: BookmarkConversionReceipt;
}

export interface BookmarkSource {
  text: string;
  name: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function toBundle(links: ImportedLink[], paths: string[][]): NetscapeBundle {
  const bundle: NetscapeBundle = { folders: [], rootLinks: [] };
  const folders = new Map<string, NetscapeFolder>();
  function ensure(path: string[]): NetscapeFolder | undefined {
    let siblings = bundle.folders;
    let folder: NetscapeFolder | undefined;
    for (let length = 1; length <= path.length; length++) {
      const key = JSON.stringify(path.slice(0, length));
      folder = folders.get(key);
      if (!folder) {
        folder = { name: path[length - 1], links: [], children: [] };
        folders.set(key, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    return folder;
  }
  for (const path of paths) ensure(path);
  for (const link of links)
    (ensure(link.folderPath)?.links ?? bundle.rootLinks)?.push(exportRow(link));
  return bundle;
}

function flatten(bundle: NetscapeBundle): ImportedLink[] {
  const out: ImportedLink[] = [];
  function rows(links: NetscapeLinkRow[], path: string[]) {
    for (const link of links) out.push({ ...link, customTitle: link.title, folderPath: path });
  }
  function walk(folder: NetscapeFolder, path: string[]) {
    const next = [...path, folder.name];
    rows(folder.links, next);
    for (const child of folder.children) walk(child, next);
  }
  rows(bundle.rootLinks ?? [], []);
  for (const folder of bundle.folders) walk(folder, []);
  return out;
}

/** Strict file inspection around the tolerant app parsers. No URL mining fallback. */
export function convertBookmarkFiles(
  sources: BookmarkSource[],
  output: BookmarkOutputFormat = 'html',
): BookmarkConversion {
  const target = BOOKMARK_OUTPUTS.find((item) => item.id === output);
  if (!target) throw new Error('Choose a supported output format.');
  if (!sources.length || sources.length > BOOKMARK_CONVERTER_MAX_ENTRIES)
    throw new Error('Choose an export containing supported bookmark files.');
  if (
    sources.reduce((sum, source) => sum + new TextEncoder().encode(source.text).length, 0) >
    BOOKMARK_CONVERTER_MAX_BYTES
  ) {
    throw new Error(
      `This file is too large. Choose an export up to ${BOOKMARK_CONVERTER_MAX_MB} MB when expanded.`,
    );
  }
  const links: ImportedLink[] = [];
  const paths = new Map<string, string[]>();
  const sourceLabels = new Set<string>();
  const losses = new Set<string>();
  const warnings = new Set<string>();
  const excludedRows: BookmarkConversionReceipt['excludedRows'] = [];
  let sourceRowCount = 0;
  const addFolder = (path: string[]) => {
    if (path.length > 100)
      throw new Error(
        'This file has too many nested folders. Flatten the folder tree and try again.',
      );
    for (let length = 1; length <= path.length; length++) {
      const part = path.slice(0, length);
      paths.set(JSON.stringify(part), part);
      if (paths.size > BOOKMARK_CONVERTER_MAX_ROWS)
        throw new Error('This file has too many folders. Split the export and try again.');
    }
  };
  for (const source of sources) {
    const text = source.text.replace(/^\uFEFF/, '');
    const observedFolders = new Set<string>();
    const observer: ImportObserver = {
      row(row, reason) {
        sourceRowCount++;
        if (sourceRowCount > BOOKMARK_CONVERTER_MAX_ROWS)
          throw new Error(
            'This file has too many rows for this tool. Split the export and try again.',
          );
        if (reason) excludedRows.push({ row, reason, file: source.name });
      },
      folder(path) {
        const key = JSON.stringify(path);
        if (observedFolders.has(key))
          warnings.add(
            'Folders with identical paths are combined in the download. Their bookmarks are kept.',
          );
        observedFolders.add(key);
        addFolder(path);
      },
    };
    const format = detectTextImportFormat(text, source.name);
    let parsed: ImportedLink[];
    if (format === 'csv') {
      const { rows, malformed } = scanCsv(text);
      if (malformed)
        throw new Error('This CSV has an incomplete or misplaced quote. Export it again.');
      const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
      if (!header.includes('url'))
        throw new Error('This CSV needs a column named url. Choose a supported bookmark export.');
      if (new Set(header).size !== header.length)
        throw new Error('This CSV repeats a column name. Export it again.');
      if (rows.slice(1).some((row) => row.length !== header.length))
        throw new Error('Some CSV rows have a different number of columns. Export the file again.');
      const raindrop = isRaindropCsvHeader(header);
      sourceLabels.add(
        raindrop
          ? 'Raindrop.io CSV'
          : header.includes('time_added')
            ? 'Pocket CSV'
            : 'Bookmarks CSV',
      );
      const supported = new Set([
        'url',
        'folder',
        'title',
        'note',
        'tags',
        'created',
        'time_added',
        'status',
        'highlights',
        'favorite',
      ]);
      for (const [index, name] of header.entries()) {
        const populated = rows.slice(1).filter((row) => row[index]?.trim()).length;
        if (!supported.has(name) && populated)
          losses.add(`${populated} values in the CSV column “${name}” are not included.`);
      }
      if (header.includes('folder'))
        warnings.add(
          'CSV folder paths use separators. A separator inside a folder name can be read as another folder; use the original HTML export when exact nesting matters.',
        );
      if (header.includes('highlights'))
        warnings.add('Highlights are combined with notes. Favorites become a “Favorites” tag.');
      parsed = parseRaindropCsv(text, observer);
      const urlIndex = header.indexOf('url');
      const normalized = rows
        .slice(1)
        .filter(
          (row) =>
            normalizeUrl(row[urlIndex]) !== null && normalizeUrl(row[urlIndex]) !== row[urlIndex],
        ).length;
      if (normalized)
        warnings.add(`${normalized} addresses were trimmed or given an https:// prefix.`);
      const dateIndex =
        header.indexOf('created') >= 0 ? header.indexOf('created') : header.indexOf('time_added');
      const dates = rows
        .slice(1)
        .filter((row) => normalizeUrl(row[urlIndex]) !== null && row[dateIndex]?.trim()).length;
      const unreadDates = dates - parsed.filter((link) => link.createdAt !== undefined).length;
      if (unreadDates > 0) losses.add(`${unreadDates} unrecognized saved dates are not included.`);
      if (header.includes('status'))
        warnings.add(
          'Archive status becomes an ordinary Archive folder. Other status values are not carried.',
        );
    } else if (format === 'netscape') {
      if (!/<dl\b/i.test(text) || !/<dt\b/i.test(text))
        throw new Error(
          'This HTML is not a browser bookmarks export. Export bookmarks from your browser or bookmark manager.',
        );
      if ((text.match(/<dl\b/gi)?.length ?? 0) !== (text.match(/<\/dl\s*>/gi)?.length ?? 0))
        throw new Error('This bookmarks HTML has incomplete folders. Export it again.');
      sourceLabels.add('Browser bookmarks HTML');
      parsed = parseNetscapeHtml(text, observer);
      warnings.add(
        'HTML descriptions are read as plain text. Formatting, folder descriptions, icons, and extra HTML attributes are not carried.',
      );
      warnings.add(
        'HTML favorites become tags, and highlights are combined with notes when present.',
      );
    } else if (format === 'brace' || format === 'linkwarden' || /^[\s]*[[{]/.test(text)) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('This JSON export is incomplete or malformed. Export it again.');
      }
      if (record(json) && Array.isArray(json.collections)) {
        if (
          json.collections.some(
            (collection) => !record(collection) || !Array.isArray(collection.links),
          )
        )
          throw new Error('This LinkWarden export has an invalid collection. Export it again.');
        sourceLabels.add('LinkWarden JSON');
        parsed = parseLinkwardenExport(text, observer);
        losses.add(
          'LinkWarden account settings, IDs, folder descriptions, feeds, icons, and archived page references are not included.',
        );
        warnings.add(
          'LinkWarden folder order follows the export’s collection order. Pinned records are references to existing links, not extra bookmarks.',
        );
      } else if (
        Array.isArray(json) &&
        json.length > 0 &&
        json.every(
          (entry) =>
            record(entry) &&
            typeof entry.path === 'string' &&
            /^(links\/|sslts\/|pins\/|tags\/|images\/|settings)|\/images\//.test(entry.path),
        )
      ) {
        sourceLabels.add('Brace.to export');
        parsed = parseBraceExport(text, observer).links;
        losses.add(
          'Brace.to settings, images, extraction metadata, and tag colors are not included. Only the newest revision of each link is converted.',
        );
      } else
        throw new Error(
          'This JSON layout is not supported. Choose a LinkWarden or Brace.to export.',
        );
    } else {
      // A URL list is explicit: arbitrary prose, JSON, and HTML never fall
      // through to the app importer’s deliberately permissive URL scanner.
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      if (!lines.length || !lines.some((line) => /^(https?:\/\/|www\.)\S+$/i.test(line.trim())))
        throw new Error(
          'This file format is not recognized. Choose bookmarks HTML, CSV, LinkWarden JSON, a Brace.to export, or one URL per line.',
        );
      if (
        lines.some(
          (line) => /[<>{}[\]]/.test(line) && !/^(https?:\/\/|www\.)\S+$/i.test(line.trim()),
        )
      )
        throw new Error('This is not a URL list. Use one web address per line.');
      sourceLabels.add('URL text');
      parsed = parseUrlText(text, { linesOnly: true, observer });
      warnings.add(
        'Text input uses one address per line. Lines containing prose or unsupported addresses are skipped.',
      );
    }
    for (const link of parsed) {
      for (const field of ['createdAt', 'updatedAt'] as const) {
        if (link[field] !== undefined && !Number.isFinite(new Date(link[field]).getTime())) {
          delete link[field];
          losses.add('Dates outside the supported calendar range are not included.');
        }
      }
      if (link.systemList) {
        warnings.add(
          'Archive and Trash links are included in ordinary folders with those names. Importing them elsewhere may make them active bookmarks.',
        );
        link.folderPath = [link.systemList === 'archive' ? 'Archive' : 'Trash'];
      }
      addFolder(link.folderPath);
      links.push(link);
    }
  }
  if (links.length !== sourceRowCount - excludedRows.length)
    throw new Error('Could not account for every bookmark record. Export the file again.');
  if (!links.length)
    throw new Error('This file has no web addresses to convert. Choose another export.');
  const occupied = new Set<string>();
  for (const link of links)
    for (let length = 1; length <= link.folderPath.length; length++)
      occupied.add(JSON.stringify(link.folderPath.slice(0, length)));
  const emptyFolderCount = [...paths.keys()].filter((key) => !occupied.has(key)).length;
  const bundle = toBundle(links, [...paths.values()]);
  const expected = flatten(bundle);
  const content =
    output === 'html'
      ? toNetscapeHtml(bundle, { includeNotes: true })
      : output === 'csv'
        ? toRaindropCsv(bundle, { spreadsheetSafe: true })
        : toUrlText(bundle);
  const actual =
    output === 'html'
      ? parseNetscapeHtml(content)
      : output === 'csv'
        ? parseRaindropCsv(content)
        : parseUrlText(content, { linesOnly: true });
  if (
    JSON.stringify(expected.map((link) => link.url)) !==
    JSON.stringify(actual.map((link) => link.url))
  )
    throw new Error('Could not verify the converted file. No download was prepared.');
  // Compare every portable field, including serializer normalization, so a
  // verified URL count can never masquerade as lossless metadata conversion.
  const fields = [
    ['titles', (link: ImportedLink) => link.customTitle ?? link.title ?? link.url],
    ['folder paths', (link: ImportedLink) => link.folderPath],
    ['notes', (link: ImportedLink) => link.note ?? ''],
    ['tag sets', (link: ImportedLink) => link.tagNames],
    ['saved dates', (link: ImportedLink) => link.createdAt ?? null],
    ['updated dates', (link: ImportedLink) => link.updatedAt ?? null],
  ] as const;
  for (const [name, value] of fields) {
    const changed = expected.filter(
      (link, index) => JSON.stringify(value(link)) !== JSON.stringify(value(actual[index])),
    ).length;
    if (changed) losses.add(`${changed} ${name} are changed or omitted in ${target.label}.`);
  }
  if (output !== 'html' && emptyFolderCount)
    losses.add(`${emptyFolderCount} empty folders are not included.`);
  const pins = links.filter((link) => link.pinRank !== undefined).length;
  if (pins) losses.add(`${pins} pin positions are not included.`);
  if (output === 'html')
    warnings.add(
      'Notes and tags are written as HTML descriptions and bookmark tags; destination apps may ignore them. Dates use whole seconds.',
    );
  if (output === 'csv') {
    warnings.add(
      'CSV uses url, folder, title, note, tags, and created columns. Folders use “/”; tags use commas. Separators in names may change their meaning.',
    );
    warnings.add(
      'Spreadsheet protection adds an apostrophe before cells that could be formulas. A bookmark importer may display that apostrophe.',
    );
  }
  if (output === 'text')
    warnings.add('URL text contains addresses only, including repeated addresses.');
  if (excludedRows.length)
    warnings.add(
      `${excludedRows.length} source records are excluded. See the skipped-record list.`,
    );
  warnings.add('Repeated addresses stay in the file. No links are merged.');
  const seen = new Set(links.map((link) => canonicalUrlKey(link.url) ?? link.url));
  return {
    content,
    extension: target.extension,
    mime: `${target.mime};charset=utf-8`,
    receipt: {
      sourceLabel: [...sourceLabels].join(' + '),
      outputLabel: target.label,
      sourceRowCount,
      linkCount: links.length,
      duplicateCount: links.length - seen.size,
      uniqueUrlCount: seen.size,
      folderCount: paths.size,
      emptyFolderCount,
      examples: links.slice(0, 5).map((link) => ({
        title: link.customTitle ?? link.title ?? link.url,
        url: link.url,
        folder: link.folderPath.join(' / ') || 'Top level',
      })),
      excludedRows: excludedRows.sort((a, b) => a.file.localeCompare(b.file) || a.row - b.row),
      losses: [...losses],
      warnings: [...warnings],
    },
  };
}

export function bookmarkReceiptText(conversion: BookmarkConversion): string {
  const r = conversion.receipt;
  return [
    'Bookmark conversion receipt',
    `${r.sourceLabel} → ${r.outputLabel}`,
    '',
    `Source records: ${r.sourceRowCount}`,
    `Web links exported: ${r.linkCount}`,
    `Records skipped: ${r.excludedRows.length}`,
    `Unique canonical addresses: ${r.uniqueUrlCount}`,
    `Possible repeats: ${r.duplicateCount} (kept)`,
    `Source folders: ${r.folderCount}`,
    `Empty folders: ${r.emptyFolderCount}`,
    '',
    'Excluded records',
    ...(r.excludedRows.length
      ? r.excludedRows.map((item) => `${item.file}, record ${item.row}: ${item.reason}`)
      : ['None.']),
    '',
    'Changes and losses',
    ...(r.losses.length
      ? r.losses
      : ['No changes to the parsed bookmark fields. Check the format caveats below.']),
    '',
    'Format caveats',
    ...r.warnings,
    '',
    'The original file was not changed. Nothing was imported into Bracemark.',
  ].join('\n');
}
