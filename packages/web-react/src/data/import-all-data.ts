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
//               zip WITHOUT manifest.json routes here too — its
//               .html/.csv/.txt/.json entries are parsed and concatenated
//               (Pocket's shutdown export is a zip of part_*.csv files).
//   linkwarden — a LinkWarden backup.json, the other foreign whole-backup
//               format (LinkWarden has no bookmarks file to offer). Same
//               interop path; it carries collections, tags, notes and pins.
//   brace     — a Brace.to export (this project's predecessor): a foreign app's
//               whole backup, so it carries more than a bookmarks file can —
//               custom titles, Archive/Trash membership, pins, and the user's
//               custom link images. It runs through the SAME interop path (new
//               ids, dedupe by URL, find-or-create folders/tags), just with the
//               richer optional fields of ImportedLink filled in. Everything
//               format-specific about it is in @stxapps/shared import/brace.ts.
//
// POLICY (decided here, once):
//   - Interop imports SKIP DUPLICATES by the canonical URL identity
//     (canonicalUrlKey — the same key behind the quick-add duplicate warning),
//     both against the library and within the file; skips are reported, never
//     errors.
//   - The bracemark backup merges SKIP-EXISTING by path: a path already in the local
//     store is never touched, so a restore can't clobber newer local edits.
//   - The plan's link cap is enforced UP FRONT, BEFORE anything is written. This
//     is one of the three places that enforce the cap at all — it is client-side
//     now, so `files/sign` would take an over-cap import without complaint. An
//     INTEROP file that doesn't fit becomes a question rather than a failure
//     (`onQuotaPrompt` → take what fits, or cancel); a BACKUP that doesn't fit is
//     still refused whole, because a half-restored backup is the corrupt-looking
//     outcome the whole-file rule was written for. Why the two differ:
//     @stxapps/shared data/import-run.ts.
//   - A file-carried title lands as `customTitle`, above anything extraction
//     finds: no interop file says whether the user renamed a link, and
//     overwriting a rename can't be undone (@stxapps/shared import/bundle.ts,
//     ImportedLink.customTitle). Only a source extractor's own title (Brace's)
//     seeds the provisional `extraction.title`.
//   - Folder paths find-or-create lists by case-insensitive name walk, at the
//     POSITION the path names: each segment is matched among the children of the
//     one before it, so "Work/Specs" reuses a Specs that already sits under Work
//     and mints one otherwise. The tree is built on EVERY plan — `nestedLists`
//     gates the reparent affordances, not the import (@stxapps/shared
//     import/project.ts, the header). Trash never matches a folder name —
//     importing live bookmarks as deleted-pending links is never wanted.
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

import type { BundleEntry, ImportOutcome, ImportProgress } from '@stxapps/shared';
import {
  assertUnderImportQuota,
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  canonicalUrlKey,
  classifyBundleLine,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  idFromPath,
  type ImportedBundle,
  type ImportedLink,
  type ImportQuotaResolver,
  isZipBytes,
  LINKS_PREFIX,
  parseBackupManifest,
  parseImportText,
  pathFromId,
  PINS_PREFIX,
  projectImportedLinks,
  referencedFileIds,
  resolveImportQuota,
} from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';

