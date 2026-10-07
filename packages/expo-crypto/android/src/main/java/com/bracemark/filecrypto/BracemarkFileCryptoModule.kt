package com.bracemark.filecrypto

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// File-level AES-256-GCM in the native layer — the implementation behind
// src/lib/file-crypto.ts. The framing itself lives in BlobFrame.kt (read its
// header for the frame and why it is a separate file); this is the expo
// boundary and nothing else: argument marshalling, the background dispatcher,
// and the error mapping below.
//
// Written against streams, but no more constant-memory than iOS's one-shot
// CryptoKit on a device — see BlobFrame.encryptFile.

internal class InvalidKeyException :
  CodedException("key must be $KEY_BYTES bytes of hex")

internal class UnknownBlobFormatException(version: Int) :
  CodedException("unknown blob format version: $version (expected 0x01)")

internal class TruncatedBlobException :
  CodedException("encrypted file is too short to be a v1 blob")

internal class DecryptionFailedException(cause: Throwable?) :
  CodedException("decryption failed — tampered file or wrong key", cause)

// BlobFrame throws plain exceptions so the unit tests can run without
// expo-modules-core (BlobFrame.kt, header). Everything JS can observe is minted
// here instead, so the messages and codes that cross the bridge are unchanged by
// that split.
private inline fun <T> mapErrors(body: () -> T): T =
  try {
    body()
  } catch (err: BlobFrameError) {
    throw when (err) {
      is BlobFrameError.InvalidKey -> InvalidKeyException()
      is BlobFrameError.UnknownFormat -> UnknownBlobFormatException(err.version)
      is BlobFrameError.Truncated -> TruncatedBlobException()
      is BlobFrameError.DecryptionFailed -> DecryptionFailedException(err.cause)
      is BlobFrameError.TempRenameFailed -> CodedException(err.message ?: "write failed")
    }
  }

class BracemarkFileCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BracemarkFileCrypto")

    // AsyncFunctions run on the module's background dispatcher — the JS thread
    // never blocks on file IO or crypto.
    AsyncFunction("encryptFile") { inputPath: String, outputPath: String, keyHex: String ->
      mapErrors {
        BlobFrame.encryptFile(
          BlobFrame.resolve(inputPath),
          BlobFrame.resolve(outputPath),
          BlobFrame.secretKey(keyHex),
        )
      }
    }

    AsyncFunction("decryptFile") { inputPath: String, outputPath: String, keyHex: String ->
      mapErrors {
        BlobFrame.decryptFile(
          BlobFrame.resolve(inputPath),
          BlobFrame.resolve(outputPath),
          BlobFrame.secretKey(keyHex),
        )
      }
    }
  }
}
