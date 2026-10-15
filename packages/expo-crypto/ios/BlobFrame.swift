import CryptoKit
import Foundation

// The FROZEN v1 blob frame `[0x01 || iv(12) || ciphertext || tag(16)]`
// (@stxapps/shared crypto/params.ts: BLOB_FORMAT_V1 / AES_GCM_IV_BYTES), split
// out of BracemarkFileCryptoModule so it can be TESTED. Sealed with AAD = [0x01]
// + UTF-8 of the blob's sync path (shared crypto/blob-aad.ts, blobAad), so a
// blob opens only under the path it was written to.
//
// The split is the whole point. These constants and the AAD are a hand-copy of the TS
// ones — nothing links them, so a re-value on either side diverges in silence,
// and until BlobFrameTests existed the only thing standing behind this framer
// was the comment claiming it matched. Inside the Module class it was
// unreachable without the expo runtime: importing ExpoModulesCore means an app,
// a simulator and a build. Out here it is Foundation + CryptoKit, both of which
// macOS has, so `swift test` runs it in a second (Package.swift, ../apple-tests).
//
// Errors are a plain Swift enum rather than expo's `Exception` for the same
// reason — `Exception` is what would have dragged ExpoModulesCore back in. The
// Module maps them, so what JS sees is unchanged.
//
// CryptoKit GCM is one-shot (no streaming API): the whole file transits NATIVE
// memory — never the JS heap, which is the requirement. Android is written
// against streams and ends up in the same place on a device; see the Kotlin
// twin's encryptFile.
enum BlobFrameError: Error, Equatable {
  case invalidKey
  case unknownFormat(UInt8)
  case truncated
  case decryptionFailed
}

enum BlobFrame {
  static let formatV1: UInt8 = 0x01
  static let ivBytes = 12
  static let tagBytes = 16
  static let keyBytes = 32

  // blobAad(path) in @stxapps/shared: the version byte, then the path's UTF-8.
  static func aad(path: String) -> Data {
    var aad = Data([formatV1])
    aad.append(contentsOf: Array(path.utf8))
    return aad
  }

  // `combined` is exactly `nonce || ciphertext || tag`, so the frame is the
  // version byte + `combined`, nothing more.
  static func seal(_ plaintext: Data, using key: SymmetricKey, path: String) throws -> Data {
    // fresh random 12-byte nonce
    let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad(path: path))
    guard let combined = sealed.combined else { throw BlobFrameError.decryptionFailed }
    var framed = Data(capacity: 1 + combined.count)
    framed.append(formatV1)
    framed.append(combined)
    return framed
  }

  static func open(_ framed: Data, using key: SymmetricKey, path: String) throws -> Data {
    guard framed.count >= 1 + ivBytes + tagBytes else { throw BlobFrameError.truncated }
    // Reject unknown versions loudly — a wrong slice would otherwise feed
    // garbage to GCM and surface as a misleading "tampered" error.
    let version = framed[framed.startIndex]
    guard version == formatV1 else { throw BlobFrameError.unknownFormat(version) }
    do {
      let box = try AES.GCM.SealedBox(combined: framed.dropFirst(1))
      // A blob served under another path fails here, as a wrong tag.
      return try AES.GCM.open(box, using: key, authenticating: aad(path: path))
    } catch {
      throw BlobFrameError.decryptionFailed
    }
  }

  // expo-file-system hands out file:// URIs; plain absolute paths work too.
  static func fileURL(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) {
      return url
    }
    return URL(fileURLWithPath: path)
  }

  static func symmetricKey(_ hex: String) throws -> SymmetricKey {
    guard let data = hexData(hex), data.count == keyBytes else { throw BlobFrameError.invalidKey }
    return SymmetricKey(data: data)
  }

  static func hexData(_ hex: String) -> Data? {
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

  // Writes are atomic (`.atomic` is a temp file + rename), so a consumer can
  // never observe partially-written output; GCM only authenticates at the end of
  // `open`, and a failed tag throws before anything is written.
  // `blobPath` is the sync path (`files/{id}.enc`), not either file path.
  static func encryptFile(
    inputPath: String, outputPath: String, key: SymmetricKey, blobPath: String
  ) throws {
    let plaintext = try Data(contentsOf: fileURL(inputPath))
    try seal(plaintext, using: key, path: blobPath)
      .write(to: fileURL(outputPath), options: .atomic)
  }

  static func decryptFile(
    inputPath: String, outputPath: String, key: SymmetricKey, blobPath: String
  ) throws {
    let framed = try Data(contentsOf: fileURL(inputPath))
    try open(framed, using: key, path: blobPath).write(to: fileURL(outputPath), options: .atomic)
  }
}
