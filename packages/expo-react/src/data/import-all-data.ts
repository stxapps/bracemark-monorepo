// Import-all-data orchestrator — the expo sibling of web-react's
// data/import-all-data.ts, and the write-side mirror of export-all-data.ts
// (web's file is the canonical doc: format detection — Bracemark-backup zip
// restored verbatim vs. interop rows becoming new links, and the POLICY —
// dedupe by canonical URL, skip-existing by path, the upfront quota gate, a
// file-carried title seeding the PROVISIONAL extraction title, folder paths
// find-or-created with the nestedLists flatten). Everything lands through the
// write edge (bulkWriteEntities), so the pending-ops queue carries the import
// to the server exactly like any other local edit. Platform divergences only
// here:
//
//  - The input is a picked file's { uri, name } (expo-document-picker copies
//    into the cache dir), read via expo-file-system — there is no DOM File.
//  - Zip reading is fflate's unzipSync (pure JS, no Web Streams — zip.js needs
//    a ReadableStream Hermes doesn't have). In-memory, matching export.
//  - A restored `files/{id}` blob's bytes land on DISK through
//    bulkWriteEntities' content path (file-store), not in the row.
//
// Everything that isn't a divergence is now literally shared, not copied: the
// archive contract (@stxapps/shared data/backup.ts), the outcome/progress
// vocabulary and quota gate (data/import-run.ts), and the interop parse
// dispatch + folder/tag resolvers (import/parse.ts, import/resolve.ts — the
// resolvers take expo-crypto's `newId`). The backup format especially: it's a
// ROUND TRIP across platforms (export on web, restore here), so a version bump
// must land for both at once.

import { File } from 'expo-file-system';

import { newId } from '@stxapps/expo-crypto';
import type { BundleEntry, Extraction, ImportOutcome, ImportProgress, Link } from '@stxapps/shared';
import {
  assertUnderImportQuota,
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  canonicalUrlKey,
  classifyBundleLine,
  cleanTitle,
  EXTRACTIONS_PREFIX,
  extractionSchema,
  FILES_PREFIX,
  idFromPath,
  type ImportedLink,
  isZipBytes,
  LINK_NOTE_MAX,
  LINKS_PREFIX,
  linkSchema,
  ListResolver,
  parseBackupManifest,
  parseImportText,
  pathFromId,
  PINS_PREFIX,
  referencedFileIds,
  TagResolver,
} from '@stxapps/shared';

import { runIncrementalSync, type SyncDeps } from '../sync/engine';
import { bulkGetItems, namespaceRows } from './item-store';
import { bulkWriteEntities, type RawEntityEntry } from './mutations';
import { readLists, readTags } from './queries';

// The picked file to import — expo-document-picker's asset, narrowed to what
// the orchestrator needs. `name` feeds format detection (extension hints).
export interface PickedFile {
  uri: string;
  name: string;
}

// Writes land in bounded transactions so SQLite isn't asked for one
// transaction per link and progress can tick between chunks.
const WRITE_CHUNK = 200;

// --- the existing library (what dedupe/quota/skip-existing check against) -------

interface ExistingLinks {
  count: number;
  ids: Set<string>;
  // canonicalUrlKey per link (falling back to the exact stored URL when the key
  // can't be derived), off the projected columns, no blob decode.
  urlKeys: Set<string>;
}

function readExistingLinks(): ExistingLinks {
  const records = namespaceRows(LINKS_PREFIX);
  const ids = new Set<string>();
  const urlKeys = new Set<string>();
  for (const record of records) {
    ids.add(idFromPath(record.path, LINKS_PREFIX));
    const key = record.itemUrlKey ?? record.itemUrl;
    if (key !== null && key !== undefined) urlKeys.add(key);
  }
  return { count: records.length, ids, urlKeys };
}

// --- interop: parsed rows → new entities -----------------------------------------

