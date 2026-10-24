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
//
// RESILIENCE: one bad record or one unreachable blob costs that record or blob,
// never the file. A record that doesn't decode is left out and counted
// (`unreadableCount`), a blob that can't be downloaded is left out and counted
// (`missingFileCount` / `failedFileCount`), and a list nested past the export
// depth is written at it (`flattenedListCount`) — all reported on the receipt
// and, for the backup, in the manifest's `omitted`. What it does NOT go on past
// is losing the account: a `session_revoked` verdict ends the run, and the save
// itself is fenced on the account (saveDownload), since a revoked device is
// being told to forget and the run is about to write the library out.

import type { z } from 'zod';

import type {
  ExportFormat,
  ExportOutcome,
  ExportProgress,
  Extraction,
  Link,
  List,
  Pin,
  ProgressFn,
  Tag,
} from '@stxapps/shared';
import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  bundleFromLibrary,
  EXPORT_MIME,
  exportFileName,
  EXTRACTIONS_PREFIX,
  extractionSchema,
  FILES_PREFIX,
  foldersPastMaxDepth,
  idFromPath,
  jsonlLine,
  LINKS_PREFIX,
  linkSchema,
  LISTS_PREFIX,
  listSchema,
  pastMaxDepthCounts,
  pathFromId,
  PINS_PREFIX,
  pinSchema,
  rekey,
  serializeBackupItems,
  serializeBackupManifest,
  sessionVerdictOf,
  SETTINGS_GENERAL_PATH,
  type SettingsGeneral,
  settingsGeneralSchema,
  TAGS_PREFIX,
  tagSchema,
  toNetscapeHtml,
  toRaindropCsv,
  toUrlText,
  TRASH_ID,
} from '@stxapps/shared';

import { yieldToMain } from '../lib/yield-to-main';
import { loadEntityContents, runIncrementalSync, type SyncDeps } from '../sync/engine';
import { db } from './db';
import { parseBlob } from './projection';
import { readLists, readTags } from './queries';
import { AccountFencedError, assertAccountStillOwnsStore } from './sync-store';

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

// Records decoded between two yields. `parseBlob` is a utf-8 decode plus a
// schema check per record, ~18 ms per 500 at a 4x CPU slowdown; the gather used
// to run every link and then every extraction in one task each, which held the
// page for 1.5–1.8 s at 50,000 links (docs/data-lifecycle.md, _main-thread
// cost_).
export const GATHER_CHUNK = 500;

// The records a run read and couldn't decode, counted at each read so the
// receipt can say how many it left out (ExportOutcome.unreadableCount).
interface Tally {
  unreadable: number;
}

// Decode every record under an id-keyed namespace prefix into (path, entity)
// pairs, dropping unparseable blobs like the read layer does — and counting
// them, which the read layer doesn't. `include` filters by path BEFORE the
// decode, so a record the policy excludes (a locked list's, a locked link's
// pin) is neither shipped nor counted. Unlike queries' readNamespace this keeps
// the entity and its path SEPARATE (no WithPath merge): the bracemark backup
// writes the plaintext exactly as stored, and `path` is storage infrastructure
// that must not leak into the round-tripped `data`.
async function readRawNamespace<T extends z.ZodTypeAny>(
  prefix: string,
  schema: T,
  tally: Tally,
  include: (path: string) => boolean = () => true,
): Promise<{ path: string; entity: z.infer<T> }[]> {
  const records = await db.items.where('path').startsWith(prefix).toArray();
  const out: { path: string; entity: z.infer<T> }[] = [];
  for (const record of records) {
    if (!include(record.path)) continue;
    const entity = parseBlob(record.data, schema);
    if (entity === undefined) tally.unreadable += 1;
    else out.push({ path: record.path, entity });
  }
  return out;
}

