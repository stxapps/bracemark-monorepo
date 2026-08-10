'use client';

// Import-all-data orchestrator — the Settings → Data → Import action behind
// useImportAllData (hooks/use-import-all-data.ts), and the write-side mirror of
// export-all-data.ts. One entry point takes the picked File, detects its format,
// and lands everything in the LOCAL store through the write edge
// (bulkWriteEntities), so the durable pending-ops queue carries the import to
// the server exactly like any other local edit — the caller kicks a sync when
// the run finishes.
//
//   bracemark     — the re-importable backup zip export-all-data.ts produced
//               (manifest.json + items.jsonl + files/{id}): raw entities
//               restored VERBATIM under their original paths, timestamps
//               preserved.
//   netscape / csv / text — the interop formats: parsed rows (the pure parsers
//               in @stxapps/shared import/) become NEW links, their folders and
//               tag names resolved against — or created in — this library. A
//               zip WITHOUT manifest.json routes here too — its .html/.csv/.txt
//               entries are parsed and concatenated (Pocket's shutdown export
//               is a zip of part_*.csv files).
//
// POLICY (decided here, once):
//   - Interop imports SKIP DUPLICATES by the canonical URL identity
//     (canonicalUrlKey — the same key behind the quick-add duplicate warning),
//     both against the library and within the file; skips are reported, never
//     errors.
//   - The bracemark backup merges SKIP-EXISTING by path: a path already in the local
//     store is never touched, so a restore can't clobber newer local edits.
//   - The plan's link cap is enforced UP FRONT: if the surviving new links would
//     push the library past `maxLinks`, the import fails BEFORE anything is
//     written (ImportQuotaError). This is one of the three places that enforce
//     the cap at all — it is client-side now, so
//     `files/sign` would take an over-cap import without complaint.
//   - A file-carried title is PROVISIONAL, not deliberate: it seeds
//     `extraction.title` (which extraction may later upgrade), never
//     `customTitle` — see the contract note in @stxapps/shared sync/entities.ts.
//   - Folder paths find-or-create lists by case-insensitive name walk; without
//     the nestedLists entitlement a nested path flattens to ONE root-level list
//     named by the slash-joined path (the CSV `folder` column's own shape).
//     Trash never matches a folder name — importing live bookmarks as
//     deleted-pending links is never wanted.
//
// What's NOT here, because both platforms need the same answer: the
// bracemark-backup archive contract (entry names, manifest, items.jsonl
// classification, referenced blob ids) is @stxapps/shared data/backup.ts — the
// format is a ROUND TRIP, so a version bump has to land for web and expo at
// once or a web-written archive is misread on mobile; the outcome/progress
// vocabulary and the quota gate are data/import-run.ts; the interop parse
// dispatch and the folder/tag resolvers are import/parse.ts and
// import/resolve.ts (the resolvers take `newId` as an argument — the one thing
// that differs, web-crypto vs. expo-crypto). What stays here is what's actually
// platform-bound: Dexie reads, zip.js, and the DOM File.

// Type-only — erased at compile time, so zip.js itself stays lazily imported.
import type { FileEntry } from '@zip.js/zip.js';

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
import { newId } from '@stxapps/web-crypto';

import { runIncrementalSync, type SyncDeps } from '../sync/engine';
import { db } from './db';
import { bulkWriteEntities, type RawEntityEntry } from './mutations';
import { readLists, readTags } from './queries';

// Writes land in bounded transactions so IndexedDB isn't asked for one
// transaction per link and progress can tick between chunks.
const WRITE_CHUNK = 200;

// --- the existing library (what dedupe/quota/skip-existing check against) -------

interface ExistingLinks {
  count: number;
  ids: Set<string>;
  // canonicalUrlKey per link (falling back to the exact stored URL when the key
  // can't be derived — same fallback readLinkByUrlKey makes), off the projected
  // index columns, no blob decode.
  urlKeys: Set<string>;
}

