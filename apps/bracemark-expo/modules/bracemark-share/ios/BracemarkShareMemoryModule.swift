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
// `mark(label, stats)` writes both to the unified log under subsystem
// `com.bracemark.share`, category `memory`, at the default level — so Console,
// filtered on `share-memory`, shows them from a dev build and a release build
// alike, with no Metro and no debugger attached. Each screen of the sheet marks
// itself as it mounts (share-kit.tsx), which turns "did it die?" into a
// headroom per screen. `stats` is share-memory.ts's: the Hermes heap, with a mount
// count already folded into the label — and the process's AGE is added here, so the line also times the boot, and a process
// iOS reused for a second share shows up as one that is older than its sheet.
// The controller marks moments of its own through `logMark` (`controller` as it
// loads, `copy-file` with the read-mode copy's length as it writes it to a file,
// `root` as the React root mounts) and every memory warning
// (`memory-warning`), so the boot's two overlapping waits and a warning land in
// the same filter. Numbers only: no URL, no title, nothing of the share — the
// stats are a map of numbers, formatted under keys this file knows.
//
// FUNCTIONS, NOT A VIEW, for the reason every native piece of this process is
// one (BracemarkShareKeyboardModule.swift): an Expo native view is the one thing
// here that costs memory in the tens of megabytes.
//
// Only the share extension calls it on iOS. The pod is linked into the app target
// too (BracemarkShare.podspec), where nothing does. Android has a module of the
// same name (BracemarkShareMemoryModule.kt) with its own process's numbers.
public final class BracemarkShareMemoryModule: Module {
  private static let log = Logger(subsystem: "com.bracemark.share", category: "memory")

  public func definition() -> ModuleDefinition {
    // The name is part of the JS contract (share-memory.ts).
    Name("BracemarkShareMemory")

    Function("mark") { (label: String, stats: [String: Double]) in
      Self.logMark(label, stats: stats)
    }
  }

  /// One `share-memory` line. Public for the share extension's controller, which
  /// links this pod and marks its own moments (ShareViewController.swift).
  public static func logMark(_ label: String, stats: [String: Double] = [:]) {
    let footprint = footprintBytes()
    let available = os_proc_available_memory()
    let tail = format(stats)
    log.notice(
      "share-memory \(label, privacy: .public): footprint \(mb(footprint), privacy: .public) MB, available \(mb(UInt64(available)), privacy: .public) MB\(tail, privacy: .public)"
    )
  }

  // The keys share-memory.ts sends, in the order the line prints them. A key this
  // list does not know is dropped rather than printed, so nothing new reaches the
  // log without being named here.
  private static func format(_ stats: [String: Double]) -> String {
    var parts: [String] = []
    if let used = stats["jsAllocated"], let heap = stats["jsHeap"] {
      parts.append("js \(mb(UInt64(used)))/\(mb(UInt64(heap))) MB")
    }
    if let malloc = stats["jsMalloc"] { parts.append("js-ext \(mb(UInt64(malloc))) MB") }
    if let gcs = stats["gcs"] { parts.append("gcs \(Int(gcs))") }
    if let chars = stats["copyChars"] { parts.append("copy \(Int((chars / 1000).rounded())) K") }
    if let age = processAgeSeconds() { parts.append(String(format: "age %.1f s", age)) }
    return parts.isEmpty ? "" : ", " + parts.joined(separator: ", ")
  }

  // Seconds since this process started, from the kernel's own record of it.
  private static func processAgeSeconds() -> Double? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0 else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
    return Date().timeIntervalSince1970 - started
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
