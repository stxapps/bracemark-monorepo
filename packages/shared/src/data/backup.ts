// The bracemark-backup archive contract — the ONE definition of the re-importable
// zip both platforms write (the export orchestrators' `bracemark` format) and read
// back (the import orchestrators' Bracemark-backup branch) — and that the
// marketing site's bookmark converter also reads, never writes. Pure: no store,
// no zip library, no React — a caller brings its own zip writer/reader (zip.js on
// web, fflate on expo) and its own store, and uses these to agree on what goes in
// the archive and what a line of it means.
//
// It lives in `data/` — the data-lifecycle namespace beside endpoints.ts (see
// docs/data-lifecycle.md), NOT in `export/` or `import/`: those two are the
// INTEROP namespaces (netscape/csv/text), and both of their bundle.ts headers
// say in so many words that the Bracemark-backup zip does not go through them. A
// round-trip contract is jointly owned by the writer and the reader, so it
// can't live under either direction's roof — and it must be single-sourced
// across PLATFORMS above all: a version bump landing on web alone would
// otherwise produce archives expo's importer accepts and misreads, which is
// exactly the round-trip (export on web, restore on mobile) the format exists
// for.
//
// The archive layout, v1:
//
//   manifest.json   format/version/exportedAt/counts — the dispatch key
//   items.jsonl     one {path, data} JSON object per line: the raw entity
//                   plaintext under its items/R2 path, restored verbatim
//   files/{id}      the raw decrypted blob bytes for each referenced media id
//                   (note: NO `.enc` suffix — the zip holds plaintext)

import { isCalendarTime } from '../sync/calendar-time';
import {
  type Extraction,
  extractionSchema,
  type Link,
  linkSchema,
  listSchema,
  pinSchema,
  settingsGeneralSchema,
  tagSchema,
} from '../sync/entities';
import { extractionFileIds } from '../sync/extraction';
import {
  ENC_SUFFIX,
  EXTRACTIONS_PREFIX,
  idFromPath,
  isPathId,
  LINKS_PREFIX,
  LISTS_PREFIX,
  PINS_PREFIX,
  SETTINGS_GENERAL_PATH,
  TAGS_PREFIX,
} from '../sync/paths';
import {
  LIST_NO_CHILDREN_IDS,
  RESERVED_LIST_IDS,
  SYSTEM_LIST_DEFAULTS,
} from '../sync/system-lists';
import { buildTree, parentsPastMaxDepth, type TreeItem } from '../sync/tree';

// The manifest's format/version contract — the import side's dispatch key. Bump
// `version` (and keep reading old ones) on any breaking change to the zip
// layout or the items.jsonl line shape, and bump it for BOTH platforms at once
// — that's what this file being shared buys.
export const BRACEMARK_BACKUP_FORMAT = 'bracemark-backup';
export const BRACEMARK_BACKUP_VERSION = 1;

// The fixed archive entry names. `files/{id}` entries are built with
// backupFileEntry below.
export const BACKUP_MANIFEST_ENTRY = 'manifest.json';
export const BACKUP_ITEMS_ENTRY = 'items.jsonl';
export const BACKUP_FILES_DIR = 'files/';

// The archive entry for one `files/{id}.enc` blob — id only, no suffix: what
// the zip carries is the DECRYPTED bytes, so `.enc` would be a lie.
export function backupFileEntry(id: string): string {
  return `${BACKUP_FILES_DIR}${id}`;
}

// Informational only — nothing reads these back on import (the entities in
// items.jsonl are the truth). They're for the user eyeballing the manifest and
// for a future importer that wants to show "restoring N links" before it
// starts.
export interface BackupCounts {
  links: number;
  lists: number;
  tags: number;
  pins: number;
  extractions: number;
  files: number;
}

// What the exporter meant to include and couldn't — informational like
// `counts`, and the archive's own record of being partial, since the receipt
// that said so is gone once the file is saved. `files`: referenced blobs left
// out (missing or failed to download); `unreadable`: stored records that
// didn't decode. Optional in the manifest: an archive from before it carries
// none, and a reader must not take that for "nothing was left out".
export interface BackupOmitted {
  files: number;
  unreadable: number;
}

export interface BackupManifest {
  format: string;
  version: number;
  exportedAt: number;
  counts: BackupCounts;
  omitted?: BackupOmitted;
}

// The manifest.json text, formatting included — one definition so the two
// exporters can't drift on the bytes.
export function serializeBackupManifest(counts: BackupCounts, omitted?: BackupOmitted): string {
  const manifest: BackupManifest = {
    format: BRACEMARK_BACKUP_FORMAT,
    version: BRACEMARK_BACKUP_VERSION,
    exportedAt: Date.now(),
    counts,
    ...(omitted === undefined ? {} : { omitted }),
  };
  return JSON.stringify(manifest, null, 2);
}

