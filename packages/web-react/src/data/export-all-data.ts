'use client';

// Export-all-data orchestrator — the Settings → Data → Export action behind
// useExportAllData (hooks/use-export-all-data.ts). Reads the LOCAL store (so
// unsynced edits on this device are included), applies the export policy, and
// produces one downloadable file per format:
//
//   bracemark     — the complete, re-importable backup: a zip of manifest.json +
//               items.jsonl (raw {path, data} entities — links, lists, tags,
//               pins, extractions, settings) + files/{id} (raw decrypted blob
//               bytes). The only format that round-trips; includes Trash.
//   netscape  — Netscape bookmarks HTML (browsers, LinkWarden, Karakeep).
//   csv       — Raindrop.io import CSV.
//   text      — plain URL-per-line text.
//
// The three interop serializers are pure functions in @stxapps/shared
// (export/); this module owns everything platform-bound: Dexie reads, the
// pre-export sync refresh, the batched `files/` download (sync engine's
// loadEntityContents), zip assembly (@zip.js/zip.js, imported lazily — it's
// settings-flow-only code), and the save itself.
//
// POLICY (decided here, once, for every format):
//   - Locked lists are EXCLUDED. The caller passes `excludedListIds` — the lock
//     provider's coverage set (descendants included), so a flat `listId ∈ set`
//     check suffices. Excluded links drop with their pins/extractions/files,
//     and the excluded LIST entities drop too (a locked list's name — hidden
//     ones especially — is as sensitive as its contents).
//   - Trash is excluded from the interop formats (importing deleted-pending
//     links into a browser as live bookmarks is never wanted) but kept in the
//     bracemark backup (a backup that silently drops data isn't one).
//   - A dangling listId (list deleted on another device) files under My List in
//     the interop folder tree — same reconciliation spirit as the read layer.

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
} from '@stxapps/shared';

import { loadEntityContents, runIncrementalSync, type SyncDeps } from '../sync/engine';
import { db } from './db';
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
}

// The user dismissed the save dialog — not a failure; the caller returns to idle.
export class ExportCancelledError extends Error {
  constructor() {
    super('export cancelled');
    this.name = 'ExportCancelledError';
  }
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
// pairs, dropping unparseable blobs like the read layer does. Unlike queries'
// readNamespace this keeps the entity and its path SEPARATE (no WithPath merge):
// the bracemark backup writes the plaintext exactly as stored, and `path` is storage
// infrastructure that must not leak into the round-tripped `data`.
async function readRawNamespace<T extends z.ZodTypeAny>(
  prefix: string,
  schema: T,
): Promise<{ path: string; entity: z.infer<T> }[]> {
  const records = await db.items.where('path').startsWith(prefix).toArray();
  const out: { path: string; entity: z.infer<T> }[] = [];
  for (const record of records) {
    const entity = parseBlob(record.data, schema);
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
  const records = await db.items.where('path').startsWith(LINKS_PREFIX).toArray();
  const total = records.length;
  onProgress(0, total);

  const included: { path: string; link: Link }[] = [];
  for (let i = 0; i < records.length; i += GATHER_CHUNK) {
    for (const record of records.slice(i, i + GATHER_CHUNK)) {
      const link = parseBlob(record.data, linkSchema);
      if (link === undefined || excludedListIds.has(link.listId)) continue;
      included.push({ path: record.path, link });
    }
    onProgress(Math.min(i + GATHER_CHUNK, total), total);
  }
  included.sort((a, b) => b.link.createdAt - a.link.createdAt);

  // Join the co-keyed extractions (the writer-split shadow of each link).
  const exRecords = await db.items.bulkGet(
    included.map(({ path }) => rekey(path, LINKS_PREFIX, EXTRACTIONS_PREFIX)),
  );
  return included.map(({ path, link }, i) => ({
    path,
    link,
    extraction: parseBlob(exRecords[i]?.data, extractionSchema),
  }));
}

// --- the interop bundle ---------------------------------------------------------

// Project the gathered snapshot into the serializers' ExportBundle: the list
// tree minus locked subtrees and Trash, each folder's links display-resolved
// (title override-wins, tag ids → names) in the gathered (newest-first) order.
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

// Where the bracemark zip's bytes go. The stream target (File System Access API) is
// picked BEFORE the long-running phases — showSaveFilePicker needs the click's
// transient user activation — and lets zip.js write straight to disk, so a
// backup bigger than memory never materializes as one Blob. The blob target is
// the Safari/Firefox fallback (fine for the common sub-GB library).
type BracemarkSaveTarget =
  { kind: 'stream'; writable: FileSystemWritableFileStream } | { kind: 'blob' };

// window.showSaveFilePicker is Chromium-only and not yet in lib.dom — typed
// locally instead of a global augmentation so nothing else picks it up untyped.
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

async function pickBracemarkSaveTarget(filename: string): Promise<BracemarkSaveTarget> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) return { kind: 'blob' };
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
    });
    return { kind: 'stream', writable: await handle.createWritable() };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new ExportCancelledError();
    throw err;
  }
}

