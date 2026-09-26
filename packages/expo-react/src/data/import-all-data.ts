// Import-all-data orchestrator — the expo sibling of web-react's
// data/import-all-data.ts, and the write-side mirror of export-all-data.ts
// (web's file is the canonical doc: format detection — Bracemark-backup zip
// restored verbatim vs. interop/Brace.to rows becoming new links, and the POLICY —
// dedupe by canonical URL, skip-existing by path, the upfront quota gate, a
// file-carried title landing as the link's own `customTitle`, folder paths
// find-or-created at the position they name, on every plan). Everything lands through the
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
//  - Text is decoded by lib/utf8.ts, not TextDecoder — Hermes has none, and
//    the polyfill Expo installs is slow enough to matter at a file's size.
//  - Every write chunk waits on a real yield (WRITE_CHUNK below), and live
//    reads are held while writing (after parsing and the quota decision).
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
  parseImportTextInChunks,
  pathFromId,
  PINS_PREFIX,
  projectImportedLinksInChunks,
  referencedFileIds,
  resolveImportQuota,
} from '@stxapps/shared';

import { decodeUtf8 } from '../lib/utf8';
import { yieldToMain } from '../lib/yield-to-main';
import { runIncrementalSync, type SyncDeps } from '../sync/engine';
import { bulkGetItems, namespaceRows } from './item-store';
import { holdLiveReads } from './live-read-invalidation';
import { bulkWriteEntities, type RawEntityEntry } from './mutations';
import { readLists, readPins, readTags } from './queries';

// The picked file to import — expo-document-picker's asset, narrowed to what
// the orchestrator needs. `name` feeds format detection (extension hints).
export interface PickedFile {
  uri: string;
  name: string;
}

// Writes land in bounded transactions so SQLite isn't asked for one
// transaction per link and progress can tick between chunks — and, unlike web,
// every chunk waits on a real yield first (`yieldToMain`). The store calls here are
// synchronous under their `async` signatures, so awaiting one resumes at once,
// and without the yield the whole import ran as ONE block of the JS thread: 6.5 s
// for a 1,000-link restore on the simulator, 80 s at 10,000, with the progress
// line frozen throughout (docs/data-lifecycle.md, _readings — expo_).
const WRITE_CHUNK = 200;

// WHOLE_FILE_STEPS. The whole-file steps at the front of an import are each one
// synchronous call that no loop yield can split: fflate's `unzipSync` over the
// archive, then `decodeUtf8` over a file. Each is followed by a yield, so the
// next step runs in a task of its own. At 10,000 links the inflate (~0.3 s), the
// decode of `items.jsonl` (~0.27 s) and the first classify slice ran as ONE task,
// the restore's longest stall (docs/data-lifecycle.md, _the pause_). Splitting
// them further means inflating and decoding in pieces.

// Rows or lines handled between two yields in the loops that run BEFORE the
// writes (dedupe, the backup's classify pass and its skip-existing lookup) —
// web's constant and web's placement (web-react data/import-all-data.ts). The
// projection pauses on its own chunk, PROJECT_CHUNK in @stxapps/shared
// import/project.ts.
const YIELD_CHUNK = 1000;

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
  bundle: ImportedBundle,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
  onQuotaPrompt?: ImportQuotaResolver,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const existing = readExistingLinks();

  // Dedupe against the library and within the file, by canonical identity.
  const seen = new Set(existing.urlKeys);
  const rows: ImportedLink[] = [];
  for (let i = 0; i < bundle.links.length; i++) {
    if (i > 0 && i % YIELD_CHUNK === 0) await yieldToMain();
    const row = bundle.links[i];
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
  // titles, custom-image blobs, pin ranks. All of it is shared with web
  // (@stxapps/shared import/project.ts) — only the store reads around it and the
  // chunked writes below are this platform's.
  const projected = await projectImportedLinksInChunks(
    {
      rows: kept,
      lists: await readLists(),
      tags: await readTags(),
      existingPinRanks: (await readPins()).map((pin) => pin.rank),
      images: bundle.images,
      newId,
      now: Date.now(),
    },
    yieldToMain,
  );

  const releaseLiveReads = holdLiveReads();
  try {
    // Blobs first (content before metadata), one at a time — they can be MB-sized,
    // unlike the small entity rows that follow. Their bytes land on DISK through
    // bulkWriteEntities' content path, not in the row.
    if (projected.files.length > 0) {
      onProgress({ step: 'files', done: 0, total: projected.files.length });
      for (let i = 0; i < projected.files.length; i++) {
        if (i > 0) await yieldToMain();
        await bulkWriteEntities(username, [projected.files[i]]);
        onProgress({ step: 'files', done: i + 1, total: projected.files.length });
      }
    }

    const entries: RawEntityEntry[] = projected.entries;
    onProgress({ step: 'items', done: 0, total: entries.length });
    for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
      await yieldToMain();
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
  } finally {
    releaseLiveReads();
  }
}

// --- the bracemark backup -------------------------------------------------------------

