package com.bracemark.filecrypto

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// File-level AES-256-GCM in the native layer — the implementation behind
// src/lib/file-crypto.ts. Reads/writes the FROZEN v1 blob frame
// `[0x01 || iv(12) || ciphertext || tag(16)]` (@stxapps/shared
// crypto/params.ts: BLOB_FORMAT_V1 / AES_GCM_IV_BYTES) — byte-compatible with
// the blobs the web client packs/unpacks in JS. javax.crypto's GCM appends the
// tag to the ciphertext stream, which is exactly the frame's tail.
//
// Unlike iOS (CryptoKit is one-shot), this side genuinely STREAMS through
// Cipher{Input,Output}Stream in 64 KiB chunks — constant memory, and the file
// bytes never enter the JS heap. Output goes to a temp file renamed into place
// on success: GCM only authenticates at the END of the stream, so a consumer
// must never observe partially-written (unauthenticated) plaintext. A failed
// tag deletes the temp file and rejects.

private const val BLOB_FORMAT_V1 = 0x01
private const val IV_BYTES = 12
private const val TAG_BYTES = 16
private const val TAG_BITS = TAG_BYTES * 8
private const val KEY_BYTES = 32
private const val COPY_BUFFER_BYTES = 64 * 1024

internal class InvalidKeyException :
  CodedException("key must be $KEY_BYTES bytes of hex")

internal class UnknownBlobFormatException(version: Int) :
  CodedException("unknown blob format version: $version (expected 0x01)")

internal class TruncatedBlobException :
  CodedException("encrypted file is too short to be a v1 blob")

internal class DecryptionFailedException(cause: Throwable?) :
  CodedException("decryption failed — tampered file or wrong key", cause)

class BracemarkFileCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BracemarkFileCrypto")

    // AsyncFunctions run on the module's background dispatcher — the JS thread
    // never blocks on file IO or crypto.
    AsyncFunction("encryptFile") { inputPath: String, outputPath: String, keyHex: String ->
      encryptFile(resolve(inputPath), resolve(outputPath), secretKey(keyHex))
    }

    AsyncFunction("decryptFile") { inputPath: String, outputPath: String, keyHex: String ->
      decryptFile(resolve(inputPath), resolve(outputPath), secretKey(keyHex))
    }
  }

  private fun encryptFile(inFile: File, outFile: File, key: SecretKeySpec) {
    val iv = ByteArray(IV_BYTES).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))

    writeViaTemp(outFile) { tmp ->
      tmp.outputStream().use { out ->
        out.write(BLOB_FORMAT_V1)
        out.write(iv)
        // close() runs doFinal(), appending the 16-byte tag — the frame's tail.
        CipherOutputStream(out, cipher).use { sealed ->
          inFile.inputStream().use { it.copyTo(sealed, COPY_BUFFER_BYTES) }
        }
      }
    }
  }

  private fun decryptFile(inFile: File, outFile: File, key: SecretKeySpec) {
    inFile.inputStream().use { framed ->
      val version = framed.read()
      if (version == -1) throw TruncatedBlobException()
      // Reject unknown versions loudly — a wrong slice would otherwise feed
      // garbage to GCM and surface as a misleading "tampered" error.
      if (version != BLOB_FORMAT_V1) throw UnknownBlobFormatException(version)

      val iv = ByteArray(IV_BYTES)
      var read = 0
      while (read < IV_BYTES) {
        val n = framed.read(iv, read, IV_BYTES - read)
        if (n == -1) throw TruncatedBlobException()
        read += n
      }

      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))

      writeViaTemp(outFile) { tmp ->
        try {
          tmp.outputStream().use { out ->
            // CipherInputStream surfaces a failed GCM tag as an IOException
            // (cause: AEADBadTagException) from the final read.
            CipherInputStream(framed, cipher).use { it.copyTo(out, COPY_BUFFER_BYTES) }
          }
        } catch (err: Exception) {
          throw DecryptionFailedException(err)
        }
      }
    }
  }

  // Write through `<name>.tmp` and rename into place, deleting the temp on any
  // failure — the output path either holds the complete, authenticated result
  // or its previous content, never a partial write.
  private inline fun writeViaTemp(outFile: File, write: (tmp: File) -> Unit) {
    outFile.parentFile?.mkdirs()
    val tmp = File(outFile.parentFile, outFile.name + ".tmp")
    try {
      write(tmp)
      if (!tmp.renameTo(outFile)) {
        outFile.delete()
        if (!tmp.renameTo(outFile)) throw CodedException("could not move temp file into place")
      }
    } catch (err: Throwable) {
      tmp.delete()
      throw err
    }
  }

  // expo-file-system hands out file:// URIs; plain absolute paths work too.
  private fun resolve(path: String): File =
    if (path.startsWith("file://")) File(URI(path)) else File(path)

  private fun secretKey(hex: String): SecretKeySpec {
    if (hex.length != KEY_BYTES * 2) throw InvalidKeyException()
    val bytes = ByteArray(KEY_BYTES) { i ->
      val hi = Character.digit(hex[2 * i], 16)
      val lo = Character.digit(hex[2 * i + 1], 16)
      if (hi < 0 || lo < 0) throw InvalidKeyException()
      ((hi shl 4) or lo).toByte()
    }
    return SecretKeySpec(bytes, "AES")
  }
}
