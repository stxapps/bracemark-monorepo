import { createCipheriv, createDecipheriv, randomBytes } from 'react-native-quick-crypto';
import { Buffer } from '@craftzdog/react-native-buffer';

import { AES_GCM_IV_BYTES } from '@stxapps/shared';

export interface EncryptedBlob {
  iv: Uint8Array;
  ciphertext: Uint8Array; // includes the appended 128-bit GCM auth tag
}

// The GCM tag web-crypto's ciphertext carries. Web Crypto appends the tag to
// the ciphertext; Node-style APIs (quick-crypto) return it separately via
// getAuthTag/setAuthTag — so we append/split it here to keep EncryptedBlob
// byte-identical across platforms (the wrapped-DEK rows and packed sync blobs
// are one wire format, not two).
const TAG_BYTES = 16;

// AES-256-GCM — the Expo sibling of web-crypto's encrypt/decrypt, same
// semantics: fresh random 96-bit IV per call (AES_GCM_IV_BYTES, the frozen
// blob contract in @stxapps/shared), optional AAD (used to bind a wrapped DEK
// to its doorType — see dekWrapAad), decrypt throws on a failed tag. The one
// platform difference: keys are raw 32-byte Uint8Arrays, not CryptoKey —
// native has no non-extractable handle; at-rest protection is SecureStore's
// job (Keychain / Android Keystore), not the key object's.
//
// async to mirror web-crypto's signatures (the quick-crypto calls themselves
// are synchronous JSI — fine for the small blobs this handles; whole files go
// through the native BracemarkFileCrypto module instead, see file-crypto.ts).
export async function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<EncryptedBlob> {
  const iv = new Uint8Array(randomBytes(AES_GCM_IV_BYTES));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // setAAD/setAuthTag are typed against quick-crypto's Buffer (the RN Buffer
  // polyfill it ships), so wrap; Buffer.from copies, never aliases.
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const head = cipher.update(plaintext);
  const tail = cipher.final();
  const tag = cipher.getAuthTag();

  const ciphertext = new Uint8Array(head.length + tail.length + tag.length);
  ciphertext.set(new Uint8Array(head.buffer, head.byteOffset, head.length), 0);
  ciphertext.set(new Uint8Array(tail.buffer, tail.byteOffset, tail.length), head.length);
  ciphertext.set(new Uint8Array(tag.buffer, tag.byteOffset, tag.length), head.length + tail.length);
  return { iv, ciphertext };
}

export async function decrypt(
  key: Uint8Array,
  { iv, ciphertext }: EncryptedBlob,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag));
  const head = decipher.update(body);
  const tail = decipher.final(); // throws here if the tag fails (tamper / wrong key)

  const plaintext = new Uint8Array(head.length + tail.length);
  plaintext.set(new Uint8Array(head.buffer, head.byteOffset, head.length), 0);
  plaintext.set(new Uint8Array(tail.buffer, tail.byteOffset, tail.length), head.length);
  return plaintext;
}
