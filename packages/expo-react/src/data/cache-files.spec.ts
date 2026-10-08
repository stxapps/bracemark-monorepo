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
import {
  clearCacheFiles,
  deletePickedCopy,
  finishExportFile,
  newExportFile,
  newScratchFile,
  warnIfNotSwept,
} from './cache-files';

jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));

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

    expect(file.uri).toMatch(
      /^file:\/\/\/cache\/bracemark-exports\/[^/]+\/Bracemark backup 2026-01-01.zip$/,
    );
    // The directory exists, so the run's write does not depend on `intermediates`.
    file.write('zip');
    expect(listFileUris()).toEqual([file.uri]);
  });

  it('keeps the previous backup until the replacement has been written', () => {
    const old = newExportFile('backup.zip');
    old.write('only surviving copy');
    const next = newExportFile('backup.zip');

    expect(next.uri).not.toBe(old.uri);
    expect(listFileUris()).toEqual([old.uri]);
    next.write('replacement');
    expect(old.exists).toBe(true);

    finishExportFile(next);
    expect(listFileUris()).toEqual([next.uri]);
  });
});

describe('newScratchFile', () => {
  // Loose in the cache dir, a file a killed process left has a name nobody knows and no
  // directory that marks it as ours — the sweep could only find it by listing a directory
  // every module in the app writes to.
  it('hands the operation a location under a directory of ours', () => {
    const file = newScratchFile('extract-1');

    expect(file.uri).toBe('file:///cache/bracemark-scratch/extract-1');
    file.write('a preview in transit');
    expect(listFileUris()).toEqual([file.uri]);
  });

  // The sweep deletes the directory itself, and so can an OS purge. The next operation
  // must not find it missing.
  it('makes the directory again after the sweep has taken it', () => {
    newScratchFile('extract-1').write('before');
    clearCacheFiles();

    const next = newScratchFile('extract-2');
    next.write('after');

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
  it('removes the export, the scratch a killed run left, and everything the pickers left', () => {
    newExportFile('Bracemark backup 2026-01-01.zip').write('zip');
    newScratchFile('extract-1').write('a preview in transit');
    park('DocumentPicker', 'bookmarks.html');
    park('ImagePicker', 'photo.jpg');
    park('ImageManipulator', 'resized.jpg');

    clearCacheFiles();

    expect(listFileUris()).toEqual([]);
  });

  // The cache dir is shared with every module in the app. This sweeps the directories
  // named in cache-files.ts and nothing else.
  it('leaves the rest of the cache dir alone', () => {
    const loose = `${Paths.cache.uri}/http-cache.db`;
    writeFileText(loose, 'a library’s own');
    const theirs = park('SomeOtherModule', 'state.bin');

    clearCacheFiles();

    expect(listFileUris()).toEqual([theirs, loose].sort());
  });

  // The native delete throws on a directory that was never created, and this runs on
  // every sign-out — including the first one on a device that never exported anything.
  it('is safe when none of it exists', () => {
    expect(() => clearCacheFiles()).not.toThrow();
  });
});

// The picker directories are named by the modules that write them, so an upgrade can move
// one — and the sweep then deletes a directory that is not there, without an error and
// without a failing test above (those park files under the names this repo believes in).
// The check is the only thing that compares the list with what a module really wrote.
describe('warnIfNotSwept', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // The relation, not the names: it has to speak for exactly the files the sweep leaves.
  // `ImagePickerCache` is the rename — a sibling whose name merely starts with a listed one.
  it.each([
    ['file:///cache/DocumentPicker/bookmarks.html', false],
    ['file:///cache/ImagePicker/photo.jpg', false],
    ['file:///cache/ImageManipulator/resized.jpg', false],
    ['file:///cache/ImagePickerCache/photo.jpg', true],
    ['file:///cache/photo.jpg', true],
    ['file:///document/Picked/photo.jpg', true],
  ])('speaks up exactly when the sweep would leave the file: %s', (uri, left) => {
    new Directory(uri.slice(0, uri.lastIndexOf('/'))).create({ idempotent: true });
    writeFileText(uri, 'plaintext');

    warnIfNotSwept(uri, 'expo-image-picker');
    const warned = warn.mock.calls.length > 0;
    clearCacheFiles();

    expect(new File(uri).exists).toBe(left);
    expect(warned).toBe(left);
  });

  it('names the module and the file, so the log says which name to re-read', () => {
    warnIfNotSwept('file:///cache/ImagePickerCache/photo.jpg', 'expo-image-picker');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('expo-image-picker');
    expect(warn.mock.calls[0][0]).toContain('file:///cache/ImagePickerCache/photo.jpg');
  });
});
