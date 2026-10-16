import {
  assertBackupTreeDepth,
  BackupVersionError,
  type BundleEntry,
  classifyBundleLine,
  parseBackupManifest,
} from '../data/backup';
import {
  bundleFromImported,
  bundleFromLibrary,
  type ExportBundle,
  type ExportLinkRow,
  foldersWithPaths,
  type LibraryLink,
} from '../export/bundle';
import { toRaindropCsv } from '../export/csv';
import { toNetscapeHtml } from '../export/netscape';
import { toUrlText } from '../export/text';
import { entitlementsOf, PLANS } from '../iap/plans';
import { parseBraceExport } from '../import/brace';
import type { ImportedLink, ImportObserver } from '../import/bundle';
import { parseRaindropCsv, scanCsv } from '../import/csv';
import { detectTextImportFormat } from '../import/detect';
import { isRecord } from '../import/is-record';
import { parseLinkwardenExport } from '../import/linkwarden';
import { parseNetscapeHtml } from '../import/netscape';
import { isRaindropCsvHeader } from '../import/raindrop';
import { IMPORT_MAX_FOLDER_DEPTH, ImportFolderDepthError } from '../import/resolve';
import { parseUrlText } from '../import/text';
import type { Extraction, Link, List, Tag } from '../sync/entities';
import { EXTRACTIONS_PREFIX, LINKS_PREFIX, rekey } from '../sync/paths';
import { ARCHIVE_ID, mergeSystemLists, TRASH_ID } from '../sync/system-lists';
import { canonicalUrlKey, normalizeUrl } from '../url/url';

// One set of limits for every input. The converter is client-only, so they
// protect the tab, not a server: a browser out of memory kills the page with no
// message, while a limit is a sentence the user can act on. Conversion memory
// grows with the bookmark data (CSV output the most, and long notes most of
// all), and these are sized from measurement so a phone's tab survives the peak
// (docs/data-lifecycle.md, _the bookmark converter's limits_).
export const BOOKMARK_CONVERTER_MAX_MB = 60;
export const BOOKMARK_CONVERTER_MAX_BYTES = BOOKMARK_CONVERTER_MAX_MB * 1_000_000;
export const BOOKMARK_CONVERTER_MAX_ROWS = 100_000;
export const BOOKMARK_CONVERTER_MAX_ENTRIES = 100;

// A Bracemark backup is the exception in one respect only: the worker reads its
// manifest.json and items.jsonl and never the `files/` blobs, which are most of
// its bytes, so the ZIP itself has no size limit and its entry count is bounded
// by what any plan can store (plus the two entries read). items.jsonl is held
// to the limits above like any other input.
//
// A backup can't be split the way an export can, so past either limit the act is
// the app's own export.
export const BOOKMARK_CONVERTER_BACKUP_TOO_LARGE =
  'This backup has more links than this converter reads at once. Export HTML or CSV in the app from Settings → Data instead.';
export const BOOKMARK_CONVERTER_BACKUP_TOO_MANY_LISTS =
  'This backup has more lists than this converter reads at once. Export HTML or CSV in the app from Settings → Data instead.';
export const BOOKMARK_CONVERTER_BACKUP_MAX_ENTRIES =
  Math.max(...PLANS.map((plan) => entitlementsOf(plan).maxFiles)) + 2;

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
  // Links left out because they were in Trash — not skipped records: each was
  // read and understood, and dropped on purpose.
  trashCount: number;
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
  // Present ⇒ this source is a Bracemark backup: `text` is its items.jsonl and
  // this is its manifest.json.
  backupManifest?: string;
}

function flatten(bundle: ExportBundle): ImportedLink[] {
  const out: ImportedLink[] = [];
  function rows(links: ExportLinkRow[], path: string[]) {
    for (const link of links) out.push({ ...link, customTitle: link.title, folderPath: path });
  }
  rows(bundle.rootLinks ?? [], []);
  for (const { folder, path } of foldersWithPaths(bundle.folders)) rows(folder.links, path);
  return out;
}

