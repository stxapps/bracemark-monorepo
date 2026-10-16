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
//  - Zip assembly is fflate's synchronous streaming `Zip`, fed in pieces with
//    yields between them (pure JS, no Web Streams — zip.js needs a
//    ReadableStream Hermes doesn't have). In-memory by construction, and
//    fflate writes classic zip32 ONLY, so this path carries two hard ceilings
//    web's zip.js doesn't have — 65,535 entries and 4 GiB. Neither is checked
//    by fflate, so both are enforced in assertZipWritable below rather than
//    left to corrupt the output. See docs/data-lifecycle.md (_the bracemark zip is
//    platform-split_) for why, and the native-zipper upgrade path.
//  - There is no save dialog and no ExportCancelledError: the output is
//    written to a cache file and returned in the outcome (`file`), and the UI
//    presents the platform share sheet from it — the save happens AFTER the
//    work, not before, so there's nothing to cancel mid-run.
//  - Resilience is web's (its header): a record that doesn't decode, a blob that
//    can't be downloaded, and a list nested past the export depth each cost
//    themselves and are counted, and a `session_revoked` verdict ends the run.
//    One more case here: a materialized blob whose disk file can't be read is
//    left out like a missing one.
//  - That cache file is plaintext that outlives the run, so it has an owner:
//    cache-files.ts gives the run its location and removes it at sign-out. And
//    the write is fenced on the account like any store write — see
//    writeExportFile.

import type { File } from 'expo-file-system';
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
  flattenBackupTree,
  foldersPastMaxDepth,
  idFromPath,
  jsonlLine,
  LINKS_PREFIX,
  linkSchema,
  LISTS_PREFIX,
  listSchema,
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
  utf8,
} from '@stxapps/shared';

import { yieldToMain } from '../lib/yield-to-main';
import { loadEntityContents, runIncrementalSync, type SyncDeps } from '../sync/engine';
import { finishExportFile, newExportFile } from './cache-files';
import { getDb } from './db';
import { dataFileFor } from './file-store';
import { bulkGetItems, getItem, namespaceRows } from './item-store';
import { parseBlob } from './projection';
import { readLists, readTags } from './queries';
import { AccountFencedError, assertAccountOwnsStoreTx } from './sync-store';

// The written output, for the UI's share-sheet handoff. Lives in the CACHE dir
// (transient by definition — the share sheet copies it out; an OS purge later
// costs nothing).
export interface ExportedFile {
  uri: string;
  name: string;
  mimeType: string;
}

// The shared counters plus where the output landed — the UI shares/saves it
// from here.
export interface ExportFileOutcome extends ExportOutcome {
  file: ExportedFile;
}

// --- the zip32 ceilings ---------------------------------------------------------

// fflate emits a classic end-of-central-directory record and no zip64: the
// entry count is 16 bits, the sizes/offsets 32. NEITHER is range-checked on the
// write path — its `zipSync` (and the streaming `Zip` used below, which shares
// the EOCD writer) takes 70 000 entries, writes `70000 & 0xffff` = 4 464
// into the count field, and hands back an archive that reads back CLEAN with
// 65 536 files missing. Silent data loss, in the one format that's supposed to
// round-trip, so the ceilings are asserted here instead.
//
// These are reachable, not theoretical: the paid plans sell `maxFiles` 1 000 000
// and `maxBytes` up to 20 GiB (@stxapps/shared iap/plans.ts), both past the
// zip32 wall. Web's zip.js writes zip64 and has neither ceiling — which is why
// the message points there.
const ZIP32_MAX_ENTRIES = 65_535;
const ZIP32_MAX_BYTES = 0xffff_ffff;

// The library is too large for the zip this platform can write — thrown BEFORE
// anything is deflated, so nothing is saved. The message is user-facing (the export view
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
// running total for its streaming `Zip` (per entry: 76 + 2×name + payload, plus
// the 16-byte data descriptor a streamed entry carries; then the 22-byte EOCD) —
// using each payload's UNCOMPRESSED length, so the estimate is an upper bound
// for the deflated entries and exact for the stored (`level: 0`) ones.
//
// Exported for its spec only, and deliberately: both ceilings are reachable
// solely at a scale no test can build through the orchestrator — 65 536
// MATERIALIZED blobs, each referenced by a link, or 4 GiB of them. Driving the
// guard at its own edge is the same choice bracemark-extractor's suite makes for
// its byte caps, and the alternative is the ceiling having no cover at all.
export function assertZipWritable(entries: [string, Uint8Array][]): void {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new ExportTooLargeError('entries', entries.length);
  }
  let archiveBytes = 22;
  for (const [name, bytes] of entries) archiveBytes += 92 + 2 * name.length + bytes.length;
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

