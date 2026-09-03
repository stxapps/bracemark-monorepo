// Specs for the on-disk half of the expo local store — where decrypted `files/` CONTENT
// lives. This module owns three things nothing else may reinvent, and each has a distinct
// silent failure:
//
//   - THE PATH↔LOCATION MAPPING. `files/f_abc.enc` → one flat filename, with the ONE
//     separator encoded. It has to be BIJECTIVE: two paths landing on one filename means
//     one link's image silently overwrites another's, and the `items` bookkeeping still
//     says both are materialized.
//   - LOCATIONS ARE DERIVED, NEVER PERSISTED. iOS moves the app container between app
//     updates, so a stored absolute `file://` uri goes stale — the same path must resolve
//     the same way every time it is asked, from the path alone.
//   - THE GUARDED DELETES. The native API THROWS on deleting something that isn't there,
//     and a never-downloaded row legitimately has no file — so an unguarded delete turns
//     an ordinary teardown into a crash. The in-memory filesystem below reproduces that
//     strictness deliberately, which is what makes these assertions mean anything.
//
// Everything above the native seam is the real module; only expo-file-system is shimmed.

import { File, Paths } from 'expo-file-system';

import {
  clearDataFiles,
  dataFileFor,
  deleteDataFile,
  deleteDataFiles,
  ensureDataFilesDir,
  newTempEncFile,
} from './file-store';

jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => `id-${(counter += 1)}` }));

let counter = 0;

const { resetFileSystem, listFileUris } = require('../testing/memory-file-system') as {
  resetFileSystem: () => void;
  listFileUris: () => string[];
};

const PATH = 'files/f_abc.enc';
const OTHER_PATH = 'files/f_def.enc';

beforeEach(() => {
  counter = 0;
  resetFileSystem();
});

// Materialize a blob the way the engine does: make sure the directory exists, then write.
function materialize(path: string, contents = 'plaintext'): void {
  ensureDataFilesDir();
  dataFileFor(path).write(contents);
}

describe('dataFileFor', () => {
  // Derived, so the same path always resolves the same way — a stored uri would go stale
  // the first time iOS moved the container, and every "already downloaded" row would point at
  // nothing.
  it('resolves one path to one stable location', () => {
    expect(dataFileFor(PATH).uri).toBe(dataFileFor(PATH).uri);
  });

  // BIJECTIVE. Encoding the separator is what keeps the flat namespace collision-free; a
  // mapping that merely stripped it would land `files/f_a.enc` and `filesf_a.enc` on the
  // same file, and one link's image would silently become another's.
  it('maps distinct paths to distinct files', () => {
    expect(dataFileFor(PATH).uri).not.toBe(dataFileFor(OTHER_PATH).uri);
    expect(dataFileFor('files/f_a.enc').uri).not.toBe(dataFileFor('filesf_a.enc').uri);
  });

  // Flat names within one directory — no nested directories to create, which is why
  // `ensureDataFilesDir` only ever has to make one.
  it('keeps every blob in one flat directory', () => {
    materialize(PATH);
    materialize(OTHER_PATH);

    const parents = listFileUris().map((uri) => uri.slice(0, uri.lastIndexOf('/')));
    expect(new Set(parents).size).toBe(1);
  });

  // Document storage, not the cache directory: an OS purge of the cache would silently
  // break the "already downloaded" bookkeeping in `items`, leaving rows that claim a file
  // nothing can read.
  it('stores blobs in document storage, not the purgeable cache', () => {
    expect(dataFileFor(PATH).uri.startsWith(Paths.document.uri)).toBe(true);
    expect(dataFileFor(PATH).uri.startsWith(Paths.cache.uri)).toBe(false);
  });
});

describe('ensureDataFilesDir', () => {
  // The directory is created lazily (first content download) and removed whole by
  // clearDataFiles — so this runs both on a fresh device and on one that already has it,
  // and must be safe on each.
  it('creates the directory and is safe to call again', () => {
    expect(() => ensureDataFilesDir()).not.toThrow();
    expect(() => ensureDataFilesDir()).not.toThrow();

    materialize(PATH);
    expect(dataFileFor(PATH).exists).toBe(true);
  });

  // The shim throws on a write into a directory nobody created — as the native API does —
  // so this is the assertion that a materialize which forgets the ensure fails HERE rather
  // than on a device.
  it('is required before a blob can be written', () => {
    expect(() => dataFileFor(PATH).write('plaintext')).toThrow();
  });
});

describe('deleteDataFile', () => {
  it('removes a materialized blob', () => {
    materialize(PATH);

    deleteDataFile(PATH);

    expect(dataFileFor(PATH).exists).toBe(false);
  });

  // THE GUARD. A never-downloaded row has no file, and dropping such a record is routine
  // (a server delete, a changed record invalidating old bytes) — the native delete throws
  // on it, so without the existence check an ordinary teardown crashes.
  it('is a no-op for a path that was never downloaded', () => {
    expect(() => deleteDataFile(PATH)).not.toThrow();
  });

  it('touches only the path it was given', () => {
    materialize(PATH);
    materialize(OTHER_PATH);

    deleteDataFile(PATH);

    expect(dataFileFor(OTHER_PATH).exists).toBe(true);
  });
});

describe('deleteDataFiles', () => {
  // A pull applies many deletes at once, and only some of those paths were ever
  // materialized — so one missing file must not abandon the rest of the batch.
  it('deletes what exists and skips what does not, in one pass', () => {
    materialize(PATH);

    expect(() => deleteDataFiles([PATH, OTHER_PATH, 'files/f_never.enc'])).not.toThrow();
    expect(listFileUris()).toEqual([]);
  });
});

describe('newTempEncFile', () => {
  // Ciphertext in transit: transient by definition, so an OS purge costs nothing — and
  // deliberately NOT in the document directory, where a leaked one would persist forever
  // against the device's storage.
  it('lands in the purgeable cache, not in document storage', () => {
    expect(newTempEncFile().uri.startsWith(Paths.cache.uri)).toBe(true);
  });

  // Uniquely named, so concurrent transfers cannot collide — two uploads sharing a scratch
  // path would corrupt each other's bytes with nothing to indicate it.
  it('is unique per call', () => {
    expect(newTempEncFile().uri).not.toBe(newTempEncFile().uri);
  });
});

describe('clearDataFiles', () => {
  // The file-system half of the `items` wipe (sign-out, delete-all-data). It runs AFTER
  // the table delete, so it must tolerate a device that never downloaded anything — and it
  // must be recursive, or the wipe leaves every plaintext blob on disk.
  it('removes every decrypted blob', () => {
    materialize(PATH);
    materialize(OTHER_PATH);

    clearDataFiles();

    expect(listFileUris()).toEqual([]);
  });

  it('is safe on a device that never materialized anything', () => {
    expect(() => clearDataFiles()).not.toThrow();
  });

  // Recreated lazily by the next materialize — so a wipe followed by a sync has to work
  // without anything else re-creating the directory.
  it('leaves the directory recreatable by the next materialize', () => {
    materialize(PATH);
    clearDataFiles();

    materialize(PATH, 'fresh');

    expect(dataFileFor(PATH).exists).toBe(true);
  });

  // The scratch directory is a different lifecycle owner — an in-flight transfer's
  // ciphertext is not part of the decrypted-blob wipe.
  it('leaves the transfer scratch space alone', () => {
    const temp = new File(newTempEncFile().uri);
    temp.write('ciphertext');
    materialize(PATH);

    clearDataFiles();

    expect(temp.exists).toBe(true);
  });
});
