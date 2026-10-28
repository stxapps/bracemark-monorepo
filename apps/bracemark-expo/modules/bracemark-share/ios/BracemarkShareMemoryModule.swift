import ExpoModulesCore
import Foundation
import os

// THE SHARE EXTENSION'S MEMORY, READ FROM INSIDE IT.
//
// iOS kills an app extension at a hard per-process cap — on an iPhone 12, iOS
// 26.5, the kernel's own line is `exceeded mem limit: ActiveHard 120 MB
// (fatal)` — and the kill leaves the sheet simply gone: no error in Metro or
// Xcode, and often no report the phone will hand over. The simulator enforces no
// cap at all and its footprint is not a device's (docs/share-sheet.md, _the
// share extension has almost no memory to spare_). So the only honest number is
// the one this process reads about itself, on hardware:
//
//   - `footprint` — `phys_footprint`, the figure jetsam compares with the cap;
//   - `available` — `os_proc_available_memory()`, how far that footprint is
//     from the cap right now.
//
// `mark(label)` writes both to the unified log under subsystem
// `com.bracemark.share`, category `memory`, at the default level — so Console,
// filtered on `share-memory`, shows them from a dev build and a release build
// alike, with no Metro and no debugger attached. Each screen of the sheet marks
// itself as it mounts (share-kit.tsx), which turns "did it die?" into a
// headroom per screen. Numbers only: no URL, no title, nothing of the share.
//
// FUNCTIONS, NOT A VIEW, for the reason every native piece of this process is
// one (BracemarkShareKeyboardModule.swift): an Expo native view is the one thing
// here that costs memory in the tens of megabytes.
//
// iOS-only, and only the share extension calls it. The pod is linked into the
// app target too (BracemarkShare.podspec), where nothing does.
public final class BracemarkShareMemoryModule: Module {
  private static let log = Logger(subsystem: "com.bracemark.share", category: "memory")

  public func definition() -> ModuleDefinition {
    // The name is part of the JS contract (share-memory.ts).
    Name("BracemarkShareMemory")

    Function("mark") { (label: String) in
      let footprint = Self.footprintBytes()
      let available = os_proc_available_memory()
      Self.log.notice(
        "share-memory \(label, privacy: .public): footprint \(Self.mb(footprint), privacy: .public) MB, available \(Self.mb(UInt64(available)), privacy: .public) MB"
      )
    }
  }

  private static func mb(_ bytes: UInt64) -> String {
    String(format: "%.1f", Double(bytes) / 1_048_576)
  }

  // `phys_footprint` from TASK_VM_INFO: what Xcode's memory gauge shows and what
  // jetsam holds against the limit — not `resident_size`, which counts shared
  // and clean pages the kernel would never charge us for.
  private static func footprintBytes() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? info.phys_footprint : 0
  }
}