// The one manifest rejection the user can act on, by updating. A class of its own
// so a reader that isn't the app — the marketing site's bookmark converter, which
// has no app to update — can catch it and say so in its own words.
export class BackupVersionError extends Error {
  constructor() {
    super('This backup was created by a newer version of Bracemark. Update the app and try again.');
    this.name = 'BackupVersionError';
  }
}

// Read + gate the manifest. Throws with the USER-FACING message the import view
// renders verbatim. Four rejections: not JSON (or not an object), not our
// format, a damaged `version`, and written by a newer app than this one (a
// version we can't promise to read). Only the LAST is something the user can act
// on, which is why it gets its own sentence and the other three share the
// `not a Bracemark backup (…)` family — the same family both importers use for
// a missing manifest.json.
export function parseBackupManifest(text: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This zip isn’t a Bracemark backup (unreadable manifest).');
  }
  // JSON.parse SUCCEEDS on `null` and on any bare scalar, and reading `.format`
  // off null throws — a raw TypeError escaping the one function whose whole job
  // is to produce the message the import view renders verbatim.
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('This zip isn’t a Bracemark backup (unreadable manifest).');
  }
  const manifest = parsed as {
    format?: unknown;
    version?: unknown;
    exportedAt?: unknown;
    counts?: unknown;
  };
  if (manifest.format !== BRACEMARK_BACKUP_FORMAT) {
    throw new Error('This zip isn’t a Bracemark backup (unrecognized format).');
  }
  // A `version` that is not a number at all means the manifest is DAMAGED —
  // truncated, hand-edited, or written by something that isn't us despite the
  // matching format. That is not the same as a backup from a newer app, and
  // folding the two together told the user to "update the app and try again",
  // which no update can fix. (JSON cannot carry NaN or Infinity, so a numeric
  // `version` here is always a real number.)
  if (typeof manifest.version !== 'number') {
    throw new Error('This zip isn’t a Bracemark backup (invalid manifest version).');
  }
  // Older versions stay readable on purpose — the gate is one-sided.
  if (manifest.version > BRACEMARK_BACKUP_VERSION) throw new BackupVersionError();
  return manifest as BackupManifest;
}

// One items.jsonl line — the raw storage contract: the entity's plaintext under
// its items/R2 path, exactly what classifyBundleLine reads back.
export function jsonlLine(path: string, data: unknown): string {
  return JSON.stringify({ path, data });
}

