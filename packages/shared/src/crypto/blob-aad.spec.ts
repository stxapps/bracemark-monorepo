import { blobAad } from './blob-aad';
import { CRYPTO_CONTRACT_VECTOR as V } from './contract-vectors';
import { bytesToHex } from './encoding';
import { BLOB_FORMAT_V1 } from './params';

// The AAD every blob is sealed with. Four framers build it — two in JS from
// this function, two natively from hand-copies (BlobFrame.swift, BlobFrame.kt) —
// and all four are held to `blob.aadHex`, so this pins the source of truth.
describe('blobAad', () => {
  it('is the version byte, then the path’s UTF-8 — the contract bytes', () => {
    expect(bytesToHex(blobAad(V.blob.path))).toBe(V.blob.aadHex);
    expect(blobAad('links/a.enc')[0]).toBe(BLOB_FORMAT_V1);
  });

  it('differs for every path, including ones that differ only in case or a byte', () => {
    const paths = ['links/a.enc', 'links/b.enc', 'Links/a.enc', 'lists/a.enc', 'links/a.enc '];
    const encoded = new Set(paths.map((path) => bytesToHex(blobAad(path))));
    expect(encoded.size).toBe(paths.length);
  });
});
