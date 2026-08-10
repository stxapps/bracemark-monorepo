import { requireNativeModule } from 'expo-modules-core';

import { bytesToHex } from '@stxapps/shared';

// File-level AES-256-GCM: whole files encrypted/decrypted path-to-path in the
// native layer (Swift CryptoKit / Kotlin javax.crypto — see ../../ios and
// ../../android), so the bytes NEVER enter the JS heap. This is the mobile
// counterpart of web-react's sync/crypto.ts pack/unpack + web-crypto AES: the
// native side reads/writes the frozen v1 blob frame
// `[BLOB_FORMAT_V1 || iv(AES_GCM_IV_BYTES) || ciphertext+tag]`
// (@stxapps/shared crypto/params.ts), byte-compatible with what web packs in
// JS — one wire format, produced on whichever side of the JSI boundary suits
// the payload size.
//
// Usage shape (docs/data-lifecycle.md local-first model): content is stored
// DECRYPTED on device (the Dexie-`data` analogue — e.g. an image file an
// <Image>/expo-image renders straight from its file:// uri). decryptFile runs
// once per download (R2 .enc → plaintext file); encryptFile runs per upload
// (plaintext file → temp .enc → FileSystem.uploadAsync to the presigned URL).
//
// Both functions write to a temp file and rename on success — GCM only
// authenticates at the END of the stream, so a consumer can never observe
// partially-written (unauthenticated) plaintext. A failed tag rejects and
// cleans up the temp file.
interface NativeFileCrypto {
  encryptFile(inputPath: string, outputPath: string, keyHex: string): Promise<void>;
  decryptFile(inputPath: string, outputPath: string, keyHex: string): Promise<void>;
}

// Resolved lazily so merely importing this package never touches the native
// runtime (jest, or a future non-prebuild context, can import the pure parts).
let native: NativeFileCrypto | undefined;
function getNative(): NativeFileCrypto {
  return (native ??= requireNativeModule<NativeFileCrypto>('BracemarkFileCrypto'));
}

// Paths may be absolute paths or file:// URIs (expo-file-system hands out the
// latter); the native side normalizes. `key` is the raw 32-byte AES key
// (Account.encryptionKey) — hex-encoded across the boundary because Hermes has
// no btoa and hex is already the contract's byte encoding (@stxapps/shared).
export async function encryptFile(
  inputPath: string,
  outputPath: string,
  key: Uint8Array,
): Promise<void> {
  await getNative().encryptFile(inputPath, outputPath, bytesToHex(key));
}

export async function decryptFile(
  inputPath: string,
  outputPath: string,
  key: Uint8Array,
): Promise<void> {
  await getNative().decryptFile(inputPath, outputPath, bytesToHex(key));
}