// The records a run read and couldn't decode (ExportOutcome.unreadableCount).
interface Tally {
  unreadable: number;
}

// Decode every record under an id-keyed namespace prefix into (path, entity)
// pairs, dropping unparseable blobs like the read layer does — and counting
// them. `include` filters by path before the decode, so a record the policy
// excludes is neither shipped nor counted (web's, for web's reasons). Keeps the
// entity and its path SEPARATE (no WithPath merge): the bracemark backup writes
// the plaintext exactly as stored, and `path` is storage infrastructure that
// must not leak into the round-tripped `data`.
function readRawNamespace<T extends z.ZodTypeAny>(
  prefix: string,
  schema: T,
  tally: Tally,
  include: (path: string) => boolean = () => true,
): { path: string; entity: z.infer<T> }[] {
  const out: { path: string; entity: z.infer<T> }[] = [];
  for (const record of namespaceRows(prefix)) {
    if (!include(record.path)) continue;
    const entity = parseBlob(record.data ?? undefined, schema);
    if (entity === undefined) tally.unreadable += 1;
    else out.push({ path: record.path, entity });
  }
  return out;
}

// Decode the whole `links/` namespace (newest first), join each survivor's
// extraction, and drop locked-list links. O(library) by nature — the export IS
// a full read — so both passes go a GATHER_CHUNK at a time with a real yield
// between chunks, as on web. Without one the chunks only split the progress
// count: the store reads are synchronous here, so the whole gather ran as one
// block of the JS thread (docs/data-lifecycle.md, _readings — expo_).
async function gatherLinks(
  excludedListIds: ReadonlySet<string>,
  tally: Tally,
  onProgress: ProgressFn,
): Promise<GatheredLink[]> {
  const records = namespaceRows(LINKS_PREFIX);
  const total = records.length;
  onProgress(0, total);

  const included: { path: string; link: Link }[] = [];
  for (let i = 0; i < records.length; i += GATHER_CHUNK) {
    await yieldToMain();
    for (const record of records.slice(i, i + GATHER_CHUNK)) {
      const link = parseBlob(record.data ?? undefined, linkSchema);
      // Counted whatever list it was in: an unreadable link names none.
      if (link === undefined) tally.unreadable += 1;
      else if (!excludedListIds.has(link.listId)) included.push({ path: record.path, link });
    }
    onProgress(Math.min(i + GATHER_CHUNK, total), total);
  }
  included.sort((a, b) => b.link.createdAt - a.link.createdAt);

  // Join the co-keyed extractions (the writer-split shadow of each link), read
  // and decoded a chunk at a time for the same reason.
  const gathered: GatheredLink[] = [];
  for (let i = 0; i < included.length; i += GATHER_CHUNK) {
    await yieldToMain();
    const slice = included.slice(i, i + GATHER_CHUNK);
    const exRecords = await bulkGetItems(
      slice.map(({ path }) => rekey(path, LINKS_PREFIX, EXTRACTIONS_PREFIX)),
    );
    slice.forEach(({ path, link }, j) => {
      const extraction = parseBlob(exRecords[j]?.data ?? undefined, extractionSchema);
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

// fflate stays lazy — it is settings-flow-only code — but spelled as a
// `require()`, not `await import('fflate')`. Metro resolves both at build time,
// so the app is identical either way; jest's CJS vm cannot service a real
// `import()` at all ("A dynamic import callback was invoked without
// --experimental-vm-modules"), and neither babel-preset-expo nor
// @react-native/babel-preset lowers one to a require. An `import()` here made
// this whole orchestrator unreachable from a spec. Same rule and same spelling
// as the lazy requires in data/share-store.ts; see jest.expo-base.cjs.
const fflate = (): typeof import('fflate') => require('fflate');

// `items.jsonl` bytes deflated between two yields while the backup zip streams.
const ZIP_PIECE = 256 * 1024;

// Assemble the backup zip in memory and write it to the cache file. A blob's
// bytes come off disk (dataFileFor — materialized by the files phase, or
// already local); a path that stayed unmaterialized is skipped here (already
// counted for the outcome). Stored, not deflated (`level: 0`), for the media
// entries — they're already-compressed formats. Throws ExportTooLargeError if
// the result wouldn't fit zip32 — before deflating, so nothing lands on disk.
//
// Streamed through fflate's `Zip`, not `zipSync`: `items.jsonl` is deflated
// ZIP_PIECE bytes at a time with a real yield between pieces, and each blob
// entry gets its own turn. zipSync deflated the whole library in one call —
// ~300 ms of the JS thread per 1,000 links on the simulator, all of the backup
// export's remaining stall once the gather yielded (docs/data-lifecycle.md,
// _readings — expo_). The stream is still synchronous inside each push; the
// pieces are what bound it.
async function assembleBracemarkZip(
  username: string,
  outFile: File,
  links: GatheredLink[],
  lists: { path: string; entity: List }[],
  tags: { path: string; entity: Tag }[],
  pins: { path: string; entity: Pin }[],
  settings: SettingsGeneral | undefined,
  filePaths: string[],
  failedPaths: readonly string[],
  unreadable: number,
): Promise<{ fileCount: number; failedFileCount: number }> {
  const { Zip, ZipDeflate, ZipPassThrough } = fflate();

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

  // Gather the includable blobs: a row that claims materialization AND whose
  // disk file is really there AND reads. A file the disk won't give back costs
  // that file, counted as missing like one never fetched — not the backup. A
  // failed path the content provider happened to fetch meanwhile ships, so it is
  // not failed.
  const fileEntries: [string, Uint8Array][] = [];
  const failed = new Set(failedPaths);
  let failedFileCount = 0;
  for (const path of filePaths) {
    const record = await getItem(path);
    const plain = dataFileFor(path);
    if (!record?.hasDataFile || !plain.exists) {
      if (failed.has(path)) failedFileCount += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await plain.bytes();
    } catch {
      continue;
    }
    fileEntries.push([backupFileEntry(idFromPath(path, FILES_PREFIX)), bytes]);
  }

  const manifestBytes = utf8(
    serializeBackupManifest(
      {
        links: links.length,
        lists: lists.length,
        tags: tags.length,
        pins: pins.length,
        extractions: links.filter((l) => l.extraction !== undefined).length,
        files: fileEntries.length,
      },
      { files: filePaths.length - fileEntries.length, unreadable },
    ),
  );
  const itemsBytes = utf8(serializeBackupItems(lines));

  // Every entry the archive will hold — checked before anything is deflated,
  // since fflate would silently truncate rather than fail (see the ceilings).
  assertZipWritable([
    [BACKUP_MANIFEST_ENTRY, manifestBytes],
    [BACKUP_ITEMS_ENTRY, itemsBytes],
    ...fileEntries,
  ]);

  // The stream hands its output back synchronously, inside each push; an error
  // is thrown from the push itself (fflate's sync streams), so there is no
  // separate failure path to watch.
  const out: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    out.push(chunk);
  });
  const manifest = new ZipDeflate(BACKUP_MANIFEST_ENTRY);
  zip.add(manifest);
  manifest.push(manifestBytes, true);
  const itemsEntry = new ZipDeflate(BACKUP_ITEMS_ENTRY);
  zip.add(itemsEntry);
  for (let i = 0; i === 0 || i < itemsBytes.length; i += ZIP_PIECE) {
    await yieldToMain();
    itemsEntry.push(itemsBytes.subarray(i, i + ZIP_PIECE), i + ZIP_PIECE >= itemsBytes.length);
  }
  for (const [name, bytes] of fileEntries) {
    await yieldToMain();
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();

  const zipped = new Uint8Array(out.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of out) {
    zipped.set(chunk, offset);
    offset += chunk.length;
  }
  writeExportFile(username, outFile, zipped);
  return { fileCount: fileEntries.length, failedFileCount };
}

// --- save helpers ---------------------------------------------------------------

// The run's one write, and the last thing it does. Fenced like a store write
// (sync-store.ts, AccountFencedError), for the same reason and one more: a run
// takes minutes and holds the library in memory once gathered, so a sign-out
// midway would otherwise end with the signed-out account's whole library
// written to the cache dir AFTER clearData swept it. The check and the write
// are synchronous together, so no wipe can land between them.
function writeExportFile(username: string, file: File, content: string | Uint8Array): void {
  getDb().transaction((tx) => assertAccountOwnsStoreTx(tx, username));
  file.create({ intermediates: true, overwrite: true });
  file.write(content);
  finishExportFile(file);
}

// --- the flow -------------------------------------------------------------------

export async function exportAllData(options: {
  format: ExportFormat;
  deps: SyncDeps;
  // The lock provider's coverage set (useLocks().lockedListIds) — descendants
  // included, so membership alone excludes a link/list.
  excludedListIds: ReadonlySet<string>;
  onProgress?: (progress: ExportProgress) => void;
}): Promise<ExportFileOutcome> {
  const { format, deps, excludedListIds } = options;
  const onProgress = options.onProgress ?? (() => undefined);
  const filename = exportFileName(format);
  const outFile = newExportFile(filename);
  const file: ExportedFile = { uri: outFile.uri, name: filename, mimeType: EXPORT_MIME[format] };

  // Refresh so "all data" means the account, not just this device. Best-effort:
  // a failed cycle downgrades to a warning and we export the local copy — unless
  // it failed because the account is going (a `session_revoked` verdict, or a
  // fenced write); web's copy has the reasoning. The fence on the write would
  // catch a wipe that has LANDED by then; this catches one still under way,
  // which the write would otherwise race.
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
    readRawNamespace(LISTS_PREFIX, listSchema, tally, unlockedList);
    readRawNamespace(TAGS_PREFIX, tagSchema, tally);
    const interopLinks = links.filter(({ link }) => link.listId !== TRASH_ID);
    const bundle = bundleFromLibrary(interopLinks, mergedLists, tags);
    const content =
      format === 'netscape'
        ? toNetscapeHtml(bundle)
        : format === 'csv'
          ? toRaindropCsv(bundle)
          : toUrlText(bundle);
    writeExportFile(deps.username, outFile, content);
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
      file,
    };
  }

  // Bracemark backup. Raw stored entities only (no synthesized system-list
  // defaults — import's merge-on-read reconstructs those, exactly like sync).
  const includedLinkIds = new Set(links.map(({ path }) => idFromPath(path, LINKS_PREFIX)));
  // Excluded by the PATH's id, like the pins below — the id the lock coverage is
  // computed over; web export-all-data.ts has the reasoning.
  const lists = readRawNamespace(LISTS_PREFIX, listSchema, tally, unlockedList);
  const tags = readRawNamespace(TAGS_PREFIX, tagSchema, tally);
  const pins = readRawNamespace(PINS_PREFIX, pinSchema, tally, (path) =>
    includedLinkIds.has(idFromPath(path, PINS_PREFIX)),
  );
  // Read raw rather than through readSettingsGeneral, which can't tell an absent
  // record from one that doesn't decode — and only the second is left out.
  const settingsRecord = await getItem(SETTINGS_GENERAL_PATH);
  const settings = parseBlob(settingsRecord?.data ?? undefined, settingsGeneralSchema);
  if (settingsRecord !== undefined && settings === undefined) tally.unreadable += 1;

  const filePaths = referencedFilePaths(links);
  onProgress({ step: 'files', done: 0, total: filePaths.length });
  // Best-effort, as on web (see there): the blobs that can't be downloaded now
  // are left out and counted rather than failing the backup.
  const { failedPaths } = await loadEntityContents(
    deps,
    filePaths,
    (done, total) => onProgress({ step: 'files', done, total }),
    { bestEffort: true },
  );

  onProgress({ step: 'assemble' });
  const { fileCount, failedFileCount } = await assembleBracemarkZip(
    deps.username,
    outFile,
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
    ...pastMaxDepthOf(lists, tags),
    syncFailed,
    file,
  };
}

// The list and tag lines a restore of this backup would place at TREE_MAX_DEPTH
// — asked of the restore's own rule (@stxapps/shared data/backup.ts,
// flattenBackupTree) over the lines being written, so the receipt says what
// the restore will do. The backup itself writes them as they are.
function pastMaxDepthOf(
  lists: readonly { path: string; entity: List }[],
  tags: readonly { path: string; entity: Tag }[],
): Pick<ExportOutcome, 'pastMaxDepthListCount' | 'pastMaxDepthTagCount'> {
  const { flattenedPaths } = flattenBackupTree([
    ...lists.map(({ path, entity }) => ({ path, data: entity, kind: 'list' as const })),
    ...tags.map(({ path, entity }) => ({ path, data: entity, kind: 'tag' as const })),
  ]);
  const among = (entries: readonly { path: string }[]) =>
    entries.filter(({ path }) => flattenedPaths.has(path)).length;
  return { pastMaxDepthListCount: among(lists), pastMaxDepthTagCount: among(tags) };
}
