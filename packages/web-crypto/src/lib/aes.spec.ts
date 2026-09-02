/**
 * @jest-environment node
 *
 * AES-256-GCM, the primitive every other file here is built on: the blob framer
 * (blob.ts) wraps it, and derive.ts uses it to wrap the DEK under each door.
 * contract-vectors.spec.ts pins DECRYPT against the golden bytes; this pins the
 * properties encrypt has to hold that no fixed vector can see — a fresh IV per
 * call, the tag appended (not dropped), and the AAD actually binding.
 *
 * Node env: the real Web Crypto lives at globalThis.crypto there. `CryptoKey` is
 * not in scope for this tsconfig (types: jest + node, no `dom` lib), so the key
 * helper's return type is left inferred — node's structurally identical webcrypto
 * key satisfies aes.ts either way, same as in contract-vectors.spec.ts.
 */
import { AES_GCM_IV_BYTES, utf8 } from '@stxapps/shared';

import { decrypt, encrypt } from './aes';

// The 128-bit GCM tag Web Crypto appends to every ciphertext. Not a constant in
// aes.ts on this platform (the browser appends it for us) — which is exactly why
// it is worth asserting: the expo sibling appends it by hand, and the two must
// agree byte-for-byte or one platform's blobs are unreadable on the other.
const TAG_BYTES = 16;

const randomKey = () =>
  crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

describe('encrypt', () => {
  it('mints a FRESH random IV per call, so one key never reuses a nonce', async () => {
    // The catastrophic AES-GCM failure: two messages under one key and one IV
    // leak their XOR and the authentication subkey. Nothing else in the codebase
    // chooses an IV, so this line is the whole defence.
    const key = await randomKey();
    const plaintext = utf8('the same bytes, twice');

    const a = await encrypt(key, plaintext);
    const b = await encrypt(key, plaintext);

    expect(a.iv).toHaveLength(AES_GCM_IV_BYTES);
    expect(a.iv).not.toEqual(b.iv);
    // …and therefore the ciphertexts differ too, despite identical input.
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('appends the 128-bit tag to the ciphertext (the cross-platform wire fact)', async () => {
    // EncryptedBlob.ciphertext is plaintext-length + tag, with nothing else in
    // it — the frame blob.ts packs and the expo sibling reconstructs by hand.
    const key = await randomKey();
    for (const size of [0, 1, 15, 16, 17, 4096]) {
      const { ciphertext } = await encrypt(key, new Uint8Array(size));
      expect(ciphertext).toHaveLength(size + TAG_BYTES);
    }
  });
});

describe('decrypt', () => {
  it('round-trips arbitrary bytes, including an empty plaintext', async () => {
    const key = await randomKey();
    for (const plaintext of [
      new Uint8Array(0),
      utf8('a'),
      utf8('{"title":"café — ☕","tags":["日本語"]}'),
      crypto.getRandomValues(new Uint8Array(10_000)),
    ]) {
      await expect(decrypt(key, await encrypt(key, plaintext))).resolves.toEqual(plaintext);
    }
  });

  it('throws when a byte of the ciphertext body is flipped', async () => {
    const key = await randomKey();
    const blob = await encrypt(key, utf8('an entity worth tampering with'));
    blob.ciphertext[0] ^= 0x01;

    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws when a byte of the appended TAG is flipped', async () => {
    // Separate from the body case: a framer that sliced the tag off and forgot
    // to verify it would still pass the test above.
    const key = await randomKey();
    const blob = await encrypt(key, utf8('an entity worth tampering with'));
    blob.ciphertext[blob.ciphertext.length - 1] ^= 0x01;

    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws under a different key — the failure sign-in reads as a wrong password', async () => {
    // openDek() turns exactly this throw into WrongPasswordError; if a wrong key
    // returned garbage instead, a wrong password would sign in with junk keys.
    const blob = await encrypt(await randomKey(), utf8('secret'));
    await expect(decrypt(await randomKey(), blob)).rejects.toThrow();
  });

  it('throws when the IV is wrong, even with the right key', async () => {
    const key = await randomKey();
    const blob = await encrypt(key, utf8('secret'));
    blob.iv[0] ^= 0x01;

    await expect(decrypt(key, blob)).rejects.toThrow();
  });
});

describe('the AAD binding', () => {
  // This is what stops a malicious server passing one door's wrapped DEK off as
  // another's (dekWrapAad in @stxapps/shared). It only holds if decrypt requires
  // byte-identical AAD — and if OMITTING the AAD is not silently equivalent to
  // supplying one, which is the shape the Chrome `additionalData: undefined`
  // workaround in aes.ts could plausibly break.
  it('round-trips when the same AAD is supplied', async () => {
    const key = await randomKey();
    const blob = await encrypt(key, utf8('dek'), utf8('password'));
    await expect(decrypt(key, blob, utf8('password'))).resolves.toEqual(utf8('dek'));
  });

  it('throws on a DIFFERENT AAD', async () => {
    const key = await randomKey();
    const blob = await encrypt(key, utf8('dek'), utf8('password'));
    await expect(decrypt(key, blob, utf8('recovery'))).rejects.toThrow();
  });

  it('throws when the AAD is omitted on decrypt', async () => {
    const key = await randomKey();
    const blob = await encrypt(key, utf8('dek'), utf8('password'));
    await expect(decrypt(key, blob)).rejects.toThrow();
  });

  it('throws when an AAD is supplied for a blob encrypted without one', async () => {
    const key = await randomKey();
    const blob = await encrypt(key, utf8('dek'));
    await expect(decrypt(key, blob, utf8('password'))).rejects.toThrow();
  });

  it('treats an EMPTY AAD as different from no AAD at all', async () => {
    // Empty is a value, not an absence: `aad !== undefined` is the branch, so a
    // zero-length AAD must still be authenticated on both sides.
    const key = await randomKey();
    const blob = await encrypt(key, utf8('dek'), new Uint8Array(0));
    await expect(decrypt(key, blob, new Uint8Array(0))).resolves.toEqual(utf8('dek'));
  });
});
