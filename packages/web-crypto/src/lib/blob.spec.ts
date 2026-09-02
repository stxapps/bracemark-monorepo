/**
 * @jest-environment node
 *
 * The v1 blob frame — `[version(1) || iv(12) || ciphertext+tag]`. This is the
 * ONE wire format every platform reads and writes forever, so the framing is
 * pinned twice over: contract-vectors.spec.ts decrypts a golden packed blob
 * (proving these bytes match what expo and the native framer produce), and this
 * spec pins the properties a single fixed vector can't see — the offsets, the
 * loud version rejection, and the defensive copy on unpack.
 *
 * Node env: the real Web Crypto lives at globalThis.crypto there.
 */
import { AES_GCM_IV_BYTES, BLOB_FORMAT_V1, utf8 } from '@stxapps/shared';

import { decrypt, encrypt } from './aes';
import { decryptEntity, encryptEntity, packBlob, unpackBlob } from './blob';

const HEADER_BYTES = 1 + AES_GCM_IV_BYTES;
const TAG_BYTES = 16;

const randomKey = () =>
  crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

// A synthetic EncryptedBlob with recognisable bytes, so an off-by-one in the
// offsets shows up as the wrong marker rather than as a decrypt failure.
const fakeBlob = () => ({
  iv: new Uint8Array(AES_GCM_IV_BYTES).fill(0xaa) as Uint8Array<ArrayBuffer>,
  ciphertext: new Uint8Array(40).fill(0xbb) as Uint8Array<ArrayBuffer>,
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
    // The source is whatever a caller handed in — a fetch body, or on the expo
    // sibling a view quick-crypto passes straight to native. Aliasing would make
    // a later mutation of that buffer silently change the IV under a decrypt.
    const packed = packBlob(fakeBlob());
    const { iv, ciphertext } = unpackBlob(packed);

    packed.fill(0xff, 1);

    expect(iv.every((byte) => byte === 0xaa)).toBe(true);
    expect(ciphertext.every((byte) => byte === 0xbb)).toBe(true);
  });
});

describe('encryptEntity / decryptEntity', () => {
  it('round-trips entity bytes through a v1 frame', async () => {
    const key = await randomKey();
    const data = utf8('{"id":"a1","title":"café — ☕"}');

    const packed = await encryptEntity(key, data);

    expect(packed[0]).toBe(BLOB_FORMAT_V1);
    expect(packed).toHaveLength(HEADER_BYTES + data.length + TAG_BYTES);
    await expect(decryptEntity(key, packed)).resolves.toEqual(data);
  });

  it('round-trips an EMPTY entity (a 29-byte frame, not a special case)', async () => {
    const key = await randomKey();
    const packed = await encryptEntity(key, new Uint8Array(0));

    expect(packed).toHaveLength(HEADER_BYTES + TAG_BYTES);
    await expect(decryptEntity(key, packed)).resolves.toEqual(new Uint8Array(0));
  });

  it('copies the caller’s data, so a VIEW into a larger buffer encrypts correctly', async () => {
    // Callers hand in slices of bigger buffers (a decoded payload, a sqlite blob
    // column). `new Uint8Array(data)` must copy the view's window, not adopt the
    // whole underlying ArrayBuffer.
    const key = await randomKey();
    const backing = utf8('PREFIXthe entity bytesSUFFIX');
    const view = backing.subarray(6, 6 + 'the entity bytes'.length);

    const plaintext = await decryptEntity(key, await encryptEntity(key, view));
    expect(new TextDecoder().decode(plaintext)).toBe('the entity bytes');
  });

  it('mints a fresh frame per call — identical data never packs to identical bytes', async () => {
    // Inherited from aes.ts's per-call IV, but asserted at this layer too: this
    // is the function the sync engine calls before every PUT, so an entity that
    // re-uploaded to byte-identical ciphertext would leak "unchanged" to R2.
    const key = await randomKey();
    const data = utf8('same entity, two uploads');

    expect(await encryptEntity(key, data)).not.toEqual(await encryptEntity(key, data));
  });

  it('throws when any byte of the frame is tampered with', async () => {
    const key = await randomKey();
    const data = utf8('an entity worth tampering with');

    // One flip in the IV region and one in the ciphertext region: both must fail
    // the tag rather than yield plausible-looking plaintext.
    for (const index of [1, HEADER_BYTES, HEADER_BYTES + 5]) {
      const packed = await encryptEntity(key, data);
      packed[index] ^= 0x01;
      await expect(decryptEntity(key, packed)).rejects.toThrow();
    }
  });

  it('throws under a wrong key — the caller treats it as a failed download', async () => {
    const packed = await encryptEntity(await randomKey(), utf8('someone else’s entity'));
    await expect(decryptEntity(await randomKey(), packed)).rejects.toThrow();
  });

  it('packs what packBlob packs — the two entry points share one framer', async () => {
    // encryptEntity is packBlob(encrypt(...)); decryptEntity must therefore read
    // a hand-packed frame identically, which is what lets the sync engine and
    // the native/expo side meet in the middle.
    const key = await randomKey();
    const data = utf8('framed by hand');

    const packed = packBlob(await encrypt(key, data));
    await expect(decryptEntity(key, packed)).resolves.toEqual(data);
    await expect(decrypt(key, unpackBlob(await encryptEntity(key, data)))).resolves.toEqual(data);
  });
});
