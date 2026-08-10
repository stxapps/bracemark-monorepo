import { AES_GCM_IV_BYTES } from '@stxapps/shared';

export interface EncryptedBlob {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>; // includes the appended 128-bit GCM auth tag
}

// AES-256-GCM. A fresh random 96-bit IV (AES_GCM_IV_BYTES — part of the
// cross-platform blob contract in @stxapps/shared) per call — never reuse an IV
// with the same key. Web Crypto appends the auth tag to the ciphertext on
// encrypt and verifies it on decrypt (decrypt throws if the data was tampered
// with).
//
// `aad` (additional authenticated data) is authenticated but NOT encrypted:
// decrypt must supply byte-identical `aad` or the tag fails. Use it to bind a
// ciphertext to its context — e.g. a wrapped DEK to its doorType (see
// dekWrapAad in @stxapps/shared).
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  // Chrome rejects `additionalData: undefined` ("Not a BufferSource") — unlike
  // the WebIDL spec / Node, Blink coerces the member whenever the key is
  // present. Omit the key entirely when there's no AAD.
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad !== undefined) params.additionalData = aad;
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(params, key, plaintext));
  return { iv, ciphertext };
}

export async function decrypt(
  key: CryptoKey,
  { iv, ciphertext }: EncryptedBlob,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad !== undefined) params.additionalData = aad;
  return new Uint8Array(await crypto.subtle.decrypt(params, key, ciphertext));
}
