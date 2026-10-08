// Specs for the cache dir's plaintext (cache-files.ts). Everything here is a file some
// OTHER reader needed for a moment — the share sheet, the import orchestrator, the image
// editor — parked where the OS only cleans up under storage pressure. So the failure this
// guards is always the same shape and always silent: the work succeeds, the receipt is
// right, and a readable copy of the account's data stays on the device after the account
// has left it.
//
// The one assertion with teeth in the other direction is `deletePickedCopy`'s refusal:
// it is handed a uri by its caller, and outside the cache dir that uri is the user's own
// file.

import {
  Directory,
  File,
  listFileUris,
  Paths,
  resetFileSystem,
  writeFileText,
} from '../testing/memory-file-system';
import { clearCacheFiles, clearExportFiles, deletePickedCopy, newExportFile } from './cache-files';

jest.mock('expo-file-system', () => require('../testing/memory-file-system'));

// A file the way a native module leaves one: its directory made for it.
function park(dir: string, name: string): string {
  new Directory(Paths.cache, dir).create({ intermediates: true, idempotent: true });
  const uri = `${Paths.cache.uri}/${dir}/${name}`;
  writeFileText(uri, 'plaintext');
  return uri;
}

beforeEach(() => {
  resetFileSystem();
});

describe('newExportFile', () => {
  it('hands the run a location under the cache dir, where the share sheet can reach it', () => {
    const file = newExportFile('Bracemark backup 2026-01-01.zip');

    expect(file.uri).toBe('file:///cache/bracemark-exports/Bracemark backup 2026-01-01.zip');
    // The directory exists, so the run's write does not depend on `intermediates`.
    file.write('zip');
    expect(listFileUris()).toEqual([file.uri]);
  });

  // The previous file has no receipt left to offer it from, and its name carries the
  // date, so nothing would ever overwrite it: a run a day would be a library a day.
  it("removes the previous run's file first", () => {
    newExportFile('Bracemark backup 2026-01-01.zip').write('old');

    const next = newExportFile('Bracemark backup 2026-01-02.zip');
    next.write('new');

    expect(listFileUris()).toEqual([next.uri]);
  });
});

describe('deletePickedCopy', () => {
  it('removes a copy the picker made in the cache dir', () => {
    const uri = park('DocumentPicker', 'bookmarks.html');

    deletePickedCopy(uri);

    expect(listFileUris()).toEqual([]);
  });

  // With `copyToCacheDirectory` off — or a picker that one day returns the original — the
  // uri names the user's own file. Deleting it would be the import destroying its source.
  it('leaves a file outside the cache dir alone', () => {
    new Directory(Paths.document, 'Downloads').create({ intermediates: true });
    const uri = `${Paths.document.uri}/Downloads/bookmarks.html`;
    writeFileText(uri, "the user's own file");

    deletePickedCopy(uri);

    expect(new File(uri).exists).toBe(true);
  });

  // A sibling whose name merely STARTS with the cache dir's is not inside it.
  it('does not mistake a sibling directory for the cache dir', () => {
    new Directory('file:///cache-backup').create();
    const uri = 'file:///cache-backup/bookmarks.html';
    writeFileText(uri, 'not ours');

    deletePickedCopy(uri);

    expect(new File(uri).exists).toBe(true);
  });

  // Runs from a `finally`: a copy that is already gone (the sweep got there first, the
  // OS purged it) must not turn a finished import into a failed one.
  it('is quiet about a copy that is already gone', () => {
    expect(() => deletePickedCopy('file:///cache/DocumentPicker/gone.html')).not.toThrow();
  });
});

describe('clearCacheFiles', () => {
  it('removes the export and everything the pickers left', () => {
    newExportFile('Bracemark backup 2026-01-01.zip').write('zip');
    park('DocumentPicker', 'bookmarks.html');
    park('ImagePicker', 'photo.jpg');
    park('ImageManipulator', 'resized.jpg');

    clearCacheFiles();

    expect(listFileUris()).toEqual([]);
  });

  // The cache dir is shared with every module in the app. This sweeps the directories
  // named in cache-files.ts and nothing else.
  it('leaves the rest of the cache dir alone', () => {
    const scratch = `${Paths.cache.uri}/bracemark-enc-1`;
    writeFileText(scratch, 'ciphertext in transit');
    const theirs = park('SomeOtherModule', 'state.bin');

    clearCacheFiles();

    expect(listFileUris()).toEqual([theirs, scratch].sort());
  });

  // The native delete throws on a directory that was never created, and this runs on
  // every sign-out — including the first one on a device that never exported anything.
  it('is safe when none of it exists', () => {
    expect(() => clearCacheFiles()).not.toThrow();
    expect(() => clearExportFiles()).not.toThrow();
  });
});