// A Bracemark backup, read the way the app exports: its entities go through the
// same bundleFromLibrary both platforms' export orchestrators call, so a
// converted backup is the file the app would have written — same folders,
// titles, order, and the same Trash rule. Only link lines and invalid lines are
// records; lists, tags, pins, extractions, and settings support the links.
function readBackup(
  text: string,
  observer: ImportObserver,
): { bundle: ExportBundle; trashCount: number; archiveCount: number } {
  const byKind = new Map<BundleEntry['kind'], BundleEntry[]>();
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const entry = classifyBundleLine(line);
    if (!entry) {
      observer.row(index + 1, 'Not a valid backup record');
      continue;
    }
    if (entry.kind === 'link') observer.row(index + 1);
    const entries = byKind.get(entry.kind);
    if (entries) entries.push(entry);
    else byKind.set(entry.kind, [entry]);
  }
  const of = (kind: BundleEntry['kind']) => byKind.get(kind) ?? [];
  // Lists aren't records, so the row limit above never saw them, and every one
  // costs a path copy below — bounded by the byte limit alone until this. Held
  // to the same number as the rows, then to the app's depth rule, both before
  // the tree is built: the walk that copies a path per folder is what they bound.
  if (of('list').length > BOOKMARK_CONVERTER_MAX_ROWS) {
    throw new Error(BOOKMARK_CONVERTER_BACKUP_TOO_MANY_LISTS);
  }
  assertBackupTreeDepth([...of('list'), ...of('tag')]);
  const extractions = new Map(of('extraction').map((entry) => [entry.path, entry.data]));
  const links: LibraryLink[] = of('link').map((entry) => ({
    link: entry.data as Link,
    extraction: extractions.get(rekey(entry.path, LINKS_PREFIX, EXTRACTIONS_PREFIX)) as
      Extraction | undefined,
  }));
  links.sort((a, b) => b.link.createdAt - a.link.createdAt);
  const lists = mergeSystemLists(
    of('list').map((entry) => ({ ...(entry.data as List), path: entry.path })),
  );
  const tags = of('tag').map((entry) => entry.data as Tag);
  return {
    bundle: bundleFromLibrary(links, lists, tags),
    trashCount: links.filter(({ link }) => link.listId === TRASH_ID).length,
    archiveCount: links.filter(({ link }) => link.listId === ARCHIVE_ID).length,
  };
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
  const backup = sources.some((source) => source.backupManifest !== undefined);
  if (
    sources.reduce((sum, source) => sum + new TextEncoder().encode(source.text).length, 0) >
    BOOKMARK_CONVERTER_MAX_BYTES
  ) {
    throw new Error(
      backup
        ? BOOKMARK_CONVERTER_BACKUP_TOO_LARGE
        : `This file is too large. Choose an export up to ${BOOKMARK_CONVERTER_MAX_MB} MB when expanded.`,
    );
  }
  const links: ImportedLink[] = [];
  const paths = new Map<string, string[]>();
  const sourceLabels = new Set<string>();
  const losses = new Set<string>();
  const warnings = new Set<string>();
  const excludedRows: BookmarkConversionReceipt['excludedRows'] = [];
  let sourceRowCount = 0;
  let trashCount = 0;
  const addFolder = (path: string[]) => {
    if (path.length > IMPORT_MAX_FOLDER_DEPTH) throw new ImportFolderDepthError();
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
            backup
              ? BOOKMARK_CONVERTER_BACKUP_TOO_LARGE
              : 'This file has too many rows for this tool. Split the export and try again.',
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
      // Strict where the app is tolerant: matching counts over a dropped bookmark
      // would read as a clean conversion.
      damage(reason) {
        throw new Error(reason);
      },
    };
    const format = detectTextImportFormat(text, source.name);
    let parsed: ImportedLink[];
    if (source.backupManifest !== undefined) {
      try {
        parseBackupManifest(source.backupManifest);
      } catch (cause) {
        if (cause instanceof BackupVersionError)
          throw new Error(
            'This backup is from a newer version of Bracemark than this converter reads yet. Export HTML or CSV in the app from Settings → Data instead.',
          );
        throw cause;
      }
      sourceLabels.add('Bracemark backup');
      const read = readBackup(text, observer);
      // Every list reaches the observer, empty ones included. foldersWithPaths
      // copies a path per folder; readBackup has already held the tree to the
      // depth rule, and the output bundle is held to it by addFolder.
      for (const { path } of foldersWithPaths(read.bundle.folders)) observer.folder(path);
      parsed = flatten(read.bundle);
      trashCount += read.trashCount;
      losses.add('Bracemark settings, pins, and images aren’t included.');
      if (read.archiveCount)
        warnings.add(
          'Archived links are included in an ordinary folder named after your Archive list. Importing them elsewhere may make them active bookmarks.',
        );
    } else if (format === 'csv') {
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
          losses.add(`${populated} values in the CSV column “${name}” aren’t included.`);
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
      if (unreadDates > 0) losses.add(`${unreadDates} unrecognized saved dates aren’t included.`);
      if (header.includes('status'))
        warnings.add(
          'Archive status becomes an ordinary Archive folder. Other status values aren’t carried.',
        );
    } else if (format === 'netscape') {
      if (!/<dl\b/i.test(text) || !/<dt\b/i.test(text))
        throw new Error(
          'This HTML isn’t a browser bookmarks export. Export bookmarks from your browser or bookmark manager.',
        );
      if ((text.match(/<dl\b/gi)?.length ?? 0) !== (text.match(/<\/dl\s*>/gi)?.length ?? 0))
        throw new Error('This bookmarks HTML has incomplete folders. Export it again.');
      sourceLabels.add('Browser bookmarks HTML');
      parsed = parseNetscapeHtml(text, observer);
      warnings.add(
        'HTML descriptions are read as plain text. Formatting, folder descriptions, icons, and extra HTML attributes aren’t carried.',
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
      if (isRecord(json) && Array.isArray(json.collections)) {
        if (
          json.collections.some(
            (collection) => !isRecord(collection) || !Array.isArray(collection.links),
          )
        )
          throw new Error('This LinkWarden export has an invalid collection. Export it again.');
        sourceLabels.add('LinkWarden JSON');
        parsed = parseLinkwardenExport(text, observer);
        losses.add(
          'LinkWarden account settings, IDs, folder descriptions, feeds, icons, and archived page references aren’t included.',
        );
        warnings.add(
          'LinkWarden folder order follows the export’s collection order. Pinned records are references to existing links, not extra bookmarks.',
        );
      } else if (
        Array.isArray(json) &&
        json.length > 0 &&
        json.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.path === 'string' &&
            /^(links\/|sslts\/|pins\/|tags\/|images\/|settings)|\/images\//.test(entry.path),
        )
      ) {
        sourceLabels.add('Brace.to export');
        parsed = parseBraceExport(text, observer).links;
        losses.add(
          'Brace.to settings, images, extraction metadata, and tag colors aren’t included. Only the newest revision of each link is converted.',
        );
      } else
        throw new Error(
          'This JSON layout isn’t supported. Choose a LinkWarden or Brace.to export.',
        );
    } else {
      // A URL list is explicit: arbitrary prose, JSON, and HTML never fall
      // through to the app importer’s deliberately permissive URL scanner.
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      if (!lines.length || !lines.some((line) => /^(https?:\/\/|www\.)\S+$/i.test(line.trim())))
        throw new Error(
          'This file format isn’t recognized. Choose bookmarks HTML, CSV, LinkWarden JSON, a Brace.to export, or one URL per line.',
        );
      if (
        lines.some(
          (line) => /[<>{}[\]]/.test(line) && !/^(https?:\/\/|www\.)\S+$/i.test(line.trim()),
        )
      )
        throw new Error('This isn’t a URL list. Use one web address per line.');
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
          losses.add('Dates outside the supported calendar range aren’t included.');
        }
      }
      // Trash is left out, as the app's own export does: importing links that
      // are pending deletion into another app as live bookmarks is never wanted.
      if (link.systemList === 'trash') {
        trashCount++;
        continue;
      }
      if (link.systemList === 'archive') {
        warnings.add(
          'Archived links are included in an ordinary Archive folder. Importing them elsewhere may make them active bookmarks.',
        );
        link.folderPath = ['Archive'];
      }
      addFolder(link.folderPath);
      links.push(link);
    }
  }
  if (links.length + trashCount !== sourceRowCount - excludedRows.length)
    throw new Error('Could not account for every bookmark record. Export the file again.');
  if (!links.length)
    throw new Error(
      trashCount
        ? 'Every link in this file is in Trash, and Trash isn’t converted. Choose another export.'
        : 'This file has no web addresses to convert. Choose another export.',
    );
  const occupied = new Set<string>();
  for (const link of links)
    for (let length = 1; length <= link.folderPath.length; length++)
      occupied.add(JSON.stringify(link.folderPath.slice(0, length)));
  const emptyFolderCount = [...paths.keys()].filter((key) => !occupied.has(key)).length;
  const bundle = bundleFromImported(links, [...paths.values()]);
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
    losses.add(`${emptyFolderCount} empty folders aren’t included.`);
  const pins = links.filter((link) => link.pinRank !== undefined).length;
  if (pins) losses.add(`${pins} pin positions aren’t included.`);
  if (trashCount)
    losses.add(
      trashCount === 1
        ? '1 link in Trash isn’t included.'
        : `${trashCount} links in Trash aren’t included.`,
    );
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
      trashCount,
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
    `Links in Trash (not included): ${r.trashCount}`,
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
    'The original file wasn’t changed. Nothing was imported into Bracemark.',
  ].join('\n');
}
