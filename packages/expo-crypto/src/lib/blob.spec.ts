// The blob frame — `[version(1) || iv(12) || ciphertext+tag]`, the sibling of
// web-crypto's blob.spec.ts and deliberately the same assertions: this is ONE
// wire format, and the two framers are only interchangeable if they hold the
// same properties. contract-vectors.spec.ts decrypts the golden blobs (proving
// the bytes agree); this pins what a fixed vector can't see — the offsets, the
// loud version rejection, the defensive copy on unpack, and what the path
// binding refuses.
//
// The copy matters more here than on web: quick-crypto hands views straight to
// native, so a slice that aliased its source could be mutated underneath a call
// already in flight.
import { randomBytes } from 'node:crypto';

import { AES_GCM_IV_BYTES, BLOB_FORMAT_V1, blobAad, utf8 } from '@stxapps/shared';

import { decrypt, encrypt } from './aes';
import { decryptEntity, encryptEntity, packBlob, unpackBlob } from './blob';

const HEADER_BYTES = 1 + AES_GCM_IV_BYTES;
const TAG_BYTES = 16;
const PATH = 'links/a1.enc';

const randomKey = () => new Uint8Array(randomBytes(32));

// A synthetic EncryptedBlob with recognisable bytes, so an off-by-one in the
// offsets shows up as the wrong marker rather than as a decrypt failure.
const fakeBlob = () => ({
  iv: new Uint8Array(AES_GCM_IV_BYTES).fill(0xaa),
  ciphertext: new Uint8Array(40).fill(0xbb),
});

describe('packBlob', () => {
  it('lays a v1 frame out as version || iv || ciphertext, with no padding', () => {
    const { iv, ciphertext } = fakeBlob();
    const packed = packBlob({ iv, ciphertext });

    expect(packed).toHaveLength(HEADER_BYTES + ciphertext.length);
    expect(packed[0]).toBe(BLOB_FORMAT_V1);
    expect(packed.subarray(1, HEADER_BYTES)).toEqual(iv);
    expect(packed.subarray(HEADER_BYTES)).toEqual(ciphertext);
  });
});

describe('unpackBlob', () => {
  it('is the exact inverse of packBlob', () => {
    const blob = fakeBlob();
    expect(unpackBlob(packBlob(blob))).toEqual(blob);
  });

  it('rejects an unknown version byte LOUDLY, naming the byte', () => {
    // A newer client's format must not be sliced as if it were known: that feeds
    // garbage to GCM and surfaces as a misleading "tampered" error, sending
    // whoever debugs it after a corruption bug that isn't there. The two
    // failures have to stay distinguishable, so the message is part of the
    // contract, not decoration.
    for (const version of [0x00, 0x02, 0xff]) {
      const packed = packBlob(fakeBlob());
      packed[0] = version;
      expect(() => unpackBlob(packed)).toThrow(`Unknown blob format version: ${version}`);
    }
  });

  it('rejects an empty buffer rather than reading it as a frame', () => {
    // `bytes[0]` is undefined here — a zero-length body from a truncated
    // download must not slice into an empty iv and an empty ciphertext.
    expect(() => unpackBlob(new Uint8Array(0))).toThrow(/Unknown blob format version/);
  });

  it('COPIES both slices, so the result never aliases the source buffer', () => {
    const packed = packBlob(fakeBlob());
    const { iv, ciphertext } = unpackBlob(packed);

    packed.fill(0xff, 1);

    expect(iv.every((byte) => byte === 0xaa)).toBe(true);
    expect(ciphertext.every((byte) => byte === 0xbb)).toBe(true);
  });
});