import { runIncrementalSync, type SyncDeps } from '../sync/engine';
import { db } from './db';
import { bulkWriteEntities, type RawEntityEntry } from './mutations';
import { readLists, readPins, readTags } from './queries';

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
  bundle: ImportedBundle,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
  onQuotaPrompt?: ImportQuotaResolver,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const existing = await readExistingLinks();

  // Dedupe against the library and within the file, by canonical identity.
  const seen = new Set(existing.urlKeys);
  const rows: ImportedLink[] = [];
  for (const row of bundle.links) {
    const key = canonicalUrlKey(row.url) ?? row.url;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  const skippedCount = bundle.links.length - rows.length;

  // Over the cap, this SUSPENDS the run on the user's answer (take what fits, or
  // cancel — which throws ImportQuotaError like it always did). Nothing has been
  // written yet, and nothing will be if they back out. `keep` is the whole row
  // count in every other case.
  const keep = await resolveImportQuota(rows.length, existing.count, maxLinks, onQuotaPrompt);
  const notImportedCount = rows.length - keep;
  // Truncate BEFORE projection, so the lists and tags created are only the ones
  // the kept rows actually need — an imported-but-empty list would be litter.
  const kept = notImportedCount > 0 ? rows.slice(0, keep) : rows;

  // Rows → entities: which list each lands in, deliberate vs. provisional
  // titles, custom-image blobs, pin ranks. All of it is shared with expo
  // (@stxapps/shared import/project.ts) — only the store reads around it and the
  // chunked writes below are this platform's.
  const projected = projectImportedLinks({
    rows: kept,
    lists: await readLists(),
    tags: await readTags(),
    existingPinRanks: (await readPins()).map((pin) => pin.rank),
    images: bundle.images,
    newId,
    now: Date.now(),
  });

  // Blobs first (content before metadata), one at a time — they can be MB-sized,
  // unlike the small entity rows that follow.
  if (projected.files.length > 0) {
    onProgress({ step: 'files', done: 0, total: projected.files.length });
    for (let i = 0; i < projected.files.length; i++) {
      await bulkWriteEntities(username, [projected.files[i]]);
      onProgress({ step: 'files', done: i + 1, total: projected.files.length });
    }
  }

  const entries: RawEntityEntry[] = projected.entries;
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
    linkCount: projected.linkCount,
    listCount: projected.listCount,
    tagCount: projected.tagCount,
    fileCount: projected.files.length,
    skippedCount,
    invalidCount: projected.invalidCount,
    notImportedCount,
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
  // Whole-file refusal, deliberately NOT the interop path's prompt: a backup
  // restored to 200 of its 1,200 links, with its lists and pins pointing at the
  // 1,000 that aren't there, is the corrupt-looking far end the rule exists for.
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
    // A backup either fits or is refused whole — it never truncates.
    notImportedCount: 0,
  };
}

// --- interop zips ------------------------------------------------------------------

// The text entries an interop zip can carry (Pocket's shutdown export is a zip
// of part_*.csv files; other services zip an HTML bookmarks file the same way).
// `.json` is here for the file a user zipped themselves — LinkWarden's backup
// downloads bare — and it costs nothing to allow: an entry is DETECTED like any
// other, so a .json that isn't a LinkWarden backup gets the same text-mining
// degrade a stray .txt already got, rather than a zip-level error naming three
// extensions and meaning four.
const INTEROP_ZIP_ENTRY_RE = /\.(csv|html?|txt|json)$/i;

// Parse every recognizable text entry and concatenate the rows — the zip-level
// mirror of the text branch in importAllData. Archiver metadata (__MACOSX/…)
// and hidden files are skipped; filename order keeps multi-part exports
// (part_000000.csv, part_000001.csv, …) in sequence. Brace.to itself exports a
// bare .txt, never a zip — but a user who zips that .txt lands here anyway, and
// the entry sniffs as `brace` like any other (detection runs per entry).
async function parseInteropZip(byName: Map<string, FileEntry>): Promise<ImportedBundle> {
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
      'This zip is neither a Bracemark backup nor a bookmarks export (no .html, .csv, .json, or .txt files inside).',
    );
  }

  const links: ImportedLink[] = [];
  const images = new Map<string, Uint8Array>();
  for (const [name, entry] of candidates) {
    const parsed = parseImportText(await entry.getData(new TextWriter()), name);
    links.push(...parsed.links);
    for (const [key, bytes] of parsed.images) images.set(key, bytes);
  }
  return { links, images };
}

// The zip dispatch: one reader, one entry map. manifest.json marks a Bracemark
// backup (restored verbatim); any other zip is treated as a zipped interop
// export and its text entries become new links. The reader stays open across the
// interop branch's over-cap prompt — it reads an in-memory Blob, so holding it
// while the user decides costs nothing, and `finally` still closes it on either
// answer.
async function importZip(
  username: string,
  file: File,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
  onQuotaPrompt?: ImportQuotaResolver,
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
    return await importInterop(username, parsed, maxLinks, onProgress, onQuotaPrompt);
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
  onProgress?: (progress: ImportProgress) => void;
  // Asked when an INTEROP file would pass `maxLinks`: take what fits, or cancel.
  // Omitted (or a backup file) means the old behaviour — refuse the whole file.
  onQuotaPrompt?: ImportQuotaResolver;
}): Promise<ImportOutcome> {
  const { file, deps, maxLinks, onQuotaPrompt } = options;
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
    const outcome = await importZip(deps.username, file, maxLinks, onProgress, onQuotaPrompt);
    return { ...outcome, syncFailed };
  }

  const parsed = parseImportText(new TextDecoder().decode(bytes), file.name);
  const outcome = await importInterop(deps.username, parsed, maxLinks, onProgress, onQuotaPrompt);
  return { ...outcome, syncFailed };
}