async function importInterop(
  username: string,
  parsed: ImportedLink[],
  maxLinks: number | null,
  nestedLists: boolean,
  onProgress: (progress: ImportProgress) => void,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const existing = readExistingLinks();

  // Dedupe against the library and within the file, by canonical identity.
  const seen = new Set(existing.urlKeys);
  const rows: ImportedLink[] = [];
  for (const row of parsed) {
    const key = canonicalUrlKey(row.url) ?? row.url;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  const skippedCount = parsed.length - rows.length;

  assertUnderImportQuota(rows.length, existing.count, maxLinks);

  const now = Date.now();
  const lists = new ListResolver(await readLists(), now, newId);
  const tags = new TagResolver(await readTags(), now, newId);

  let invalidCount = 0;
  let linkCount = 0;
  const linkEntries: RawEntityEntry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Undated rows get descending stamps from `now`, so the file's order IS the
    // library's newest-first display order after import.
    const createdAt = row.createdAt ?? now - i;
    const updatedAt = Math.max(row.updatedAt ?? createdAt, createdAt);
    const folderPath = nestedLists
      ? row.folderPath
      : row.folderPath.length > 0
        ? [row.folderPath.join('/')]
        : [];

    const id = newId();
    const link: Link = {
      url: row.url,
      listId: lists.resolve(folderPath),
      tagIds: tags.resolve(row.tagNames),
      createdAt,
      updatedAt,
    };
    if (row.note !== undefined) link.note = row.note.slice(0, LINK_NOTE_MAX);
    if (!linkSchema.safeParse(link).success) {
      invalidCount += 1;
      continue;
    }
    linkEntries.push({ path: pathFromId(id, LINKS_PREFIX), data: link });
    linkCount += 1;

    const title = cleanTitle(row.title);
    if (title !== undefined) {
      const extraction: Extraction = { id, title, facets: {}, createdAt, updatedAt };
      if (extractionSchema.safeParse(extraction).success) {
        linkEntries.push({ path: pathFromId(id, EXTRACTIONS_PREFIX), data: extraction });
      }
    }
  }

  // Lists and tags land first so no chunk boundary leaves a link pointing at a
  // list/tag that isn't stored yet (a dangling ref is survivable, but free to
  // avoid here). Progress counts entity writes.
  const entries = [...lists.created, ...tags.created, ...linkEntries];
  onProgress({ step: 'items', done: 0, total: entries.length });
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    await bulkWriteEntities(username, entries.slice(i, i + WRITE_CHUNK));
    onProgress({
      step: 'items',
      done: Math.min(i + WRITE_CHUNK, entries.length),
      total: entries.length,
    });
  }

  return {
    linkCount,
    listCount: lists.created.length,
    tagCount: tags.created.length,
    fileCount: 0,
    skippedCount,
    invalidCount,
  };
}

// --- the bracemark backup -------------------------------------------------------------

async function importBracemarkBackup(
  username: string,
  byName: Map<string, Uint8Array>,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const decoder = new TextDecoder();

  const manifestBytes = byName.get(BACKUP_MANIFEST_ENTRY);
  if (manifestBytes === undefined) {
    throw new Error('This zip is not a Bracemark backup (no manifest.json).');
  }
  // Format/version gate — throws the user-facing message (shared data/backup.ts).
  parseBackupManifest(decoder.decode(manifestBytes));

  const itemsBytes = byName.get(BACKUP_ITEMS_ENTRY);
  const itemsText = itemsBytes === undefined ? '' : decoder.decode(itemsBytes);

  let invalidCount = 0;
  const classified: BundleEntry[] = [];
  for (const line of itemsText.split('\n')) {
    if (line.trim() === '') continue;
    const entry = classifyBundleLine(line);
    if (entry === undefined) invalidCount += 1;
    else classified.push(entry);
  }

  // SKIP-EXISTING: a path already in the local store is never touched.
  const existingRecords = await bulkGetItems(classified.map((entry) => entry.path));
  let skippedCount = 0;
  const fresh = classified.filter((_, i) => {
    if (existingRecords[i] === undefined) return true;
    skippedCount += 1;
    return false;
  });

  const existing = readExistingLinks();
  const freshLinks = fresh.filter((entry) => entry.kind === 'link');
  assertUnderImportQuota(freshLinks.length, existing.count, maxLinks);

  // A pin/extraction whose link is neither imported nor already local is a
  // dangling satellite — drop it rather than restore garbage.
  const linkIds = new Set(existing.ids);
  for (const entry of freshLinks) {
    linkIds.add(idFromPath(entry.path, LINKS_PREFIX));
  }
  const entries = fresh.filter((entry) => {
    if (entry.kind !== 'pin' && entry.kind !== 'extraction') return true;
    const prefix = entry.kind === 'pin' ? PINS_PREFIX : EXTRACTIONS_PREFIX;
    return linkIds.has(idFromPath(entry.path, prefix));
  });

  onProgress({ step: 'items', done: 0, total: entries.length });
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    await bulkWriteEntities(
      username,
      entries.slice(i, i + WRITE_CHUNK).map(({ path, data }) => ({ path, data })),
    );
    onProgress({
      step: 'items',
      done: Math.min(i + WRITE_CHUNK, entries.length),
      total: entries.length,
    });
  }

  // The referenced blobs, one at a time (they can be MB-sized media): only
  // ids with a zip entry and no locally-materialized bytes. A ref with no bytes
  // stays a normal not-yet-materialized lazy blob.
  const fileIds = [...referencedFileIds(entries)];
  const filePaths = fileIds.map((id) => pathFromId(id, FILES_PREFIX));
  const localFiles = await bulkGetItems(filePaths);
  let fileCount = 0;
  onProgress({ step: 'files', done: 0, total: fileIds.length });
  for (let i = 0; i < fileIds.length; i++) {
    const bytes = byName.get(backupFileEntry(fileIds[i]));
    if (bytes !== undefined && !localFiles[i]?.hasDataFile) {
      await bulkWriteEntities(username, [{ path: filePaths[i], data: bytes }]);
      fileCount += 1;
    }
    onProgress({ step: 'files', done: i + 1, total: fileIds.length });
  }

  return {
    linkCount: freshLinks.length,
    listCount: entries.filter((entry) => entry.kind === 'list').length,
    tagCount: entries.filter((entry) => entry.kind === 'tag').length,
    fileCount,
    skippedCount,
    invalidCount,
  };
}