describe('encryptEntity / decryptEntity', () => {
  it('round-trips entity bytes through a v1 frame', async () => {
    const key = randomKey();
    const data = utf8('{"id":"a1","title":"café — ☕"}');

    const packed = await encryptEntity(key, data, PATH);

    expect(packed[0]).toBe(BLOB_FORMAT_V1);
    expect(packed).toHaveLength(HEADER_BYTES + data.length + TAG_BYTES);
    await expect(decryptEntity(key, packed, PATH)).resolves.toEqual(data);
  });

  // The property the AAD exists for: whoever answers a GET can hand back another of
  // the account's own blobs, and the key alone would not notice.
  it('refuses a blob served under any other path', async () => {
    const key = randomKey();
    const packed = await encryptEntity(key, utf8('link a1'), PATH);

    for (const other of ['links/a2.enc', 'lists/a1.enc', 'links/a1.enc ', 'Links/a1.enc']) {
      await expect(decryptEntity(key, packed, other)).rejects.toThrow();
    }
  });

  it('seals with blobAad(path) — the bytes the native framers build', async () => {
    const key = randomKey();
    const data = utf8('bound');
    const packed = await encryptEntity(key, data, PATH);
    const sealed = unpackBlob(packed);

    await expect(decrypt(key, sealed, blobAad(PATH))).resolves.toEqual(data);
    await expect(decrypt(key, sealed)).rejects.toThrow();
  });

  // A frame sealed without the path — what a pre-binding build wrote — fails
  // the tag under every path.
  it('opens no frame sealed without the path', async () => {
    const key = randomKey();
    const unbound = packBlob(await encrypt(key, utf8('written without a path')));

    await expect(decryptEntity(key, unbound, PATH)).rejects.toThrow();
  });

  it('round-trips an EMPTY entity (a 29-byte frame, not a special case)', async () => {
    const key = randomKey();
    const packed = await encryptEntity(key, new Uint8Array(0), PATH);

    expect(packed).toHaveLength(HEADER_BYTES + TAG_BYTES);
    await expect(decryptEntity(key, packed, PATH)).resolves.toEqual(new Uint8Array(0));
  });

  it('copies the caller’s data, so a VIEW into a larger buffer encrypts correctly', async () => {
    // Entity JSON arrives as a slice of a bigger buffer (a sqlite `data` column,
    // a decoded payload). `new Uint8Array(data)` must copy the view's window, not
    // adopt the whole underlying ArrayBuffer.
    const key = randomKey();
    const backing = utf8('PREFIXthe entity bytesSUFFIX');
    const view = backing.subarray(6, 6 + 'the entity bytes'.length);

    const plaintext = await decryptEntity(key, await encryptEntity(key, view, PATH), PATH);
    expect(new TextDecoder().decode(plaintext)).toBe('the entity bytes');
  });

  it('mints a fresh frame per call — identical data never packs to identical bytes', async () => {
    // Inherited from aes.ts's per-call IV, but asserted at this layer too: this
    // is the function the sync engine calls before every PUT, so an entity that
    // re-uploaded to byte-identical ciphertext would leak "unchanged" to R2.
    const key = randomKey();
    const data = utf8('same entity, two uploads');

    expect(await encryptEntity(key, data, PATH)).not.toEqual(await encryptEntity(key, data, PATH));
  });

  it('throws when any byte of the frame is tampered with', async () => {
    const key = randomKey();
    const data = utf8('an entity worth tampering with');

    // One flip in the IV region and two in the ciphertext region: all must fail
    // the tag rather than yield plausible-looking plaintext.
    for (const index of [1, HEADER_BYTES, HEADER_BYTES + 5]) {
      const packed = await encryptEntity(key, data, PATH);
      packed[index] ^= 0x01;
      await expect(decryptEntity(key, packed, PATH)).rejects.toThrow();
    }
  });

  it('throws under a wrong key — the caller treats it as a failed download', async () => {
    const packed = await encryptEntity(randomKey(), utf8('someone else’s entity'), PATH);
    await expect(decryptEntity(randomKey(), packed, PATH)).rejects.toThrow();
  });

  it('packs what packBlob packs — the two entry points share one framer', async () => {
    // encryptEntity is packBlob(encrypt(..., blobAad(path))); decryptEntity
    // must therefore read a hand-packed frame identically, which is what lets
    // the JS framer and the native BracemarkFileCrypto framer meet in the middle.
    const key = randomKey();
    const data = utf8('framed by hand');

    const packed = packBlob(await encrypt(key, data, blobAad(PATH)));
    await expect(decryptEntity(key, packed, PATH)).resolves.toEqual(data);
  });
});
