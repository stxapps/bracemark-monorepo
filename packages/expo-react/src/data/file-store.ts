// The on-disk half of the expo local store: where decrypted `files/` CONTENT
// lives (db.ts header — file bytes never enter SQLite or the JS heap;
// BracemarkFileCrypto decrypts ciphertext path-to-path and expo-image renders the
// plaintext file:// URI directly). This module owns the directory, the
// path↔location mapping, and the raw file operations, so every consumer derives
// locations one way; the sync engine (sync/engine.ts) composes them into the
// materialize/upload pipelines.
//
// Locations are DERIVED, never persisted: iOS moves the app container between
// app updates, so a stored absolute file:// URI goes stale (db.ts). Only the
// relative layout below is stable.

import { Directory, File, Paths } from 'expo-file-system';

import { newId } from '@stxapps/expo-crypto';

// All plaintext blobs live under one directory in the app's document storage
// (survives relaunches; not the cache dir, which the OS may purge — a purge
// would silently re-break "already downloaded" bookkeeping in `items`).
const DATA_FILES_DIR = 'bracemark-files';

function dataFilesDir(): Directory {
  return new Directory(Paths.document, DATA_FILES_DIR);
}

// The on-disk location for an `items` path (`files/f_abc.enc`). Paths are flat
// random-id names within their namespace, so encoding the ONE separator keeps
// the mapping bijective without nested directories.
export function dataFileFor(path: string): File {
  return new File(dataFilesDir(), path.replaceAll('/', '%2F'));
}

// Make sure the blobs directory exists before a materialize writes into it —
// it's created lazily (first content download), and clearDataFiles removes it
// whole.
export function ensureDataFilesDir(): void {
  const dir = dataFilesDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

// Remove one path's decrypted blob, if materialized — the file half of dropping
// a content record (server delete, or a changed record invalidating the old
// bytes). Missing file is a no-op: a never-downloaded row has no file.
export function deleteDataFile(path: string): void {
  const file = dataFileFor(path);
  if (file.exists) file.delete();
}

export function deleteDataFiles(paths: string[]): void {
  for (const path of paths) deleteDataFile(path);
}

// A fresh scratch location for one in-transit CIPHERTEXT blob (downloaded .enc
// before native decrypt, or native encrypt output before upload). Lives in the
// cache dir on purpose — transient by definition, so an OS purge costs nothing —
// and uniquely named so concurrent transfers never collide. The caller deletes
// it when the transfer settles.
export function newTempEncFile(): File {
  return new File(Paths.cache, `bracemark-enc-${newId()}`);
}

// Remove every decrypted blob — the file-system half of the `items` wipe, called
// by clear-data (sign-out) and delete-all-data. Recursive delete of the whole
// directory; recreated lazily by the next materialize.
export function clearDataFiles(): void {
  const dir = dataFilesDir();
  if (dir.exists) dir.delete();
}
