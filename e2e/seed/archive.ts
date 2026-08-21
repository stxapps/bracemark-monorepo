import { zipSync } from 'fflate';

import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  jsonlLine,
  serializeBackupItems,
  serializeBackupManifest,
} from '@stxapps/shared';

import type { SeedLibrary } from './library';

// A generated library → a real Bracemark backup archive.
//
// Every structural decision here is deferred to `@stxapps/shared`'s `data/backup.ts`
// — the entry names, the manifest, the items.jsonl line shape — because that
// module is the ONE definition both platforms' exporters write and both
// importers read (docs/data-lifecycle.md). Re-spelling `{"path":…,"data":…}` here
// would produce archives that pass every check in this repo and are read wrong by
// the app the moment the format version moves.
//
// That is the deliberate exception to e2e's "shared for addressing, never for
// expectations" rule (docs/e2e.md, _the module boundary_), and it is not really an
// exception at all: this file asserts nothing. It is a WRITER, standing in for the
// export half of a round trip the app performs on itself, and a writer that
// invented its own format would be testing nothing.
//
// fflate is bracemark-expo's zipper (packages/expo-react `data/export-all-data.ts`),
// picked here for the same reason it was picked there — it is the pure-JS one that
// runs anywhere — and its zip32 ceilings (65,535 entries, 4 GiB) are nowhere near
// a seed: the entry count is 2 + one per preview image.
export function buildBackupArchive(library: SeedLibrary): Uint8Array {
  const encoder = new TextEncoder();

  const entries: Record<string, Uint8Array> = {
    [BACKUP_MANIFEST_ENTRY]: encoder.encode(serializeBackupManifest(library.counts)),
    [BACKUP_ITEMS_ENTRY]: encoder.encode(
      serializeBackupItems(library.items.map((item) => jsonlLine(item.path, item.data))),
    ),
  };
  for (const file of library.files) {
    entries[backupFileEntry(file.id)] = file.bytes;
  }

  // level 6 rather than fflate's default 9: items.jsonl is the only large entry
  // and it is highly repetitive JSON, so the last two levels buy almost nothing
  // and cost noticeable seconds on a thousand-link library.
  return zipSync(entries, { level: 6 });
}
