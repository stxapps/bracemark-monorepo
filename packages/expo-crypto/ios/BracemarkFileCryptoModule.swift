import CryptoKit
import ExpoModulesCore

// File-level AES-256-GCM in the native layer — the implementation behind
// src/lib/file-crypto.ts. The framing itself lives in BlobFrame.swift (read its
// header for the frame and why it is a separate file); this is the expo boundary
// and nothing else: argument marshalling, the background queue, and the error
// mapping below.

internal final class InvalidKeyException: Exception {
  override var reason: String {
    "key must be \(BlobFrame.keyBytes) bytes of hex"
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

// BlobFrame throws a plain Swift enum so the tests can run without
// ExpoModulesCore (BlobFrame.swift, header). Everything JS can observe is minted
// here instead, so the messages that cross the bridge are unchanged by that split.
private func mapErrors<T>(_ body: () throws -> T) throws -> T {
  do {
    return try body()
  } catch let error as BlobFrameError {
    switch error {
    case .invalidKey: throw InvalidKeyException()
    case .unknownFormat: throw UnknownBlobFormatException()
    case .truncated: throw TruncatedBlobException()
    case .decryptionFailed: throw DecryptionFailedException()
    }
  }
}

public class BracemarkFileCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BracemarkFileCrypto")

    // AsyncFunctions run on the module's background dispatch queue — the JS
    // thread never blocks on file IO or crypto.
    AsyncFunction("encryptFile") { (inputPath: String, outputPath: String, keyHex: String) in
      try mapErrors {
        try BlobFrame.encryptFile(
          inputPath: inputPath,
          outputPath: outputPath,
          key: try BlobFrame.symmetricKey(keyHex)
        )
      }
    }

    AsyncFunction("decryptFile") { (inputPath: String, outputPath: String, keyHex: String) in
      try mapErrors {
        try BlobFrame.decryptFile(
          inputPath: inputPath,
          outputPath: outputPath,
          key: try BlobFrame.symmetricKey(keyHex)
        )
      }
    }
  }
}
