// Export-all-data orchestrator — the expo sibling of web-react's
// data/export-all-data.ts (the canonical doc: the four formats, the gather
// pass, and the POLICY — locked lists excluded with their entities, Trash
// excluded from the interop formats but kept in the bracemark backup, dangling
// listIds filed under My List). The interop serializers stay the pure functions
// in @stxapps/shared (export/); this module owns everything platform-bound,
// and diverges from web only there:
//
//  - Reads are drizzle range scans over `items` (the queries.ts prefix idiom)
//    instead of Dexie; `files/` blob bytes come off DISK (file-store — on this
//    platform content lives decrypted on disk, not in the row), materialized
//    for the backup by the engine's loadEntityContents.
//  - Zip assembly is fflate's zipSync (pure JS, no Web Streams — zip.js needs
//    a ReadableStream Hermes doesn't have). In-memory by construction, and
//    fflate writes classic zip32 ONLY, so this path carries two hard ceilings
//    web's zip.js doesn't have — 65,535 entries and 4 GiB. Neither is checked
//    by fflate, so both are enforced in assertZipWritable below rather than
//    left to corrupt the output. See docs/data-lifecycle.md (_the bracemark zip is
//    platform-split_) for why, and the native-zipper upgrade path.
//  - There is no save dialog and no ExportCancelledError: the output is
//    written to a cache file and returned in the outcome (`file`), and the UI
//    presents the platform share sheet from it — the save happens AFTER the
//    work, not before, so there's nothing to cancel mid-run.

import { File, Paths } from 'expo-file-system';
import type { z } from 'zod';

import type {
  ExportBundle,
  ExportFolder,
  ExportLinkRow,
  Extraction,
  Link,
  List,
  ListItem,
  Pin,
  Tag,
  TreeNode,
} from '@stxapps/shared';
import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  buildTree,
  EXTRACTIONS_PREFIX,
  extractionSchema,
  FILES_PREFIX,
  hostFromText,
  idFromPath,
  jsonlLine,
  LINKS_PREFIX,
  linkSchema,
  LIST_NO_CHILDREN_IDS,
  LISTS_PREFIX,
  listSchema,
  MY_LIST_ID,
  pathFromId,
  PINS_PREFIX,
  pinSchema,
  rekey,
  serializeBackupItems,
  serializeBackupManifest,
  SETTINGS_GENERAL_PATH,
  TAGS_PREFIX,
  tagSchema,
  toNetscapeHtml,
  toRaindropCsv,
  toUrlText,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';

import { loadEntityContents, runIncrementalSync, type SyncDeps } from '../sync/engine';
import { dataFileFor } from './file-store';
import { bulkGetItems, getItem, namespaceRows } from './item-store';
import { parseBlob } from './projection';
import { readLists, readSettingsGeneral } from './queries';

export type ExportFormat = 'bracemark' | 'netscape' | 'csv' | 'text';

// The running phases, in order. `sync` and `assemble` are indeterminate;
// `gather` counts link records, `files` counts blob downloads (bracemark only).
export interface ExportProgress {
  step: 'sync' | 'gather' | 'files' | 'assemble';
  done?: number;
  total?: number;
}

// The written output, for the UI's share-sheet handoff. Lives in the CACHE dir
// (transient by definition — the share sheet copies it out; an OS purge later
// costs nothing).
export interface ExportedFile {
  uri: string;
  name: string;
  mimeType: string;
}

export interface ExportOutcome {
  // Links written to the file (after the lock/Trash policy).
  linkCount: number;
  // `files/` blobs included in the zip (bracemark only; 0 otherwise).
  fileCount: number;
  // Referenced blobs that couldn't be included — deleted server-side or never
  // known locally (dangling refs). Reported, never fatal.
  missingFileCount: number;
  // The pre-export refresh failed (offline / server down); the export carried
  // on with this device's local copy. A warning, not an error — local-first.
  syncFailed: boolean;
  // Where the output landed — the UI shares/saves it from here.
  file: ExportedFile;
}

// --- the zip32 ceilings ---------------------------------------------------------

// fflate emits a classic end-of-central-directory record and no zip64: the
// entry count is 16 bits, the sizes/offsets 32. NEITHER is range-checked on the
// write path — `zipSync` takes 70 000 entries, writes `70000 & 0xffff` = 4 464
// into the count field, and hands back an archive that reads back CLEAN with
// 65 536 files missing. Silent data loss, in the one format that's supposed to
// round-trip, so the ceilings are asserted here instead.
//
// These are reachable, not theoretical: the paid plans sell `maxFiles` 200 000
// and `maxBytes` up to 20 GiB (@stxapps/shared iap/plans.ts), both past the
// zip32 wall. Web's zip.js writes zip64 and has neither ceiling — which is why
// the message points there.
const ZIP32_MAX_ENTRIES = 65_535;
const ZIP32_MAX_BYTES = 0xffff_ffff;