// Decode the whole `links/` namespace (newest first), join each survivor's
// extraction, and drop locked-list links. O(library) by nature — the export IS
// a full read — so both passes go a GATHER_CHUNK at a time, yielding between
// chunks so the page can paint the progress they report. The links are READ a
// chunk at a time too, as keyed pages on the primary key, not only decoded: one
// `toArray()` of the namespace lands the structured clone of every record in a
// single task, the longest left in each 50,000-link export
// (docs/data-lifecycle.md, _main-thread cost_). A page read after a yield can
// see a write the previous one didn't, which the extraction pass below always
// could; a link is keyed by its path, so it is read once either way.
async function gatherLinks(
  excludedListIds: ReadonlySet<string>,
  tally: Tally,
  onProgress: ProgressFn,
): Promise<GatheredLink[]> {
  const namespace = () => db.items.where('path').startsWith(LINKS_PREFIX);
  const total = await namespace().count();
  onProgress(0, total);

  const included: { path: string; link: Link }[] = [];
  let read = 0;
  for (let after = ''; ;) {
    if (after !== '') await yieldToMain();
    // `startsWith`'s own upper bound, from just past the last page's key.
    const records = await (
      after === ''
        ? namespace()
        : db.items.where('path').between(after, `${LINKS_PREFIX}\uffff`, false, false)
    )
      .limit(GATHER_CHUNK)
      .toArray();
    for (const record of records) {
      const link = parseBlob(record.data, linkSchema);
      // Counted whatever list it was in: an unreadable link names none.
      if (link === undefined) tally.unreadable += 1;
      else if (!excludedListIds.has(link.listId)) included.push({ path: record.path, link });
    }
    read += records.length;
    // The count was taken before the pages, and a sync can add links meanwhile.
    onProgress(read, Math.max(read, total));
    if (records.length < GATHER_CHUNK) break;
    after = records[records.length - 1].path;
  }
  included.sort((a, b) => b.link.createdAt - a.link.createdAt);

  // Join the co-keyed extractions (the writer-split shadow of each link), read
  // and decoded a chunk at a time for the same reason.
  const gathered: GatheredLink[] = [];
  for (let i = 0; i < included.length; i += GATHER_CHUNK) {
    if (i > 0) await yieldToMain();
    const chunk = included.slice(i, i + GATHER_CHUNK);
    const exRecords = await db.items.bulkGet(
      chunk.map(({ path }) => rekey(path, LINKS_PREFIX, EXTRACTIONS_PREFIX)),
    );
    chunk.forEach(({ path, link }, j) => {
      const extraction = parseBlob(exRecords[j]?.data, extractionSchema);
      // The link still goes, with no extraction — it shows the same way in the app.
      if (exRecords[j] !== undefined && extraction === undefined) tally.unreadable += 1;
      gathered.push({ path, link, extraction });
    });
  }
  return gathered;
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
// >65k entries) stay valid. The native build, not the default WASM one: the
// `level: 0` entries below would load the WASM codec for nothing
// (docs/data-lifecycle.md, _which zip.js build_).
async function assembleBracemarkZip(
  username: string,
  target: BracemarkSaveTarget,
  filename: string,
  links: GatheredLink[],
  lists: { path: string; entity: List }[],
  tags: { path: string; entity: Tag }[],
  pins: { path: string; entity: Pin }[],
  settings: SettingsGeneral | undefined,
  filePaths: string[],
  failedPaths: readonly string[],
  unreadable: number,
): Promise<{ fileCount: number; failedFileCount: number }> {
  const { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } =
    await import('@zip.js/zip.js/index-native.js');

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
  if (settings !== undefined) lines.push(jsonlLine(SETTINGS_GENERAL_PATH, settings));

  const zipWriter = new ZipWriter<Blob>(
    target.kind === 'blob' ? new BlobWriter(EXPORT_MIME.bracemark) : target.writable,
  );

  // Files stream one at a time from Dexie — a blob downloaded in the files
  // phase (or already local) has bytes; one that landed in missingPaths or
  // failedPaths doesn't and is skipped here. A failed path the content provider
  // happened to fetch meanwhile has bytes again, and ships, so it is not failed.
  let fileCount = 0;
  const includedFileIds: string[] = [];
  const failed = new Set(failedPaths);
  let failedFileCount = 0;
  for (const path of filePaths) {
    const record = await db.items.get(path);
    if (record?.data === undefined) {
      if (failed.has(path)) failedFileCount += 1;
      continue;
    }
    includedFileIds.push(idFromPath(path, FILES_PREFIX));
    fileCount += 1;
  }

  const manifest = serializeBackupManifest(
    {
      links: links.length,
      lists: lists.length,
      tags: tags.length,
      pins: pins.length,
      extractions: links.filter((l) => l.extraction !== undefined).length,
      files: fileCount,
    },
    { files: filePaths.length - fileCount, unreadable },
  );
  await zipWriter.add(BACKUP_MANIFEST_ENTRY, new TextReader(manifest));
  await zipWriter.add(BACKUP_ITEMS_ENTRY, new TextReader(serializeBackupItems(lines)));
  for (const id of includedFileIds) {
    const record = await db.items.get(pathFromId(id, FILES_PREFIX));
    if (record?.data === undefined) continue; // raced away since the count pass
    // Stored, not deflated: these are already-compressed media formats.
    await zipWriter.add(backupFileEntry(id), new Uint8ArrayReader(record.data), { level: 0 });
  }

  // The stream target already holds the archive in the browser's swap file, and
  // close() is what commits it under the picked name — so it is fenced before
  // the close, and a fenced run aborts the swap file instead (exportAllData).
  // The close itself is the one await left unfenced.
  if (target.kind === 'stream') await assertAccountStillOwnsStore(username);
  const zipped = await zipWriter.close();
  if (target.kind === 'blob') await saveDownload(username, zipped, filename);
  return { fileCount, failedFileCount };
}

// --- save helpers ---------------------------------------------------------------

// The run's save, fenced on the account like a store write (sync-store.ts,
// AccountFencedError). A run takes minutes and holds the library in memory once
// gathered, so a sign-out or a revocation wipe midway would otherwise end with
// the forgotten account's library in Downloads, where no wipe reaches. The check
// and the click are in one task, so no wipe lands between them.
async function saveDownload(username: string, blob: Blob, filename: string): Promise<void> {
  await assertAccountStillOwnsStore(username);
  downloadBlob(blob, filename);
}

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

// --- the flow -------------------------------------------------------------------

interface ExportAllDataOptions {
  format: ExportFormat;
  deps: SyncDeps;
  // The lock provider's coverage set (useLocks().lockedListIds) — descendants
  // included, so membership alone excludes a link/list.
  excludedListIds: ReadonlySet<string>;
  onProgress?: (progress: ExportProgress) => void;
}

export async function exportAllData(options: ExportAllDataOptions): Promise<ExportOutcome> {
  const filename = exportFileName(options.format);

  // Bracemark: claim the save destination first — showSaveFilePicker must run while
  // the click's user activation is still alive, i.e. before sync/gather awaits.
  const target: BracemarkSaveTarget | undefined =
    options.format === 'bracemark' ? await pickBracemarkSaveTarget(filename) : undefined;

  try {
    return await runExport(options, filename, target);
  } catch (err) {
    // A failed run discards what it streamed rather than leaving the writable
    // open on a half-written swap file until the tab goes. Best-effort: a stream
    // zip.js has already errored, or one a still-running pipe holds locked,
    // refuses the abort, and the run's own error is the one worth reporting.
    if (target?.kind === 'stream') await target.writable.abort().catch(() => undefined);
    throw err;
  }
}

async function runExport(
  options: ExportAllDataOptions,
  filename: string,
  target: BracemarkSaveTarget | undefined,
): Promise<ExportOutcome> {
  const { format, deps, excludedListIds } = options;
  const onProgress = options.onProgress ?? (() => undefined);

  // Refresh so "all data" means the account, not just this device. Best-effort:
  // a failed cycle downgrades to a warning and we export the local copy — unless
  // it failed because the account is going. A `session_revoked` verdict has
  // already started the auth provider's wipe (auth-provider.tsx, onVerdict), and
  // a fenced write means it has landed; going on would race the gather against
  // that wipe and write out whatever it read. loadEntityContents draws the same
  // line for the files phase, which the interop formats never reach.
  onProgress({ step: 'sync' });
  let syncFailed = false;
  try {
    await runIncrementalSync(deps);
  } catch (err) {
    if (sessionVerdictOf(err) === 'revoked' || err instanceof AccountFencedError) throw err;
    syncFailed = true;
  }

  onProgress({ step: 'gather' });
  const tally: Tally = { unreadable: 0 };
  const links = await gatherLinks(excludedListIds, tally, (done, total) =>
    onProgress({ step: 'gather', done, total }),
  );
  // A list is locked by its path's id — the id the coverage set was computed
  // over (see the backup's lists below).
  const unlockedList = (path: string): boolean =>
    !excludedListIds.has(idFromPath(path, LISTS_PREFIX));

  if (format !== 'bracemark') {
    onProgress({ step: 'assemble' });
    // readLists merges the system-list defaults, so My List/Archive always
    // exist as folders even when never overridden.
    const mergedLists = (await readLists()).filter((list) => !excludedListIds.has(list.id));
    // readTags, not the raw namespace: a link's `tagIds` name a tag by its path's
    // id, which is the id the read edge hands back (queries.ts readTags).
    const tags = await readTags();
    // readLists and readTags leave out what they can't decode without a word;
    // this pass only counts those. Both namespaces are small.
    await readRawNamespace(LISTS_PREFIX, listSchema, tally, unlockedList);
    await readRawNamespace(TAGS_PREFIX, tagSchema, tally);
    const interopLinks = links.filter(({ link }) => link.listId !== TRASH_ID);
    const bundle = bundleFromLibrary(interopLinks, mergedLists, tags);
    const content =
      format === 'netscape'
        ? toNetscapeHtml(bundle)
        : format === 'csv'
          ? toRaindropCsv(bundle)
          : toUrlText(bundle);
    await saveDownload(
      deps.username,
      new Blob([content], { type: `${EXPORT_MIME[format]};charset=utf-8` }),
      filename,
    );
    return {
      linkCount: interopLinks.length,
      fileCount: 0,
      missingFileCount: 0,
      failedFileCount: 0,
      unreadableCount: tally.unreadable,
      flattenedListCount: format === 'text' ? 0 : foldersPastMaxDepth(bundle.folders),
      pastMaxDepthListCount: 0,
      pastMaxDepthTagCount: 0,
      syncFailed,
    };
  }

  // Bracemark backup. Raw stored entities only (no synthesized system-list
  // defaults — import's merge-on-read reconstructs those, exactly like sync).
  const includedLinkIds = new Set(links.map(({ path }) => idFromPath(path, LINKS_PREFIX)));
  // Excluded by the PATH's id, like the pins below: the lock coverage is computed
  // over the read edge's lists, which go by it (queries.ts readLists), and the
  // raw plaintext `id` here is the copy that edge does not trust. Filtering on
  // the copy would ship a locked list whose two ids disagree.
  const lists = await readRawNamespace(LISTS_PREFIX, listSchema, tally, unlockedList);
  const tags = await readRawNamespace(TAGS_PREFIX, tagSchema, tally);
  const pins = await readRawNamespace(PINS_PREFIX, pinSchema, tally, (path) =>
    includedLinkIds.has(idFromPath(path, PINS_PREFIX)),
  );
  // Read raw rather than through readSettingsGeneral, which can't tell an absent
  // record from one that doesn't decode — and only the second is left out.
  const settingsRecord = await db.items.get(SETTINGS_GENERAL_PATH);
  const settings = parseBlob(settingsRecord?.data, settingsGeneralSchema);
  if (settingsRecord !== undefined && settings === undefined) tally.unreadable += 1;

  const filePaths = referencedFilePaths(links);
  onProgress({ step: 'files', done: 0, total: filePaths.length });
  // Best-effort: offline, or with the file server failing, the blobs not yet on
  // this device are left out and counted rather than failing the backup — the
  // pre-export sync's failure is a warning for the same reason. What isn't
  // included is `filePaths - fileCount`, which also covers a blob raced away
  // mid-assembly; the failed share of it is counted apart, since exporting
  // again may bring those in.
  const { failedPaths } = await loadEntityContents(
    deps,
    filePaths,
    (done, total) => onProgress({ step: 'files', done, total }),
    { bestEffort: true },
  );

  onProgress({ step: 'assemble' });
  if (target === undefined) throw new Error('unreachable: bracemark export without a save target');
  const { fileCount, failedFileCount } = await assembleBracemarkZip(
    deps.username,
    target,
    filename,
    links,
    lists,
    tags,
    pins,
    settings,
    filePaths,
    failedPaths,
    tally.unreadable,
  );

  return {
    linkCount: links.length,
    fileCount,
    missingFileCount: filePaths.length - fileCount - failedFileCount,
    failedFileCount,
    unreadableCount: tally.unreadable,
    flattenedListCount: 0,
    ...pastMaxDepthCounts(lists, tags),
    syncFailed,
  };
}