async function importBracemarkBackup(
  username: string,
  byName: Map<string, Uint8Array>,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const manifestBytes = byName.get(BACKUP_MANIFEST_ENTRY);
  if (manifestBytes === undefined) {
    throw new Error('This zip is not a Bracemark backup (no manifest.json).');
  }
  // Format/version gate — throws the user-facing message (shared data/backup.ts).
  parseBackupManifest(decodeUtf8(manifestBytes));

  const itemsBytes = byName.get(BACKUP_ITEMS_ENTRY);
  const itemsText = itemsBytes === undefined ? '' : decodeUtf8(itemsBytes);
  // The decode is one synchronous call over the whole file; the classify pass
  // starts in a task of its own (WHOLE_FILE_STEPS).
  await yieldToMain();

  let invalidCount = 0;
  const classified: BundleEntry[] = [];
  const lines = itemsText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % YIELD_CHUNK === 0) await yieldToMain();
    const line = lines[i];
    if (line.trim() === '') continue;
    const entry = classifyBundleLine(line);
    if (entry === undefined) invalidCount += 1;
    else classified.push(entry);
  }

  // SKIP-EXISTING: a path already in the local store is never touched. Looked
  // up a slice at a time, with a yield between slices, as on web.
  const existingRecords: unknown[] = [];
  for (let i = 0; i < classified.length; i += YIELD_CHUNK) {
    if (i > 0) await yieldToMain();
    const slice = classified.slice(i, i + YIELD_CHUNK).map((entry) => entry.path);
    existingRecords.push(...(await bulkGetItems(slice)));
  }
  let skippedCount = 0;
  const fresh = classified.filter((_, i) => {
    if (existingRecords[i] === undefined) return true;
    skippedCount += 1;
    return false;
  });

  const existing = readExistingLinks();
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

  const releaseLiveReads = holdLiveReads();
  try {
    // Content before metadata, as on the interop path: if a file fails, retrying
    // still sees its owning entity as fresh and includes the file again.
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
        await yieldToMain();
        await bulkWriteEntities(username, [{ path: filePaths[i], data: bytes }]);
        fileCount += 1;
      }
      onProgress({ step: 'files', done: i + 1, total: fileIds.length });
    }

    const writtenPaths = new Set<string>();
    onProgress({ step: 'items', done: 0, total: entries.length });
    for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
      await yieldToMain();
      const written = await bulkWriteEntities(
        username,
        entries.slice(i, i + WRITE_CHUNK).map(({ path, data }) => ({ path, data })),
        { skipExisting: true },
      );
      for (const path of written) writtenPaths.add(path);
      onProgress({
        step: 'items',
        done: Math.min(i + WRITE_CHUNK, entries.length),
        total: entries.length,
      });
    }

    const imported = entries.filter((entry) => writtenPaths.has(entry.path));
    skippedCount += entries.length - imported.length;

    return {
      linkCount: imported.filter((entry) => entry.kind === 'link').length,
      listCount: imported.filter((entry) => entry.kind === 'list').length,
      tagCount: imported.filter((entry) => entry.kind === 'tag').length,
      fileCount,
      skippedCount,
      invalidCount,
      // A backup either fits or is refused whole — it never truncates.
      notImportedCount: 0,
    };
  } finally {
    releaseLiveReads();
  }
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
async function parseInteropZip(byName: Map<string, Uint8Array>): Promise<ImportedBundle> {
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
  for (const [name, bytes] of candidates) {
    const text = decodeUtf8(bytes);
    await yieldToMain(); // WHOLE_FILE_STEPS
    const parsed = await parseImportTextInChunks(text, name, yieldToMain);
    links.push(...parsed.links);
    for (const [key, blob] of parsed.images) images.set(key, blob);
  }
  return { links, images };
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

// The zip dispatch: one unzip, one entry map. manifest.json marks a Bracemark
// backup (restored verbatim); any other zip is treated as a zipped interop
// export and its text entries become new links.
async function importZip(
  username: string,
  bytes: Uint8Array,
  maxLinks: number | null,
  onProgress: (progress: ImportProgress) => void,
  onQuotaPrompt?: ImportQuotaResolver,
): Promise<Omit<ImportOutcome, 'syncFailed'>> {
  const { unzipSync } = fflate();

  // fflate keys entries by filename; directory entries end with '/' and carry
  // no bytes — drop them so the map mirrors zip.js's file-only view.
  const unzipped = unzipSync(bytes);
  // WHOLE_FILE_STEPS: the decode that follows gets a task of its own.
  await yieldToMain();
  const byName = new Map<string, Uint8Array>(
    Object.entries(unzipped).filter(([name]) => !name.endsWith('/')),
  );

  if (byName.has(BACKUP_MANIFEST_ENTRY)) {
    return importBracemarkBackup(username, byName, maxLinks, onProgress);
  }
  const parsed = await parseInteropZip(byName);
  return importInterop(username, parsed, maxLinks, onProgress, onQuotaPrompt);
}

// --- the flow -----------------------------------------------------------------------

export async function importAllData(options: {
  file: PickedFile;
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
  const bytes = await new File(file.uri).bytes();
  if (isZipBytes(bytes)) {
    const outcome = await importZip(deps.username, bytes, maxLinks, onProgress, onQuotaPrompt);
    return { ...outcome, syncFailed };
  }

  const text = decodeUtf8(bytes);
  await yieldToMain(); // WHOLE_FILE_STEPS
  const parsed = await parseImportTextInChunks(text, file.name, yieldToMain);
  const outcome = await importInterop(deps.username, parsed, maxLinks, onProgress, onQuotaPrompt);
  return { ...outcome, syncFailed };
}