// The library is too large for the zip this platform can write — thrown BEFORE
// zipSync, so nothing is saved. The message is user-facing (the export view
// renders it verbatim, like ImportQuotaError's).
export class ExportTooLargeError extends Error {
  readonly reason: 'entries' | 'bytes';
  constructor(reason: 'entries' | 'bytes', count: number) {
    super(
      reason === 'entries'
        ? `This backup would hold ${count.toLocaleString()} files, past the ` +
            `${ZIP32_MAX_ENTRIES.toLocaleString()}-entry limit of the zip format this app writes. ` +
            'Export the backup from the Bracemark web app instead.'
        : `This backup would be about ${Math.round(count / (1024 * 1024 * 1024))} GB, past the ` +
            '4 GB limit of the zip format this app writes. ' +
            'Export the backup from the Bracemark web app instead.',
    );
    this.name = 'ExportTooLargeError';
    this.reason = reason;
  }
}

// Refuse an archive zip32 can't represent. `archiveBytes` mirrors fflate's own
// running total (per entry: 76 + 2×name + payload, plus the 22-byte EOCD) —
// using each payload's UNCOMPRESSED length, so the estimate is an upper bound
// for the deflated entries and exact for the stored (`level: 0`) ones.
function assertZipWritable(entries: [string, Uint8Array][]): void {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new ExportTooLargeError('entries', entries.length);
  }
  let archiveBytes = 22;
  for (const [name, bytes] of entries) archiveBytes += 76 + 2 * name.length + bytes.length;
  if (archiveBytes > ZIP32_MAX_BYTES) throw new ExportTooLargeError('bytes', archiveBytes);
}

// --- gather -------------------------------------------------------------------

// One included link with its co-keyed extraction (if any), both decoded. `path`
// is the link's `links/{id}.enc` items path.
interface GatheredLink {
  path: string;
  link: Link;
  extraction: Extraction | undefined;
}

const GATHER_CHUNK = 500;

// Decode every record under an id-keyed namespace prefix into (path, entity)
// pairs, dropping unparseable blobs like the read layer does. Keeps the entity
// and its path SEPARATE (no WithPath merge): the bracemark backup writes the
// plaintext exactly as stored, and `path` is storage infrastructure that must
// not leak into the round-tripped `data`.
function readRawNamespace<T extends z.ZodTypeAny>(
  prefix: string,
  schema: T,
): { path: string; entity: z.infer<T> }[] {
  const out: { path: string; entity: z.infer<T> }[] = [];
  for (const record of namespaceRows(prefix)) {
    const entity = parseBlob(record.data ?? undefined, schema);
    if (entity !== undefined) out.push({ path: record.path, entity });
  }
  return out;
}

// Decode the whole `links/` namespace (newest first), join each survivor's
// extraction, and drop locked-list links. O(library) by nature — the export IS
// a full read — chunked only so progress ticks.
async function gatherLinks(
  excludedListIds: ReadonlySet<string>,
  onProgress: (done: number, total: number) => void,
): Promise<GatheredLink[]> {
  const records = namespaceRows(LINKS_PREFIX);
  const total = records.length;
  onProgress(0, total);

  const included: { path: string; link: Link }[] = [];
  for (let i = 0; i < records.length; i += GATHER_CHUNK) {
    for (const record of records.slice(i, i + GATHER_CHUNK)) {
      const link = parseBlob(record.data ?? undefined, linkSchema);
      if (link === undefined || excludedListIds.has(link.listId)) continue;
      included.push({ path: record.path, link });
    }
    onProgress(Math.min(i + GATHER_CHUNK, total), total);
  }
  included.sort((a, b) => b.link.createdAt - a.link.createdAt);

  // Join the co-keyed extractions (the writer-split shadow of each link).
  const exRecords = await bulkGetItems(
    included.map(({ path }) => rekey(path, LINKS_PREFIX, EXTRACTIONS_PREFIX)),
  );
  return included.map(({ path, link }, i) => ({
    path,
    link,
    extraction: parseBlob(exRecords[i]?.data ?? undefined, extractionSchema),
  }));
}

// --- the interop bundle ---------------------------------------------------------

