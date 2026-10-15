// AES-256-GCM on the native side. The platform difference is the whole reason
// this spec exists: Web Crypto appends the 128-bit GCM tag to the ciphertext for
// you, while quick-crypto's Node-style API hands it back separately — so aes.ts
// APPENDS it on encrypt and SPLITS it back off on decrypt, by hand, to keep
// EncryptedBlob byte-identical across platforms. That hand-written seam is what
// gets pinned here: tag placement, the offsets used to stitch update()+final()
// together, and the per-call IV.
//
// contract-vectors.spec.ts already proves this file can decrypt a blob web
// produced, which is the cross-platform half. What no fixed vector can see is
// ENCRYPT's own behaviour — a fresh IV every call, a tag that is actually
// verified, an AAD that actually binds.
//
// quick-crypto is shimmed onto node:crypto here (see ../testing); the seam under
// test is ours, not the native library's.
import { createDecipheriv, randomBytes } from 'node:crypto';

import { AES_GCM_IV_BYTES, utf8 } from '@stxapps/shared';

import { decrypt, encrypt } from './aes';

// Same constant aes.ts splits on — restated so a change there has to be a
// deliberate change to the wire format on both sides, not a silent one.
const TAG_BYTES = 16;

const randomKey = () => new Uint8Array(randomBytes(32));

describe('encrypt', () => {
  it('mints a FRESH random IV per call, so one key never reuses a nonce', async () => {
    // The catastrophic AES-GCM failure: two messages under one key and one IV
    // leak their XOR and the authentication subkey.
    const key = randomKey();
    const plaintext = utf8('the same bytes, twice');

    const a = await encrypt(key, plaintext);
    const b = await encrypt(key, plaintext);

    expect(a.iv).toHaveLength(AES_GCM_IV_BYTES);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('appends the tag AFTER the ciphertext body, at exactly 16 bytes', async () => {
    // The frozen wire fact: `ciphertext` is body ‖ tag with nothing between and
    // nothing dropped. A tag written at the FRONT would still round-trip through
    // this file's own decrypt — and would be unreadable on web forever.
    const key = randomKey();
    for (const size of [0, 1, 15, 16, 17, 4096]) {
      const { ciphertext } = await encrypt(key, new Uint8Array(size));
      expect(ciphertext).toHaveLength(size + TAG_BYTES);
    }
  });

  it('leaves the body bytes where a web reader expects them', async () => {
    // Stitching head+tail+tag by byteOffset is easy to get subtly wrong on a
    // large payload, where update() actually returns more than one chunk. Decrypt
    // the body through node's own GCM the way web-crypto's Web Crypto would read
    // it: body first, tag last.
    const key = randomKey();
    const plaintext = utf8('x'.repeat(100_000));

    const { iv, ciphertext } = await encrypt(key, plaintext);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    const out = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]);

    expect(new Uint8Array(out)).toEqual(plaintext);
  });
});

describe('decrypt', () => {
  it('round-trips arbitrary bytes, including an empty plaintext', async () => {
    const key = randomKey();
    for (const plaintext of [
      new Uint8Array(0),
      utf8('a'),
      utf8('{"title":"café — ☕","tags":["日本語"]}'),
      utf8('y'.repeat(100_000)),
    ]) {
      await expect(decrypt(key, await encrypt(key, plaintext))).resolves.toEqual(plaintext);
    }
  });

  it('throws when a byte of the ciphertext body is flipped', async () => {
    const key = randomKey();
    const blob = await encrypt(key, utf8('an entity worth tampering with'));
    blob.ciphertext[0] ^= 0x01;

    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws when a byte of the appended TAG is flipped', async () => {
    // Distinct from the body case: this is the half aes.ts splits off by hand and
    // feeds to setAuthTag. Slicing the wrong 16 bytes there would leave the tag
    // unverified — and nothing else would notice, because decrypt would keep
    // returning correct plaintext for untampered blobs.
    const key = randomKey();
    const blob = await encrypt(key, utf8('an entity worth tampering with'));
    blob.ciphertext[blob.ciphertext.length - 1] ^= 0x01;

    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws under a different key — the failure sign-in reads as a wrong password', async () => {
    // openDek() turns exactly this throw into WrongPasswordError.
    const blob = await encrypt(randomKey(), utf8('secret'));
    await expect(decrypt(randomKey(), blob)).rejects.toThrow();
  });

  it('throws when the IV is wrong, even with the right key', async () => {
    const key = randomKey();
    const blob = await encrypt(key, utf8('secret'));
    blob.iv[0] ^= 0x01;

    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws on a ciphertext too short to hold a tag', async () => {
    // A truncated download reaches the manual split with fewer than 16 bytes,
    // where the subarray arithmetic goes negative. It has to fail as a short
    // input, before GCM: Node-style GCM accepts tags down to 4 bytes, so a
    // 4-15 byte slice would be checked as a truncated tag instead.
    const key = randomKey();
    for (const length of [0, 1, 4, 15]) {
      await expect(
        decrypt(key, { iv: new Uint8Array(AES_GCM_IV_BYTES), ciphertext: new Uint8Array(length) }),
      ).rejects.toThrow('ciphertext shorter than its GCM tag');
    }
  });
});

describe('the AAD binding', () => {
  // What stops a malicious server passing one door's wrapped DEK off as another's
  // (dekWrapAad in @stxapps/shared). It holds only if decrypt requires
  // byte-identical AAD, and if omitting it is not silently equivalent to
  // supplying one.
  it('round-trips when the same AAD is supplied', async () => {
    const key = randomKey();
    const blob = await encrypt(key, utf8('dek'), utf8('password'));
    await expect(decrypt(key, blob, utf8('password'))).resolves.toEqual(utf8('dek'));
  });

  it('throws on a DIFFERENT AAD', async () => {
    const key = randomKey();
    const blob = await encrypt(key, utf8('dek'), utf8('password'));
    await expect(decrypt(key, blob, utf8('recovery'))).rejects.toThrow();
  });

  it('throws when the AAD is omitted on decrypt', async () => {
    const key = randomKey();
    const blob = await encrypt(key, utf8('dek'), utf8('password'));
    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws when an AAD is supplied for a blob encrypted without one', async () => {
    const key = randomKey();
    const blob = await encrypt(key, utf8('dek'));
    await expect(decrypt(key, blob, utf8('password'))).rejects.toThrow();
  });

  it('does not ALIAS the caller’s AAD buffer', async () => {
    // aes.ts wraps the AAD in Buffer.from precisely because it must copy, not
    // adopt: the callers hand in `dekWrapAad(doorType)` and reuse their own
    // buffers freely.
    const key = randomKey();
    const aad = utf8('password');
    const blob = await encrypt(key, utf8('dek'), aad);

    aad.fill(0);

    await expect(decrypt(key, blob, utf8('password'))).resolves.toEqual(utf8('dek'));
  });
});
