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
//   - an EXTRACTION's in-transit image (lib/device-extraction.ts): the preview a
//     saved page declares, parked for the native decoders to measure and resize.
//     The worker deletes it when the write settles, but a process killed before
//     then leaves it — so it is written under a directory of ours rather than
//     loose in the cache dir, where nothing could find it again.
//
// One thing here is NOT plaintext: the sync plane's in-transit ciphertext
// (file-store.ts, `newTempEncFile`) shares the extraction's scratch directory.
// Its leftover is unreadable, so the sweep owes it nothing — it is there so that
// everything this app names in the cache dir is in a directory this file lists.

import { Directory, File, Paths } from 'expo-file-system';

import { newId } from '@stxapps/expo-crypto/lib/ids';

// Ours, so an export can be found again without knowing its name (it carries
// the date). Still under the cache dir: expo-sharing's FileProvider grants the
// whole of it, subdirectories included.
const EXPORT_FILES_DIR = 'bracemark-exports';

// Ours too: where a file sits while the operation that made it is still
// working on it. A directory rather than a name prefix in the cache dir itself,
// so the sweep takes what a killed process left without listing a directory it
// shares with every module in the app.
const SCRATCH_FILES_DIR = 'bracemark-scratch';

// NOT ours: the directory each expo module writes its output into, under the
// cache dir, on both platforms. The names are those modules' own (read from
// their native sources), so an upgrade can move one — which would fail quietly,
// as a directory that is no longer there to delete. The import's copy does not
// depend on this (deletePickedCopy below takes the uri it was handed).
// warnIfNotSwept below is what makes a moved one loud, in a dev build.
const PICKER_DIRS = ['DocumentPicker', 'ImagePicker', 'ImageManipulator'];

function exportFilesDir(): Directory {
  return new Directory(Paths.cache, EXPORT_FILES_DIR);
}

function scratchFilesDir(): Directory {
  return new Directory(Paths.cache, SCRATCH_FILES_DIR);
}

// Every directory clearCacheFiles deletes.
function sweptDirs(): Directory[] {
  return [
    exportFilesDir(),
    scratchFilesDir(),
    ...PICKER_DIRS.map((d) => new Directory(Paths.cache, d)),
  ];
}

// INSIDE `dir` — not a sibling whose name merely starts with its name.
function isInside(uri: string, dir: Directory): boolean {
  return uri.startsWith(`${dir.uri.replace(/\/+$/, '')}/`);
}

// Each run gets its own directory, preserving the share sheet's readable name
// even for two exports with the same date and format. Allocating a replacement
// must not remove the last successful backup: this run can still fail to gather,
// exceed zip32's ceilings, or run out of disk while writing.
export function newExportFile(filename: string): File {
  const dir = new Directory(exportFilesDir(), newId());
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, filename);
}

// Called only after the new file has been written successfully. The previous
// run and any interrupted attempts can now go; a cleanup failure must not cost
// the completed export. Sign-out still sweeps the entire parent directory.
export function finishExportFile(file: File): void {
  const keptDir = file.parentDirectory.uri;
  try {
    for (const entry of exportFilesDir().list()) {
      if (entry.uri === keptDir) continue;
      try {
        entry.delete();
      } catch {
        /* Retried by the next export or sign-out. */
      }
    }
  } catch {
    // Best-effort pruning, not a reason to report a finished export as failed.
  }
}

// Where one operation parks a file it is still working on. The caller names
// it — uniquely, since runs are pooled — and deletes it when it settles; what a
// killed process leaves is clearCacheFiles'. The directory is made on every
// call: an OS purge, or the sweep, may have taken it since the last one.
export function newScratchFile(name: string): File {
  scratchFilesDir().create({ intermediates: true, idempotent: true });
  return new File(scratchFilesDir(), name);
}

// Drop the picker's copy of a file once it has been read. Only ever a file
// INSIDE the cache dir: the uri comes from the caller, and with
// `copyToCacheDirectory` off — or a picker that one day hands back the original
// — it would name the user's own file. Never throws; a leftover is the sweep's.
export function deletePickedCopy(uri: string): void {
  try {
    if (!isInside(uri, Paths.cache)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // clearCacheFiles removes it at sign-out.
  }
}

// Everything above, at once — the cache-dir member of the sign-out wipe
// (clear-data.ts). Each directory on its own, so one that will not delete does
// not keep the others.
export function clearCacheFiles(): void {
  for (const dir of sweptDirs()) {
    try {
      if (dir.exists) dir.delete();
    } catch {
      // The OS purge is the backstop it always was.
    }
  }
}

// DEV BUILDS ONLY — PICKER_DIRS' quiet failure, made loud. Called with each uri
// a picker or the manipulator hands back, at the moment it does: a file that is
// not inside a directory the sweep deletes is what a renamed module directory
// looks like from here, and nothing else reports it — the sweep deletes a
// directory that is not there and succeeds. It checks the list against what the
// modules really wrote; it cannot find a writer that never hands us a uri.
// Never throws: a diagnostic must not cost a pick.
export function warnIfNotSwept(uri: string, from: string): void {
  if (!__DEV__) return;
  try {
    if (sweptDirs().some((dir) => isInside(uri, dir))) return;
  } catch {
    return;
  }
  console.warn(
    `[cache-files] ${from} handed back ${uri}, which the sign-out sweep does not delete. ` +
      'An upgrade may have moved its directory: re-read PICKER_DIRS (data/cache-files.ts).',
  );
}
