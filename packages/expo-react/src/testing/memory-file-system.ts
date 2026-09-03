// An in-memory stand-in for expo-file-system, so specs can drive the REAL
// data/file-store.ts — its directory ownership, its path↔location mapping, its
// guarded deletes — instead of a hand-written fake of it. Same philosophy as
// node-sqlite.ts beside this file: shim only the native seam, and let every
// module above it run for real.
//
// The shape modelled is the NEW expo-file-system API (`Directory`/`File`/
// `Paths`), which is what file-store.ts and favicon-store.ts use; the legacy `uploadAsync` surface
// belongs to sync/r2.ts and is stubbed by the specs that touch it. Contents are
// STRINGS, not bytes: nothing above this layer inspects `files/` payload bytes
// (they move path-to-path through native crypto), so a string is the readable
// stand-in and a spec can assert on what a pipeline actually wrote.
//
// Two faithful strictnesses are deliberate, because both catch real bugs:
//  - `delete()` on a missing entry THROWS, as the native API does — so an
//    unguarded delete fails here rather than passing silently.
//  - writing into a directory that does not exist THROWS — so a pipeline that
//    forgets `ensureDataFilesDir()` before materializing fails here rather than
//    on a device.

// uri -> contents. A file exists iff it has an entry.
const files = new Map<string, string>();
const dirs = new Set<string>();

const ROOTS = ['file:///document', 'file:///cache'];

function join(parts: (FileSystemNode | string)[]): string {
  return parts
    .map((p) => (typeof p === 'string' ? p : p.uri))
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .filter((s) => s !== '')
    .join('/');
}

function parentOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/'));
}

class FileSystemNode {
  readonly uri: string;

  constructor(...parts: (FileSystemNode | string)[]) {
    this.uri = join(parts);
  }
}

export class Directory extends FileSystemNode {
  get exists(): boolean {
    return dirs.has(this.uri);
  }

  create(options?: { intermediates?: boolean; idempotent?: boolean }): void {
    if (this.exists && !options?.idempotent) throw new Error(`Directory exists: ${this.uri}`);
    dirs.add(this.uri);
  }

  // Recursive, like the real one: the contained blobs go with it (clearDataFiles
  // relies on exactly that).
  delete(): void {
    if (!this.exists) throw new Error(`No such directory: ${this.uri}`);
    dirs.delete(this.uri);
    for (const uri of [...files.keys()]) if (uri.startsWith(`${this.uri}/`)) files.delete(uri);
  }
}

export class File extends FileSystemNode {
  get exists(): boolean {
    return files.has(this.uri);
  }

  delete(): void {
    if (!files.delete(this.uri)) throw new Error(`No such file: ${this.uri}`);
  }

  // The one write the real `File` surface offers that a store above this layer uses
  // directly (data/favicon-store.ts writes an icon's bytes). Bytes are stored as their
  // decoded text so the map stays string-valued like the rest of the shim — nothing above
  // this layer reads a stored file's bytes back through it, so the round trip only has to
  // preserve presence and length, not the exact encoding.
  write(contents: string | Uint8Array): void {
    writeFileText(
      this.uri,
      typeof contents === 'string' ? contents : String.fromCharCode(...contents),
    );
  }

  copy(destination: File | Directory): void {
    const target =
      destination instanceof Directory
        ? `${destination.uri}/${this.uri.slice(this.uri.lastIndexOf('/') + 1)}`
        : destination.uri;
    writeFileText(target, readFileText(this.uri));
  }
}

export const Paths = {
  document: new Directory(ROOTS[0]),
  cache: new Directory(ROOTS[1]),
};

// --- the spec-facing half ----------------------------------------------------

// Back to a bare filesystem with only the two OS-provided roots — call from a
// `beforeEach`, beside the store truncation.
export function resetFileSystem(): void {
  files.clear();
  dirs.clear();
  for (const root of ROOTS) dirs.add(root);
}
resetFileSystem();

export function readFileText(uri: string): string {
  const text = files.get(uri);
  if (text === undefined) throw new Error(`No such file: ${uri}`);
  return text;
}

export function writeFileText(uri: string, text: string): void {
  if (!dirs.has(parentOf(uri))) throw new Error(`No such directory: ${parentOf(uri)}`);
  files.set(uri, text);
}

// Every file currently on disk, sorted — for the leak assertions (a transfer
// that settles must leave no ciphertext behind in the cache dir).
export function listFileUris(): string[] {
  return [...files.keys()].sort();
}
