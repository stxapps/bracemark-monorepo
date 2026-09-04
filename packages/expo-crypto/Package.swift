// swift-tools-version:5.9
import PackageDescription

// Exists ONLY to run BlobFrameTests on the host — `swift test` in this
// directory. The app is built by CocoaPods from ios/BracemarkCrypto.podspec, and
// expo autolinking finds this module through expo-module.config.json; neither
// reads this file. It compiles exactly one source, ios/BlobFrame.swift, which is
// the half of the file-crypto module that has no ExpoModulesCore dependency —
// see that file's header for why the framer was split out.
let package = Package(
  name: "BracemarkBlobFrame",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "BracemarkBlobFrame", path: "ios", sources: ["BlobFrame.swift"]),
    .testTarget(name: "BracemarkBlobFrameTests", dependencies: ["BracemarkBlobFrame"], path: "apple-tests"),
  ]
)