// Assemble the backup zip and finish the save. zip.js is imported lazily (this
// is the only code path that needs it); its close() finalizes AND closes an
// underlying WritableStream (preventClose defaults false), and zip64 turns on
// automatically past the zip32 limits, so Plus/Pro-sized backups (5–20 GiB,
// >65k entries) stay valid.
async function assembleBracemarkZip(
  target: BracemarkSaveTarget,
  filename: string,
  links: GatheredLink[],
  lists: { path: string; entity: List }[],
  tags: { path: string; entity: Tag }[],
  pins: { path: string; entity: Pin }[],
  filePaths: string[],
): Promise<{ fileCount: number }> {
  const { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } = await import('@zip.js/zip.js');

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

  const zipWriter = new ZipWriter<Blob>(
    target.kind === 'blob' ? new BlobWriter('application/zip') : target.writable,
  );

  // Files stream one at a time from Dexie — a blob downloaded in the files
  // phase (or already local) has bytes; one that landed in missingPaths doesn't
  // and is skipped here (already counted for the outcome).
  let fileCount = 0;
  const includedFileIds: string[] = [];
  for (const path of filePaths) {
    const record = await db.items.get(path);
    if (record?.data === undefined) continue;
    includedFileIds.push(idFromPath(path, FILES_PREFIX));
    fileCount += 1;
  }

  const manifest = serializeBackupManifest({
    links: links.length,
    lists: lists.length,
    tags: tags.length,
    pins: pins.length,
    extractions: links.filter((l) => l.extraction !== undefined).length,
    files: fileCount,
  });
  await zipWriter.add(BACKUP_MANIFEST_ENTRY, new TextReader(manifest));
  await zipWriter.add(BACKUP_ITEMS_ENTRY, new TextReader(serializeBackupItems(lines)));
  for (const id of includedFileIds) {
    const record = await db.items.get(pathFromId(id, FILES_PREFIX));
    if (record?.data === undefined) continue; // raced away since the count pass
    // Stored, not deflated: these are already-compressed media formats.
    await zipWriter.add(backupFileEntry(id), new Uint8ArrayReader(record.data), { level: 0 });
  }

  const zipped = await zipWriter.close();
  if (target.kind === 'blob') downloadBlob(zipped, filename);
  return { fileCount };
}

// --- save helpers ---------------------------------------------------------------

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred revoke: an immediate one can cancel a still-starting download in
  // some browsers; by then the browser holds its own reference.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

  // Bracemark: claim the save destination first — showSaveFilePicker must run while
  // the click's user activation is still alive, i.e. before sync/gather awaits.
  const target: BracemarkSaveTarget | undefined =
    format === 'bracemark' ? await pickBracemarkSaveTarget(filename) : undefined;

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
    const tags = await readRawNamespace(TAGS_PREFIX, tagSchema);
    const interopLinks = links.filter(({ link }) => link.listId !== TRASH_ID);
    const bundle = buildInteropBundle(
      interopLinks,
      mergedLists,
      tags.map(({ entity }) => entity),
    );
    const [content, mime] =
      format === 'netscape'
        ? [toNetscapeHtml(bundle), 'text/html']
        : format === 'csv'
          ? [toRaindropCsv(bundle), 'text/csv']
          : [toUrlText(bundle), 'text/plain'];
    downloadBlob(new Blob([content], { type: `${mime};charset=utf-8` }), filename);
    return {
      linkCount: interopLinks.length,
      fileCount: 0,
      missingFileCount: 0,
      syncFailed,
    };
  }

  // Bracemark backup. Raw stored entities only (no synthesized system-list
  // defaults — import's merge-on-read reconstructs those, exactly like sync).
  const includedLinkIds = new Set(links.map(({ path }) => idFromPath(path, LINKS_PREFIX)));
  const lists = (await readRawNamespace(LISTS_PREFIX, listSchema)).filter(
    ({ entity }) => !excludedListIds.has(entity.id),
  );
  const tags = await readRawNamespace(TAGS_PREFIX, tagSchema);
  const pins = (await readRawNamespace(PINS_PREFIX, pinSchema)).filter(({ path }) =>
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
  if (target === undefined) throw new Error('unreachable: bracemark export without a save target');
  const { fileCount } = await assembleBracemarkZip(
    target,
    filename,
    links,
    lists,
    tags,
    pins,
    filePaths,
  );

  return {
    linkCount: links.length,
    fileCount,
    missingFileCount: filePaths.length - fileCount,
    syncFailed,
  };
}
