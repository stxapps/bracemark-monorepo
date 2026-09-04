package com.bracemark.filecrypto

import java.io.File
import java.net.URI
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// The FROZEN v1 blob frame `[0x01 || iv(12) || ciphertext || tag(16)]`
// (@stxapps/shared crypto/params.ts: BLOB_FORMAT_V1 / AES_GCM_IV_BYTES), split
// out of BracemarkFileCryptoModule so it can be TESTED.
//
// The split is the whole point. These four constants are a hand-copy of the TS
// ones — nothing links them, so a re-value on either side diverges in silence,
// and until BlobFrameTest existed the only thing standing behind this framer was
// the comment claiming it matched. Inside the Module class it was untestable:
// `ModuleDefinition` needs the expo runtime, so reaching the framer meant
// booting an app. Out here it is plain javax.crypto + java.io, which the JVM
// already has — `src/test` runs it in milliseconds with no emulator, against the
// same golden vector web-crypto asserts (contract-vectors.json).
//
// Errors are plain exceptions rather than expo's CodedException for the same
// reason: CodedException would drag expo-modules-core onto the unit-test
// classpath. The Module maps these back, so what JS sees is unchanged.
internal const val BLOB_FORMAT_V1 = 0x01
internal const val IV_BYTES = 12
internal const val TAG_BYTES = 16
internal const val TAG_BITS = TAG_BYTES * 8
internal const val KEY_BYTES = 32
private const val COPY_BUFFER_BYTES = 64 * 1024

internal sealed class BlobFrameError(message: String, cause: Throwable? = null) :
  Exception(message, cause) {
  internal class InvalidKey : BlobFrameError("key must be $KEY_BYTES bytes of hex")
  internal class UnknownFormat(val version: Int) :
    BlobFrameError("unknown blob format version: $version (expected 0x01)")
  internal class Truncated : BlobFrameError("encrypted file is too short to be a v1 blob")
  internal class DecryptionFailed(cause: Throwable?) :
    BlobFrameError("decryption failed — tampered file or wrong key", cause)
  internal class TempRenameFailed : BlobFrameError("could not move temp file into place")
}

internal object BlobFrame {
  // expo-file-system hands out file:// URIs; plain absolute paths work too.
  fun resolve(path: String): File = if (path.startsWith("file://")) File(URI(path)) else File(path)

  fun secretKey(hex: String): SecretKeySpec {
    if (hex.length != KEY_BYTES * 2) throw BlobFrameError.InvalidKey()
    val bytes = ByteArray(KEY_BYTES) { i ->
      val hi = Character.digit(hex[2 * i], 16)
      val lo = Character.digit(hex[2 * i + 1], 16)
      if (hi < 0 || lo < 0) throw BlobFrameError.InvalidKey()
      ((hi shl 4) or lo).toByte()
    }
    return SecretKeySpec(bytes, "AES")
  }

  // Streams through Cipher{Input,Output}Stream in 64 KiB chunks — constant
  // memory, and the file bytes never enter the JS heap.
  fun encryptFile(inFile: File, outFile: File, key: SecretKeySpec) {
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

  fun decryptFile(inFile: File, outFile: File, key: SecretKeySpec) {
    inFile.inputStream().use { framed ->
      val version = framed.read()
      if (version == -1) throw BlobFrameError.Truncated()
      // Reject unknown versions loudly — a wrong slice would otherwise feed
      // garbage to GCM and surface as a misleading "tampered" error.
      if (version != BLOB_FORMAT_V1) throw BlobFrameError.UnknownFormat(version)

      val iv = ByteArray(IV_BYTES)
      var read = 0
      while (read < IV_BYTES) {
        val n = framed.read(iv, read, IV_BYTES - read)
        if (n == -1) throw BlobFrameError.Truncated()
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
          throw BlobFrameError.DecryptionFailed(err)
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
        if (!tmp.renameTo(outFile)) throw BlobFrameError.TempRenameFailed()
      }
    } catch (err: Throwable) {
      tmp.delete()
      throw err
    }
  }
}
