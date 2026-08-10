// The bracemark-backup archive contract — the ONE definition of the re-importable
// zip both platforms write (the export orchestrators' `bracemark` format) and read
// back (the import orchestrators' Bracemark-backup branch). Pure: no store, no zip
// library, no React — a caller brings its own zip writer/reader (zip.js on web,
// fflate on expo) and its own store, and uses these to agree on what goes in
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
import {
  ENC_SUFFIX,
  EXTRACTIONS_PREFIX,
  LINKS_PREFIX,
  LISTS_PREFIX,
  PINS_PREFIX,
  SETTINGS_GENERAL_PATH,
  TAGS_PREFIX,
} from '../sync/paths';

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

export interface BackupManifest {
  format: string;
  version: number;
  exportedAt: number;
  counts: BackupCounts;
}

// The manifest.json text, formatting included — one definition so the two
// exporters can't drift on the bytes.
export function serializeBackupManifest(counts: BackupCounts): string {
  const manifest: BackupManifest = {
    format: BRACEMARK_BACKUP_FORMAT,
    version: BRACEMARK_BACKUP_VERSION,
    exportedAt: Date.now(),
    counts,
  };
  return JSON.stringify(manifest, null, 2);
}

// Read + gate the manifest. Throws with the USER-FACING message the import view
// renders verbatim — the three rejections are: not JSON, not our format, and
// written by a newer app than this one (a version we can't promise to read).
export function parseBackupManifest(text: string): BackupManifest {
  let manifest: { format?: unknown; version?: unknown; exportedAt?: unknown; counts?: unknown };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    throw new Error('This zip is not a Bracemark backup (unreadable manifest).');
  }
  if (manifest.format !== BRACEMARK_BACKUP_FORMAT) {
    throw new Error('This zip is not a Bracemark backup (unrecognized format).');
  }
  if (typeof manifest.version !== 'number' || manifest.version > BRACEMARK_BACKUP_VERSION) {
    throw new Error(
      'This backup was created by a newer version of Bracemark. Update the app and try again.',
    );
  }
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
    return { path, data, kind: 'settings' };
  }
  for (const { prefix, schema, kind } of BUNDLE_NAMESPACES) {
    if (!path.startsWith(prefix)) continue;
    // The id between prefix and `.enc` must be a plain token — a malformed path
    // would poison the store/R2 key space.
    const id = path.slice(prefix.length, path.length - ENC_SUFFIX.length);
    if (!path.endsWith(ENC_SUFFIX) || id === '' || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
    if (!schema.safeParse(data).success) return undefined;
    return { path, data, kind };
  }
  return undefined;
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
      const { imageId, pageCopyId, screenshotId } = entry.data as Extraction;
      if (imageId !== undefined) ids.add(imageId);
      if (pageCopyId !== undefined) ids.add(pageCopyId);
      if (screenshotId !== undefined) ids.add(screenshotId);
    }
  }
  return ids;
}
