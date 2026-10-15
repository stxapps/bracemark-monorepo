// The AAD every blob is sealed with: its frame's version byte, then the UTF-8 of
// the sync path it is stored under (`links/{id}.enc`, `files/{id}.enc`, … —
// relative to the account's root, exactly as the wire carries it). Part of the
// FROZEN cross-platform contract (params.ts): web-crypto and expo-crypto build
// it in JS, and the Swift and Kotlin file framers build the same bytes natively
// (packages/expo-crypto ios/BlobFrame.swift, android BlobFrame.kt), all four
// held to `blob` in contract-vectors.ts.
//
// Why the path: the data key proves a blob is the account's, and the path is
// the one thing about it the key does not bind. Without it, whoever answers a
// GET could hand back another of the account's own blobs — one link's record
// for another's, a list for a list — and the tag would pass. The path is the
// identity every reader goes by (sync/paths.ts, idFromPath), so it is the whole
// of what needs binding; the account is already bound by the key. The version
// byte leads the AAD so that a later format which keeps the same rule (its own
// version byte first in its AAD) can never share these bytes. The frame's own
// version byte is not fed to GCM: what holds it is each reader's equality check
// against the one version it opens, together with this constant leading the AAD.
//
// Not bound: WHICH VERSION of a path's blob is served, or which paths are. An
// older blob written to the same path still opens there, so the server can roll
// a path back, serve a deleted path's last blob again, leave paths out, invent
// deletes, mix versions across paths, or withhold updates — none of which passes
// one path's content off as another's (docs/local-first-sync.md).
//
// The path must stay ASCII — it does today (sync/paths.ts, the path grammar).
// The four framers agree on the bytes of any well-formed string, but a lone
// surrogate encodes differently in JS (EF BF BD) and Java (3F), so a grammar
// that ever admitted one would split the platforms here first.
import { utf8 } from './encoding';
import { BLOB_FORMAT_V1 } from './params';

export function blobAad(path: string): Uint8Array<ArrayBuffer> {
  const pathBytes = utf8(path);
  const aad = new Uint8Array(1 + pathBytes.length);
  aad[0] = BLOB_FORMAT_V1;
  aad.set(pathBytes, 1);
  return aad;
}
