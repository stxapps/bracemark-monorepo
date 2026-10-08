// The plaintext this app leaves in the OS CACHE directory, and the one place
// that removes it. The cache dir is where a file goes when it only has to live
// until something else has read it — which makes it easy to write and easy to
// forget: nothing here is in sqlite, none of it is under `bracemark-files/`, so
// neither the table wipe nor clearDataFiles reaches it, and the OS purges the
// directory only under storage pressure. Until then each of these is a readable
// copy of the account's data on a device it has signed out of:
//
//   - the EXPORT (export-all-data.ts): the whole library in one file, images
//     included for a Bracemark backup. It has to outlive the run — the share
//     sheet reads it, and so does whichever app the user sends it to, after we
//     have stopped watching — so nothing can delete it when the run settles.
//   - the IMPORT's picked file: expo-document-picker copies it in
//     (`copyToCacheDirectory`) so the orchestrator can read a plain file:// uri.
//   - a CUSTOM IMAGE's picked file and its resized copy (expo-image-picker,
//     expo-image-manipulator). Kept until sign-out rather than deleted once
//     stored: the editor's draft still points at the uri, and a save that
//     failed after the copy retries from it.
//
// The scratch files file-store.ts and device-extraction.ts make here are not
// this module's: each is deleted by the transfer that made it.

import { Directory, File, Paths } from 'expo-file-system';

// Ours, so an export can be found again without knowing its name (it carries
// the date). Still under the cache dir: expo-sharing's FileProvider grants the
// whole of it, subdirectories included.
const EXPORT_FILES_DIR = 'bracemark-exports';

// NOT ours: the directory each expo module writes its output into, under the
// cache dir, on both platforms. The names are those modules' own (read from
// their native sources), so an upgrade can move one — which would fail quietly,
// as a directory that is no longer there to delete. The import's copy does not
// depend on this (deletePickedCopy below takes the uri it was handed).
const PICKER_DIRS = ['DocumentPicker', 'ImagePicker', 'ImageManipulator'];

function exportFilesDir(): Directory {
  return new Directory(Paths.cache, EXPORT_FILES_DIR);
}

// Where one export run writes. Clears the directory first: the previous run's
// file has no receipt left to offer it from, and a run a day is otherwise a
// library a day.
export function newExportFile(filename: string): File {
  clearExportFiles();
  exportFilesDir().create({ intermediates: true, idempotent: true });
  return new File(exportFilesDir(), filename);
}

export function clearExportFiles(): void {
  const dir = exportFilesDir();
  if (dir.exists) dir.delete();
}

// Drop the picker's copy of a file once it has been read. Only ever a file
// INSIDE the cache dir: the uri comes from the caller, and with
// `copyToCacheDirectory` off — or a picker that one day hands back the original
// — it would name the user's own file. Never throws; a leftover is the sweep's.
export function deletePickedCopy(uri: string): void {
  try {
    if (!uri.startsWith(`${Paths.cache.uri.replace(/\/+$/, '')}/`)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // clearCacheFiles removes it at sign-out.
  }
}

// Everything above, at once — the cache-dir member of the sign-out wipe
// (clear-data.ts) and of delete-all-data. Each directory on its own, so one
// that will not delete does not keep the others.
export function clearCacheFiles(): void {
  for (const dir of [exportFilesDir(), ...PICKER_DIRS.map((d) => new Directory(Paths.cache, d))]) {
    try {
      if (dir.exists) dir.delete();
    } catch {
      // The OS purge is the backstop it always was.
    }
  }
}