async function readExistingLinks(): Promise<ExistingLinks> {
  const records = await db.items.where('path').startsWith(LINKS_PREFIX).toArray();
  const ids = new Set<string>();
  const urlKeys = new Set<string>();
  for (const record of records) {
    ids.add(idFromPath(record.path, LINKS_PREFIX));
    const key = record.itemUrlKey ?? record.itemUrl;
    if (key !== undefined) urlKeys.add(key);
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
  const existing = await readExistingLinks();

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
  byName: Map<string, FileEntry>,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  // Already loaded by importZip — this re-import just picks the writers off the
  // cached module.
  const { TextWriter, Uint8ArrayWriter } = await import('@zip.js/zip.js');

  const manifestEntry = byName.get(BACKUP_MANIFEST_ENTRY);
  if (manifestEntry === undefined) {
    throw new Error('This zip is not a Bracemark backup (no manifest.json).');
  }
  // Format/version gate — throws the user-facing message (shared data/backup.ts).
  parseBackupManifest(await manifestEntry.getData(new TextWriter()));

  const itemsEntry = byName.get(BACKUP_ITEMS_ENTRY);
  const itemsText = itemsEntry === undefined ? '' : await itemsEntry.getData(new TextWriter());

  let invalidCount = 0;
  const classified: BundleEntry[] = [];
  for (const line of itemsText.split('\n')) {
    if (line.trim() === '') continue;
    const entry = classifyBundleLine(line);
    if (entry === undefined) invalidCount += 1;
    else classified.push(entry);
  }

  // SKIP-EXISTING: a path already in the local store is never touched.
  const existingRecords = await db.items.bulkGet(classified.map((entry) => entry.path));
  let skippedCount = 0;
  const fresh = classified.filter((_, i) => {
    if (existingRecords[i] === undefined) return true;
    skippedCount += 1;
    return false;
  });

  const existing = await readExistingLinks();
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
  // ids with a zip entry and no local record. A ref with no bytes stays a
  // normal not-yet-materialized lazy blob.
  const fileIds = [...referencedFileIds(entries)];
  const filePaths = fileIds.map((id) => pathFromId(id, FILES_PREFIX));
  const localFiles = await db.items.bulkGet(filePaths);
  let fileCount = 0;
  onProgress({ step: 'files', done: 0, total: fileIds.length });
  for (let i = 0; i < fileIds.length; i++) {
    const zipEntry = byName.get(backupFileEntry(fileIds[i]));
    if (zipEntry !== undefined && localFiles[i]?.data === undefined) {
      const bytes = await zipEntry.getData(new Uint8ArrayWriter());
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
async function parseInteropZip(byName: Map<string, FileEntry>): Promise<ImportedLink[]> {
  const { TextWriter } = await import('@zip.js/zip.js');

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
  for (const [name, entry] of candidates) {
    parsed.push(...parseImportText(await entry.getData(new TextWriter()), name));
  }
  return parsed;
}

// The zip dispatch: one reader, one entry map. manifest.json marks a Bracemark
// backup (restored verbatim); any other zip is treated as a zipped interop
// export and its text entries become new links.
async function importZip(
  username: string,
  file: File,
  maxLinks: number | null,
  nestedLists: boolean,
  onProgress: (progress: ImportProgress) => void,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  const zipReader = new ZipReader(new BlobReader(file));

  try {
    const zipEntries = await zipReader.getEntries();
    const byName = new Map<string, FileEntry>(
      zipEntries
        .filter((entry): entry is FileEntry => !entry.directory)
        .map((entry) => [entry.filename, entry]),
    );

    if (byName.has(BACKUP_MANIFEST_ENTRY)) {
      return await importBracemarkBackup(username, byName, maxLinks, onProgress);
    }
    const parsed = await parseInteropZip(byName);
    return await importInterop(username, parsed, maxLinks, nestedLists, onProgress);
  } finally {
    await zipReader.close();
  }
}

// --- the flow -----------------------------------------------------------------------

export async function importAllData(options: {
  file: File;
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isZipBytes(bytes)) {
    const outcome = await importZip(deps.username, file, maxLinks, nestedLists, onProgress);
    return { ...outcome, syncFailed };
  }

  const parsed = parseImportText(new TextDecoder().decode(bytes), file.name);
  const outcome = await importInterop(deps.username, parsed, maxLinks, nestedLists, onProgress);
  return { ...outcome, syncFailed };
}
