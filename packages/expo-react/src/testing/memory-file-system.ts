// An in-memory stand-in for expo-file-system, so specs can drive the REAL
// data/file-store.ts — its directory ownership, its path↔location mapping, its
// guarded deletes — instead of a hand-written fake of it. Same philosophy as
// node-sqlite.ts beside this file: shim only the native seam, and let every
// module above it run for real.
//
// The shape modelled is the NEW expo-file-system API (`Directory`/`File`/
// `Paths`), which is what file-store.ts and favicon-store.ts use; the legacy `uploadAsync` surface
// belongs to sync/r2.ts and is stubbed by the specs that touch it.
//
// Contents are BYTES, and used to be strings. The sync plane genuinely never
// looks at `files/` payload bytes — they move path-to-path through native
// crypto — so a string was the readable stand-in for years. The export/import
// round trip broke that assumption from both ends: the backup reads a blob's
// real bytes into a zip (`plain.bytes()`) and writes the zip itself to a cache
// file, and a lossy text hop would corrupt a PNG or a deflate stream while every
// assertion above it still passed. So the map holds `Uint8Array` and
// `readFileText`/`writeFileText` are the UTF-8 views onto it — the spec-facing
// convenience they always were, now derived rather than stored.
//
// Two faithful strictnesses are deliberate, because both catch real bugs:
//  - `delete()` on a missing entry THROWS, as the native API does — so an
//    unguarded delete fails here rather than passing silently.
//  - writing into a directory that does not exist THROWS — so a pipeline that
//    forgets `ensureDataFilesDir()` before materializing fails here rather than
//    on a device.

// uri -> contents. A file exists iff it has an entry.
const files = new Map<string, Uint8Array>();
const dirs = new Set<string>();

const ROOTS = ['file:///document', 'file:///cache'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  list(): (Directory | File)[] {
    if (!this.exists) throw new Error(`No such directory: ${this.uri}`);
    return [
      ...[...dirs].filter((uri) => parentOf(uri) === this.uri).map((uri) => new Directory(uri)),
      ...[...files.keys()].filter((uri) => parentOf(uri) === this.uri).map((uri) => new File(uri)),
    ];
  }

  get exists(): boolean {
    return dirs.has(this.uri);
  }

  create(options?: { intermediates?: boolean; idempotent?: boolean }): void {
    if (this.exists && !options?.idempotent) throw new Error(`Directory exists: ${this.uri}`);
    if (options?.intermediates) {
      let parent = parentOf(this.uri);
      while (parent !== '' && !dirs.has(parent)) {
        dirs.add(parent);
        parent = parentOf(parent);
      }
    }
    dirs.add(this.uri);
  }

  // Recursive, like the real one: the contained blobs go with it (clearDataFiles
  // relies on exactly that).
  delete(): void {
    if (!this.exists) throw new Error(`No such directory: ${this.uri}`);
    for (const uri of [...dirs]) {
      if (uri === this.uri || uri.startsWith(`${this.uri}/`)) dirs.delete(uri);
    }
    for (const uri of [...files.keys()]) if (uri.startsWith(`${this.uri}/`)) files.delete(uri);
  }
}

export class File extends FileSystemNode {
  get parentDirectory(): Directory {
    return new Directory(parentOf(this.uri));
  }

  get exists(): boolean {
    return files.has(this.uri);
  }

  // Bytes, and 0 for a file that does not exist — the native API's answer. The
  // sync engine reads it to choose a content upload's fan-out (uploadOne).
  get size(): number {
    return files.get(this.uri)?.byteLength ?? 0;
  }

  delete(): void {
    if (!files.delete(this.uri)) throw new Error(`No such file: ${this.uri}`);
  }

  // Declaring the file before writing it, as data/mutations.ts and the export's
  // `writeCacheFile` both do. `overwrite: false` over an existing file throws,
  // like the native API — an unguarded re-create is a real bug on device.
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void {
    if (this.exists && options?.overwrite !== true) {
      throw new Error(`File exists: ${this.uri}`);
    }
    if (options?.intermediates === true) {
      let dir = parentOf(this.uri);
      const missing: string[] = [];
      while (dir !== '' && !dirs.has(dir)) {
        missing.push(dir);
        dir = parentOf(dir);
      }
      for (const created of missing) dirs.add(created);
    }
    writeFileBytes(this.uri, new Uint8Array());
  }

  // The one write the real `File` surface offers that a store above this layer
  // uses directly (data/favicon-store.ts writes an icon's bytes;
  // data/export-all-data.ts writes the backup zip).
  write(contents: string | Uint8Array): void {
    writeFileBytes(this.uri, typeof contents === 'string' ? encoder.encode(contents) : contents);
  }

  // Async on the real API, and awaited by both orchestrators. Returns a copy, so
  // a caller that transfers or mutates the array can't reach back into the
  // filesystem's own copy — the native one hands back fresh bytes too.
  async bytes(): Promise<Uint8Array> {
    return Uint8Array.from(readFileBytes(this.uri));
  }

  async text(): Promise<string> {
    return decoder.decode(readFileBytes(this.uri));
  }

  copy(destination: File | Directory): void {
    const target =
      destination instanceof Directory
        ? `${destination.uri}/${this.uri.slice(this.uri.lastIndexOf('/') + 1)}`
        : destination.uri;
    writeFileBytes(target, readFileBytes(this.uri));
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

export function readFileBytes(uri: string): Uint8Array {
  const bytes = files.get(uri);
  if (bytes === undefined) throw new Error(`No such file: ${uri}`);
  return bytes;
}

export function writeFileBytes(uri: string, bytes: Uint8Array): void {
  if (!dirs.has(parentOf(uri))) throw new Error(`No such directory: ${parentOf(uri)}`);
  files.set(uri, bytes);
}

// The UTF-8 views, which is what a spec asserting on a pipeline's OUTPUT wants.
export function readFileText(uri: string): string {
  return decoder.decode(readFileBytes(uri));
}

export function writeFileText(uri: string, text: string): void {
  writeFileBytes(uri, encoder.encode(text));
}

// Every file currently on disk, sorted — for the leak assertions (a transfer
// that settles must leave no ciphertext behind in the cache dir).
export function listFileUris(): string[] {
  return [...files.keys()].sort();
}