// The whole items.jsonl body from its lines (trailing newline when non-empty).
export function serializeBackupItems(lines: string[]): string {
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

// --- reading items.jsonl -------------------------------------------------------

export type BundleEntryKind = 'link' | 'list' | 'tag' | 'pin' | 'extraction' | 'settings';

// One items.jsonl line, classified. The schema gate mirrors the read layer's:
// an entity that wouldn't decode there doesn't get imported here.
export interface BundleEntry {
  path: string;
  data: object;
  kind: BundleEntryKind;
}

const BUNDLE_NAMESPACES = [
  { prefix: LINKS_PREFIX, schema: linkSchema, kind: 'link' as const },
  { prefix: LISTS_PREFIX, schema: listSchema, kind: 'list' as const },
  { prefix: TAGS_PREFIX, schema: tagSchema, kind: 'tag' as const },
  { prefix: PINS_PREFIX, schema: pinSchema, kind: 'pin' as const },
  { prefix: EXTRACTIONS_PREFIX, schema: extractionSchema, kind: 'extraction' as const },
];

// Whether every clock a line carries is an instant the calendar can name
// (sync/calendar-time.ts). The schemas above ask only for an integer, and they
// have to keep asking only that: they also decode what is already stored. Every
// kind has the two entity clocks; an extraction has one more PER FACET —
// `facets.<name>.extractedAt`, the time retries are scheduled from — which is
// where the schema defines it, not on the extraction itself.
function hasCalendarTimes(data: object, kind: BundleEntryKind): boolean {
  const { createdAt, updatedAt } = data as { createdAt: number; updatedAt: number };
  if (!isCalendarTime(createdAt) || !isCalendarTime(updatedAt)) return false;
  if (kind !== 'extraction') return true;
  // Read off the RAW line, so every value is tested for being a number first.
  // The schema has vouched for the facets it knows — but it parses this record
  // key by key and skips one named `__proto__`, which JSON.parse creates as an
  // ordinary own property, so `Object.values` can hand back something no schema
  // ever looked at. Passing that to `Date` unguarded can throw, and a line that
  // throws here fails the whole restore instead of being counted.
  for (const facet of Object.values((data as { facets: Record<string, unknown> }).facets)) {
    if (typeof facet !== 'object' || facet === null) continue;
    const { extractedAt } = facet as { extractedAt?: unknown };
    if (typeof extractedAt === 'number' && !isCalendarTime(extractedAt)) return false;
  }
  return true;
}

// Parse and validate one line; `undefined` means "invalid" — the caller counts
// it and carries on (a bad line is reported, never fatal).
export function classifyBundleLine(line: string): BundleEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { path, data } = parsed as { path?: unknown; data?: unknown };
  if (typeof path !== 'string' || typeof data !== 'object' || data === null) return undefined;

  if (path === SETTINGS_GENERAL_PATH) {
    if (!settingsGeneralSchema.safeParse(data).success) return undefined;
    // The same two clocks as every entity below, under the same rule.
    if (!hasCalendarTimes(data, 'settings')) return undefined;
    return { path, data, kind: 'settings' };
  }
  for (const { prefix, schema, kind } of BUNDLE_NAMESPACES) {
    if (!path.startsWith(prefix)) continue;
    // The id between prefix and `.enc` must be a plain token — a malformed path
    // would poison the store/R2 key space.
    const id = path.slice(prefix.length, path.length - ENC_SUFFIX.length);
    if (!path.endsWith(ENC_SUFFIX) || !isPathId(id)) return undefined;
    if (!schema.safeParse(data).success) return undefined;
    // A list or tag whose own `id` is not its path's. The path is the identity
    // (sync/paths.ts, idFromPath) and the read edges go by it, so the copy inside
    // is only ever a restatement — and one that disagrees is a record saying it
    // is a different list from the one it is stored as: a second claim on an id
    // another line holds, or on a system list's. Refused, never rewritten, like
    // everything else here. No writer in this app builds a list's or tag's path
    // from anything but its id, so a backup this app wrote carries one only if
    // the library it was exported from already held it — the export is verbatim.
    // A pin restates its link's id the same way (`pins/{linkId}.enc`), and is
    // refused on the same terms.
    if (
      (kind === 'list' || kind === 'tag' || kind === 'pin') &&
      (data as { id: string }).id !== id
    ) {
      return undefined;
    }
    // A list at an id that already means something else — Show All, or the app
    // lock's row in the lock table list locks share (RESERVED_LIST_IDS,
    // sync/system-lists.ts). No writer in this app stores one, so a backup it
    // wrote carries one only if the library already held it — the export is
    // verbatim — and the read edge drops it there too.
    if (kind === 'list' && RESERVED_LIST_IDS.has(id)) return undefined;
    // A date outside the calendar is refused here for the reason an id outside
    // the path grammar is refused below: this is the one edge where the value
    // comes from a file rather than from this app, and once stored it is
    // everyone's problem — every device it syncs to, and every reader that turns
    // it into a calendar string. Refused, never re-dated: a restore promises the
    // admitted values verbatim, and a backup whose link came back dated today
    // would not be one. A backup this app wrote carries such a value only if the
    // library it was exported from already held one — the export is verbatim too.
    if (!hasCalendarTimes(data, kind)) return undefined;
    const entry: BundleEntry = { path, data, kind };
    // The same gate for the ids INSIDE the data. A link's or an extraction's file
    // refs become `files/{id}.enc` paths without ever passing the check above:
    // when the restore writes their blobs, and again whenever a later edit deletes
    // one. The entity schemas leave them free strings on purpose — those schemas
    // also decode what is already stored, and tightening them there would turn an
    // old record unreadable — so this edge is the one place an outside id is
    // tested. One that can't form a sync path is an op no client can send, and the
    // push carrying it fails on every cycle after. Asked of referencedFileIds, so
    // the ids gated are by construction the ids a restore turns into paths. The
    // LINE is refused, not the ref stripped: a restore is verbatim or it is not a
    // restore, and a link refused here takes its pin and extraction with it (the
    // importers drop a satellite whose link is in neither the archive nor the
    // library).
    for (const fileId of referencedFileIds([entry])) {
      if (!isPathId(fileId)) return undefined;
    }
    return entry;
  }
  return undefined;
}

// --- the depth rule ------------------------------------------------------------

