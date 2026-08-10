import CryptoKit
import ExpoModulesCore

// File-level AES-256-GCM in the native layer — the implementation behind
// src/lib/file-crypto.ts. Reads/writes the FROZEN v1 blob frame
// `[0x01 || iv(12) || ciphertext || tag(16)]` (@stxapps/shared
// crypto/params.ts: BLOB_FORMAT_V1 / AES_GCM_IV_BYTES) — byte-compatible with
// the blobs the web client packs/unpacks in JS. CryptoKit's `combined`
// representation is exactly `nonce || ciphertext || tag`, so the frame is the
// version byte + `combined`, nothing more.
//
// CryptoKit GCM is one-shot (no streaming API): the whole file transits NATIVE
// memory — never the JS heap, which is the requirement. Writes are atomic
// (temp file + rename via `.atomic`), so a consumer can never observe
// partially-written output; GCM only authenticates at the end of `open`, and a
// failed tag throws before anything is written.

private let blobFormatV1: UInt8 = 0x01
private let ivBytes = 12
private let tagBytes = 16
private let keyBytes = 32

internal final class InvalidKeyException: Exception {
  override var reason: String {
    "key must be \(keyBytes) bytes of hex"
  }
}

internal final class UnknownBlobFormatException: Exception {
  override var reason: String {
    "unknown blob format version (expected 0x01)"
  }
}

internal final class TruncatedBlobException: Exception {
  override var reason: String {
    "encrypted file is too short to be a v1 blob"
  }
}

internal final class DecryptionFailedException: Exception {
  override var reason: String {
    "decryption failed — tampered file or wrong key"
  }
}

public class BracemarkFileCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BracemarkFileCrypto")

    // AsyncFunctions run on the module's background dispatch queue — the JS
    // thread never blocks on file IO or crypto.
    AsyncFunction("encryptFile") { (inputPath: String, outputPath: String, keyHex: String) in
      let key = try Self.symmetricKey(keyHex)
      let plaintext = try Data(contentsOf: Self.fileURL(inputPath))
      let sealed = try AES.GCM.seal(plaintext, using: key) // fresh random 12-byte nonce
      guard let combined = sealed.combined else {
        throw DecryptionFailedException()
      }
      var framed = Data(capacity: 1 + combined.count)
      framed.append(blobFormatV1)
      framed.append(combined)
      try framed.write(to: Self.fileURL(outputPath), options: .atomic)
    }

    AsyncFunction("decryptFile") { (inputPath: String, outputPath: String, keyHex: String) in
      let key = try Self.symmetricKey(keyHex)
      let framed = try Data(contentsOf: Self.fileURL(inputPath))
      guard framed.count >= 1 + ivBytes + tagBytes else {
        throw TruncatedBlobException()
      }
      // Reject unknown versions loudly — a wrong slice would otherwise feed
      // garbage to GCM and surface as a misleading "tampered" error.
      guard framed[framed.startIndex] == blobFormatV1 else {
        throw UnknownBlobFormatException()
      }
      let plaintext: Data
      do {
        let box = try AES.GCM.SealedBox(combined: framed.dropFirst(1))
        plaintext = try AES.GCM.open(box, using: key)
      } catch {
        throw DecryptionFailedException()
      }
      try plaintext.write(to: Self.fileURL(outputPath), options: .atomic)
    }
  }

  // expo-file-system hands out file:// URIs; plain absolute paths work too.
  private static func fileURL(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) {
      return url
    }
    return URL(fileURLWithPath: path)
  }

  private static func symmetricKey(_ hex: String) throws -> SymmetricKey {
    guard let data = hexData(hex), data.count == keyBytes else {
      throw InvalidKeyException()
    }
    return SymmetricKey(data: data)
  }

  private static func hexData(_ hex: String) -> Data? {
    guard hex.count % 2 == 0 else { return nil }
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
      data.append(byte)
      index = next
    }
    return data
  }
}
