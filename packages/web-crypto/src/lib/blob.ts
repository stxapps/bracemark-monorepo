// The v1 blob frame for ENTITY blobs — packs/unpacks
// `[version(1) || iv(12) || ciphertext+tag]` around this package's AES-256-GCM
// (aes.ts). Web stores content DECRYPTED in Dexie and decrypts in JS, so unlike
// expo there's no native file-crypto counterpart — this is the only framer. The
// sync engine (web-react, docs/local-first-sync.md "layer 2") calls
// encryptEntity before a PUT / decryptEntity after a GET, so plaintext never
// crosses the network.

import { AES_GCM_IV_BYTES, BLOB_FORMAT_V1 } from '@stxapps/shared';

import { decrypt, encrypt, type EncryptedBlob } from './aes';

// On-the-wire R2 blob layout: `[version(1) || iv(12) || ciphertext+tag]` (the
// 128-bit GCM tag is already appended to the ciphertext by aes.ts). The
// constants are the cross-platform contract in @stxapps/shared — every platform
// must pack/unpack identically, forever (contract-vectors.spec.ts asserts this
// framing against the golden vectors). encrypt() mints a FRESH random IV per
// call, so it can't be derived — we store it beside the ciphertext and slice it
// back off on read. The version byte is format-change insurance: a future layout
// becomes a new constant and a new unpack branch, decoded side by side with v1,
// instead of a big-bang re-encrypt migration.
const HEADER_BYTES = 1 + AES_GCM_IV_BYTES;

export function packBlob({ iv, ciphertext }: EncryptedBlob): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES + ciphertext.length);
  out[0] = BLOB_FORMAT_V1;
  out.set(iv, 1);
  out.set(ciphertext, HEADER_BYTES);
  return out;
}

export function unpackBlob(bytes: Uint8Array): EncryptedBlob {
  // Reject unknown versions loudly — a wrong slice would otherwise feed garbage
  // to GCM and surface as a misleading "tampered" error. Seeing this means a
  // newer client wrote a format this build doesn't know.
  if (bytes[0] !== BLOB_FORMAT_V1) {
    throw new Error(`Unknown blob format version: ${bytes[0]}`);
  }
  // Copy each slice into its own ArrayBuffer-backed view so the types line up
  // with aes.ts's `Uint8Array<ArrayBuffer>` and the IV/ciphertext don't alias
  // the source buffer.
  return {
    iv: new Uint8Array(bytes.subarray(1, HEADER_BYTES)),
    ciphertext: new Uint8Array(bytes.subarray(HEADER_BYTES)),
  };
}

// Decrypted entity bytes → one packed R2 blob, under the account data key.
export async function encryptEntity(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return packBlob(await encrypt(key, new Uint8Array(data)));
}

// A packed R2 blob → decrypted entity bytes. Throws if the GCM tag fails (tamper
// or wrong key), which the caller treats as a failed download.
export async function decryptEntity(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  return decrypt(key, unpackBlob(blob));
}