// A backup restores `parentId` verbatim, so without a bound the file decides how
// deep this library's list tree is. A list or tag line deeper than
// TREE_MAX_DEPTH (sync/tree.ts) is therefore restored AT that level: its
// `parentId` becomes its ancestor on the level above, so it sits beside that
// ancestor's other children, under its own name and with its own links, and
// its descendants follow it there (parentsPastMaxDepth). Only the nesting below
// the limit is lost. Every other line but a loop's cut (below), and every
// other field of a moved one, is restored as written. The paths of the lines it moved come back so the
// restore can count the ones it wrote.
//
// It used to refuse the whole file. But a backup is the user's own library —
// the editors had no depth limit then, and sync can still deliver a chain past
// it — so the refusal fell on the one copy they had, at the moment they
// needed it, sometimes after the account it came from was gone. Dropping the
// deep lines instead would leave links filed under lists the restore never
// made; moving them up loses neither (docs/data-limits.md).
//
// Measured inside the file, with the system lists' defaults standing in for any
// the file doesn't carry: a parent the file doesn't hold (a list only the
// library holds) ends a chain, so the bound is per file, not per library. A
// restore can hang a chain under a deep list the library already holds, and a
// list the library already holds keeps its stored parent whatever the file's
// line says. Tags are held to it too — a tag tree is built by the same
// buildTree.
//
// The tree is built by buildTree, the read edge's own, so a `parentId` loop is
// cut where every device will cut it — and the cut is STORED: each line the cut
// detached is restored with `parentId: null`, which is where every device
// already shows it. Measured as cut but stored as written, the loop's edges
// stayed in the library, and the lists hanging off it with them: one edit that
// gave a loop member a parent outside the loop (a Move up on its row writes its
// effective parent) joined every one of those chains into one, as deep as the
// file was long, past a rule that had placed nothing. A backup this app writes
// can hold a loop — the export is verbatim, and two devices' moves can meet in
// one — so this is not only a hand-made file's case. A cut line is not counted
// as placed: nothing about where it shows has changed.
export function flattenBackupTree(entries: readonly BundleEntry[]): {
  entries: BundleEntry[];
  flattenedPaths: Set<string>;
} {
  const parentByPath = new Map<string, string | null>();
  const flattenedPaths = new Set<string>();
  for (const { kind, prefix, noChildrenIds } of [
    { kind: 'list', prefix: LISTS_PREFIX, noChildrenIds: LIST_NO_CHILDREN_IDS },
    { kind: 'tag', prefix: TAGS_PREFIX, noChildrenIds: NO_IDS },
  ] as const) {
    const items: (TreeItem & { path?: string })[] = [];
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== kind) continue;
      const { parentId, rank } = entry.data as { parentId: string | null; rank: string };
      const id = idFromPath(entry.path, prefix);
      ids.add(id);
      items.push({ id, parentId, rank, path: entry.path });
    }
    if (kind === 'list') {
      for (const { id, parentId, rank } of SYSTEM_LIST_DEFAULTS) {
        if (!ids.has(id)) items.push({ id, parentId, rank });
      }
    }
    const tree = buildTree(items, { noChildrenIds });
    // A root whose parent is held and may hold children is one the loop cut
    // made a root: a missing or a no-children parent is the only other way.
    const held = new Set(items.map((item) => item.id));
    for (const { item } of tree) {
      const { parentId, path } = item;
      if (parentId === null || path === undefined) continue;
      if (held.has(parentId) && !noChildrenIds.has(parentId)) parentByPath.set(path, null);
    }
    const parents = parentsPastMaxDepth(tree);
    if (parents.size === 0) continue;
    for (const item of items) {
      const parentId = parents.get(item.id);
      if (parentId !== undefined && item.path !== undefined) {
        parentByPath.set(item.path, parentId);
        flattenedPaths.add(item.path);
      }
    }
  }
  return {
    entries: entries.map((entry) => {
      if (!parentByPath.has(entry.path)) return entry;
      const parentId = parentByPath.get(entry.path) ?? null;
      return { ...entry, data: { ...entry.data, parentId } };
    }),
    flattenedPaths,
  };
}

const NO_IDS: ReadonlySet<string> = new Set();

// A backup this app writes holds each path once. A file that repeats one is
// restored from its FIRST line, and only that line goes on: the restore's later
// steps each see one line per path. Without this the depth rule measured the
// last line (a Map keeps the last set) while the writer kept the first wherever
// the repeat fell in a later chunk (it skips a path an earlier chunk wrote;
// within one chunk the last won) — so a file whose deep chain was repeated
// further down as roots passed the rule and stored the chain. Run before
// flattenBackupTree, by both restore orchestrators, so the tree it measures is
// the lines that will be written; a dropped repeat counts as skipped.
export function firstLinePerPath(entries: readonly BundleEntry[]): BundleEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

// Every `files/{id}` blob the given links/extractions reference —
// referenced-only, the read mirror of the exporter's referencedFilePaths, so
// orphaned blobs never travel in either direction.
export function referencedFileIds(entries: BundleEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'link') {
      const { customImageId } = entry.data as Link;
      if (customImageId !== undefined) ids.add(customImageId);
    } else if (entry.kind === 'extraction') {
      for (const id of extractionFileIds(entry.data as Extraction)) ids.add(id);
    }
  }
  return ids;
}