// Project the gathered snapshot into the serializers' ExportBundle — web's
// buildInteropBundle, verbatim.
function buildInteropBundle(links: GatheredLink[], lists: ListItem[], tags: Tag[]): ExportBundle {
  const visibleLists = lists.filter((list) => list.id !== TRASH_ID);
  const tree = buildTree(visibleLists, { noChildrenIds: LIST_NO_CHILDREN_IDS });
  const listIds = new Set(visibleLists.map((list) => list.id));
  const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name]));

  const rowsByListId = new Map<string, ExportLinkRow[]>();
  for (const { link, extraction } of links) {
    if (link.listId === TRASH_ID) continue;
    // Dangling list ref → My List, unless My List itself is excluded (then the
    // link has no unlocked home and drops like its list's other links).
    const listId = listIds.has(link.listId) ? link.listId : MY_LIST_ID;
    if (!listIds.has(listId)) continue;

    const row: ExportLinkRow = {
      url: link.url,
      title: link.customTitle ?? extraction?.title ?? hostFromText(link.url),
      tagNames: link.tagIds
        .map((id) => tagNameById.get(id))
        .filter((name): name is string => name !== undefined),
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
    if (link.note !== undefined) row.note = link.note;

    const rows = rowsByListId.get(listId);
    if (rows) rows.push(row);
    else rowsByListId.set(listId, [row]);
  }

  const toFolder = (node: TreeNode<ListItem>): ExportFolder => ({
    name: node.item.name,
    links: rowsByListId.get(node.item.id) ?? [],
    children: node.children.map(toFolder),
  });
  return { folders: tree.map(toFolder), exportedAt: Date.now() };
}

// --- the bracemark backup -----------------------------------------------------------

// Every `files/{id}.enc` path the included links/extractions reference —
// referenced-only, so orphaned blobs and locked lists' media never ship.
function referencedFilePaths(links: GatheredLink[]): string[] {
  const ids = new Set<string>();
  for (const { link, extraction } of links) {
    if (link.customImageId !== undefined) ids.add(link.customImageId);
    if (extraction?.imageId !== undefined) ids.add(extraction.imageId);
    if (extraction?.pageCopyId !== undefined) ids.add(extraction.pageCopyId);
    if (extraction?.screenshotId !== undefined) ids.add(extraction.screenshotId);
  }
  return [...ids].map((id) => pathFromId(id, FILES_PREFIX));
}

// Assemble the backup zip in memory and write it to the cache file. A blob's
// bytes come off disk (dataFileFor — materialized by the files phase, or
// already local); a path that stayed unmaterialized is skipped here (already
// counted for the outcome). Stored, not deflated (`level: 0`), for the media
// entries — they're already-compressed formats. Throws ExportTooLargeError if
// the result wouldn't fit zip32 — before zipSync, so nothing lands on disk.
async function assembleBracemarkZip(
  outFile: File,
  links: GatheredLink[],
  lists: { path: string; entity: List }[],
  tags: { path: string; entity: Tag }[],
  pins: { path: string; entity: Pin }[],
  filePaths: string[],
): Promise<{ fileCount: number }> {
  const { zipSync } = await import('fflate');

  const lines: string[] = [];
  for (const { path, entity } of lists) lines.push(jsonlLine(path, entity));
  for (const { path, entity } of tags) lines.push(jsonlLine(path, entity));
  for (const { path, link, extraction } of links) {
    lines.push(jsonlLine(path, link));
    if (extraction !== undefined) {
      lines.push(jsonlLine(rekey(path, LINKS_PREFIX, EXTRACTIONS_PREFIX), extraction));
    }
  }
  for (const { path, entity } of pins) lines.push(jsonlLine(path, entity));
  const settings = await readSettingsGeneral();
  if (settings !== undefined) lines.push(jsonlLine(SETTINGS_GENERAL_PATH, settings));

  // Gather the includable blobs: a row that claims materialization AND whose
  // disk file is really there.
  const fileEntries: [string, Uint8Array][] = [];
  for (const path of filePaths) {
    const record = await getItem(path);
    const plain = dataFileFor(path);
    if (!record?.hasDataFile || !plain.exists) continue;
    fileEntries.push([backupFileEntry(idFromPath(path, FILES_PREFIX)), await plain.bytes()]);
  }

  const manifestBytes = utf8(
    serializeBackupManifest({
      links: links.length,
      lists: lists.length,
      tags: tags.length,
      pins: pins.length,
      extractions: links.filter((l) => l.extraction !== undefined).length,
      files: fileEntries.length,
    }),
  );
  const itemsBytes = utf8(serializeBackupItems(lines));

  // Every entry the archive will hold — checked before anything is deflated,
  // since fflate would silently truncate rather than fail (see the ceilings).
  assertZipWritable([
    [BACKUP_MANIFEST_ENTRY, manifestBytes],
    [BACKUP_ITEMS_ENTRY, itemsBytes],
    ...fileEntries,
  ]);

  const zipped = zipSync({
    [BACKUP_MANIFEST_ENTRY]: manifestBytes,
    [BACKUP_ITEMS_ENTRY]: itemsBytes,
    ...Object.fromEntries(
      fileEntries.map(([name, bytes]) => [name, [bytes, { level: 0 }] as const]),
    ),
  });

  writeCacheFile(outFile, zipped);
  return { fileCount: fileEntries.length };
}

