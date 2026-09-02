// The v1 blob frame — `[version(1) || iv(12) || ciphertext+tag]`, the sibling of
// web-crypto's blob.spec.ts and deliberately the same assertions: this is ONE
// wire format, and the two framers are only interchangeable if they hold the
// same properties. contract-vectors.spec.ts decrypts a golden blob web packed
// (proving the bytes agree); this pins what a fixed vector can't see — the
// offsets, the loud version rejection, and the defensive copy on unpack.
//
// The third one matters more here than on web: quick-crypto hands views straight
// to native, so a slice that aliased its source could be mutated underneath a
// call already in flight.
import { randomBytes } from 'node:crypto';

import { AES_GCM_IV_BYTES, BLOB_FORMAT_V1, utf8 } from '@stxapps/shared';

import { decrypt, encrypt } from './aes';
import { decryptEntity, encryptEntity, packBlob, unpackBlob } from './blob';

const HEADER_BYTES = 1 + AES_GCM_IV_BYTES;
const TAG_BYTES = 16;

const randomKey = () => new Uint8Array(randomBytes(32));

// A synthetic EncryptedBlob with recognisable bytes, so an off-by-one in the
// offsets shows up as the wrong marker rather than as a decrypt failure.
const fakeBlob = () => ({
  iv: new Uint8Array(AES_GCM_IV_BYTES).fill(0xaa),
  ciphertext: new Uint8Array(40).fill(0xbb),
});

describe('packBlob', () => {
  it('lays the frame out as version || iv || ciphertext, with no padding', () => {
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
    // A newer client's format must not be sliced as if it were v1: that feeds
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

  it('rejects an empty buffer rather than reading it as a v1 frame', () => {
    // `bytes[0]` is undefined here, not 1 — a zero-length body from a truncated
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

    const packed = await encryptEntity(key, data);

    expect(packed[0]).toBe(BLOB_FORMAT_V1);
    expect(packed).toHaveLength(HEADER_BYTES + data.length + TAG_BYTES);
    await expect(decryptEntity(key, packed)).resolves.toEqual(data);
  });

  it('round-trips an EMPTY entity (a 29-byte frame, not a special case)', async () => {
    const key = randomKey();
    const packed = await encryptEntity(key, new Uint8Array(0));

    expect(packed).toHaveLength(HEADER_BYTES + TAG_BYTES);
    await expect(decryptEntity(key, packed)).resolves.toEqual(new Uint8Array(0));
  });

  it('copies the caller’s data, so a VIEW into a larger buffer encrypts correctly', async () => {
    // Entity JSON arrives as a slice of a bigger buffer (a sqlite `data` column,
    // a decoded payload). `new Uint8Array(data)` must copy the view's window, not
    // adopt the whole underlying ArrayBuffer.
    const key = randomKey();
    const backing = utf8('PREFIXthe entity bytesSUFFIX');
    const view = backing.subarray(6, 6 + 'the entity bytes'.length);

    const plaintext = await decryptEntity(key, await encryptEntity(key, view));
    expect(new TextDecoder().decode(plaintext)).toBe('the entity bytes');
  });

  it('mints a fresh frame per call — identical data never packs to identical bytes', async () => {
    // Inherited from aes.ts's per-call IV, but asserted at this layer too: this
    // is the function the sync engine calls before every PUT, so an entity that
    // re-uploaded to byte-identical ciphertext would leak "unchanged" to R2.
    const key = randomKey();
    const data = utf8('same entity, two uploads');

    expect(await encryptEntity(key, data)).not.toEqual(await encryptEntity(key, data));
  });

  it('throws when any byte of the frame is tampered with', async () => {
    const key = randomKey();
    const data = utf8('an entity worth tampering with');

    // One flip in the IV region and two in the ciphertext region: all must fail
    // the tag rather than yield plausible-looking plaintext.
    for (const index of [1, HEADER_BYTES, HEADER_BYTES + 5]) {
      const packed = await encryptEntity(key, data);
      packed[index] ^= 0x01;
      await expect(decryptEntity(key, packed)).rejects.toThrow();
    }
  });

  it('throws under a wrong key — the caller treats it as a failed download', async () => {
    const packed = await encryptEntity(randomKey(), utf8('someone else’s entity'));
    await expect(decryptEntity(randomKey(), packed)).rejects.toThrow();
  });

  it('packs what packBlob packs — the two entry points share one framer', async () => {
    // encryptEntity is packBlob(encrypt(...)); decryptEntity must therefore read
    // a hand-packed frame identically, which is what lets the JS framer and the
    // native BracemarkFileCrypto framer meet in the middle.
    const key = randomKey();
    const data = utf8('framed by hand');

    const packed = packBlob(await encrypt(key, data));
    await expect(decryptEntity(key, packed)).resolves.toEqual(data);
    await expect(decrypt(key, unpackBlob(await encryptEntity(key, data)))).resolves.toEqual(data);
  });
});