// --- interop zips ------------------------------------------------------------------

// The text entries an interop zip can carry (Pocket's shutdown export is a zip
// of part_*.csv files; other services zip an HTML bookmarks file the same way).
const INTEROP_ZIP_ENTRY_RE = /\.(csv|html?|txt)$/i;

// Parse every recognizable text entry and concatenate the rows — the zip-level
// mirror of the text branch in importAllData. Archiver metadata (__MACOSX/…)
// and hidden files are skipped; filename order keeps multi-part exports
// (part_000000.csv, part_000001.csv, …) in sequence.
function parseInteropZip(byName: Map<string, Uint8Array>): ImportedLink[] {
  const decoder = new TextDecoder();
  const candidates = [...byName.entries()]
    .filter(([name]) => {
      const base = name.slice(name.lastIndexOf('/') + 1);
      return (
        INTEROP_ZIP_ENTRY_RE.test(name) && !name.startsWith('__MACOSX/') && !base.startsWith('.')
      );
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (candidates.length === 0) {
    throw new Error(
      'This zip is neither a Bracemark backup nor a bookmarks export (no .html, .csv, or .txt files inside).',
    );
  }

  const parsed: ImportedLink[] = [];
  for (const [name, bytes] of candidates) {
    parsed.push(...parseImportText(decoder.decode(bytes), name));
  }
  return parsed;
}

// The zip dispatch: one unzip, one entry map. manifest.json marks a Bracemark
// backup (restored verbatim); any other zip is treated as a zipped interop
// export and its text entries become new links.
async function importZip(
  username: string,
  bytes: Uint8Array,
  maxLinks: number | null,
  nestedLists: boolean,
  onProgress: (progress: ImportProgress) => void,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const { unzipSync } = await import('fflate');

  // fflate keys entries by filename; directory entries end with '/' and carry
  // no bytes — drop them so the map mirrors zip.js's file-only view.
  const unzipped = unzipSync(bytes);
  const byName = new Map<string, Uint8Array>(
    Object.entries(unzipped).filter(([name]) => !name.endsWith('/')),
  );

  if (byName.has(BACKUP_MANIFEST_ENTRY)) {
    return importBracemarkBackup(username, byName, maxLinks, onProgress);
  }
  const parsed = parseInteropZip(byName);
  return importInterop(username, parsed, maxLinks, nestedLists, onProgress);
}

// --- the flow -----------------------------------------------------------------------

export async function importAllData(options: {
  file: PickedFile;
  deps: SyncDeps;
  // The plan's link cap (entitlementsOf(plan).maxLinks); null = unlimited.
  maxLinks: number | null;
  // Whether folder paths may create nested lists (entitlements.nestedLists).
  nestedLists: boolean;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportOutcome> {
  const { file, deps, maxLinks, nestedLists } = options;
  const onProgress = options.onProgress ?? (() => undefined);

  // Refresh first so dedupe, skip-existing, and the quota gate see the account,
  // not just this device. Best-effort: a failed cycle downgrades to a warning
  // and the import checks against the local copy.
  onProgress({ step: 'sync' });
  let syncFailed = false;
  try {
    await runIncrementalSync(deps);
  } catch {
    syncFailed = true;
  }

  onProgress({ step: 'parse' });
  const bytes = await new File(file.uri).bytes();
  if (isZipBytes(bytes)) {
    const outcome = await importZip(deps.username, bytes, maxLinks, nestedLists, onProgress);
    return { ...outcome, syncFailed };
  }

  const parsed = parseImportText(new TextDecoder().decode(bytes), file.name);
  const outcome = await importInterop(deps.username, parsed, maxLinks, nestedLists, onProgress);
  return { ...outcome, syncFailed };
}