// --- save helpers ---------------------------------------------------------------

function writeCacheFile(file: File, content: string | Uint8Array): void {
  file.create({ intermediates: true, overwrite: true });
  file.write(content);
}

// Local (not UTC) YYYY-MM-DD — the date the user sees on their clock.
function datePart(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function exportFileName(format: ExportFormat, date = new Date()): string {
  const stamp = datePart(date);
  switch (format) {
    case 'bracemark':
      return `Bracemark backup ${stamp}.zip`;
    case 'netscape':
      return `Bracemark bookmarks ${stamp}.html`;
    case 'csv':
      return `Bracemark bookmarks ${stamp}.csv`;
    case 'text':
      return `Bracemark links ${stamp}.txt`;
  }
}

const EXPORT_MIME: Record<ExportFormat, string> = {
  bracemark: 'application/zip',
  netscape: 'text/html',
  csv: 'text/csv',
  text: 'text/plain',
};

// --- the flow -------------------------------------------------------------------

export async function exportAllData(options: {
  format: ExportFormat;
  deps: SyncDeps;
  // The lock provider's coverage set (useLocks().lockedListIds) — descendants
  // included, so membership alone excludes a link/list.
  excludedListIds: ReadonlySet<string>;
  onProgress?: (progress: ExportProgress) => void;
}): Promise<ExportOutcome> {
  const { format, deps, excludedListIds } = options;
  const onProgress = options.onProgress ?? (() => undefined);
  const filename = exportFileName(format);
  const outFile = new File(Paths.cache, filename);
  const file: ExportedFile = { uri: outFile.uri, name: filename, mimeType: EXPORT_MIME[format] };

  // Refresh so "all data" means the account, not just this device. Best-effort:
  // a failed cycle downgrades to a warning and we export the local copy.
  onProgress({ step: 'sync' });
  let syncFailed = false;
  try {
    await runIncrementalSync(deps);
  } catch {
    syncFailed = true;
  }

  onProgress({ step: 'gather' });
  const links = await gatherLinks(excludedListIds, (done, total) =>
    onProgress({ step: 'gather', done, total }),
  );

  if (format !== 'bracemark') {
    onProgress({ step: 'assemble' });
    // readLists merges the system-list defaults, so My List/Archive always
    // exist as folders even when never overridden.
    const mergedLists = (await readLists()).filter((list) => !excludedListIds.has(list.id));
    const tags = readRawNamespace(TAGS_PREFIX, tagSchema);
    const interopLinks = links.filter(({ link }) => link.listId !== TRASH_ID);
    const bundle = buildInteropBundle(
      interopLinks,
      mergedLists,
      tags.map(({ entity }) => entity),
    );
    const content =
      format === 'netscape'
        ? toNetscapeHtml(bundle)
        : format === 'csv'
          ? toRaindropCsv(bundle)
          : toUrlText(bundle);
    writeCacheFile(outFile, content);
    return {
      linkCount: interopLinks.length,
      fileCount: 0,
      missingFileCount: 0,
      syncFailed,
      file,
    };
  }

  // Bracemark backup. Raw stored entities only (no synthesized system-list
  // defaults — import's merge-on-read reconstructs those, exactly like sync).
  const includedLinkIds = new Set(links.map(({ path }) => idFromPath(path, LINKS_PREFIX)));
  const lists = readRawNamespace(LISTS_PREFIX, listSchema).filter(
    ({ entity }) => !excludedListIds.has(entity.id),
  );
  const tags = readRawNamespace(TAGS_PREFIX, tagSchema);
  const pins = readRawNamespace(PINS_PREFIX, pinSchema).filter(({ path }) =>
    includedLinkIds.has(idFromPath(path, PINS_PREFIX)),
  );

  const filePaths = referencedFilePaths(links);
  onProgress({ step: 'files', done: 0, total: filePaths.length });
  // The unincludable paths (404 / never known locally) are counted below as
  // `filePaths - fileCount` — that also covers a blob raced away mid-assembly.
  await loadEntityContents(deps, filePaths, (done, total) =>
    onProgress({ step: 'files', done, total }),
  );

  onProgress({ step: 'assemble' });
  const { fileCount } = await assembleBracemarkZip(outFile, links, lists, tags, pins, filePaths);

  return {
    linkCount: links.length,
    fileCount,
    missingFileCount: filePaths.length - fileCount,
    syncFailed,
    file,
  };
}
