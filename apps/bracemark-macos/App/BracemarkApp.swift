import SwiftUI

// The Mac app exists because Safari takes a browser extension only inside an app
// (docs/architecture.md, _apps_). Today it is one window that says whether the
// extension is on and opens Safari's settings; the extension itself is
// apps/bracemark-extension's Safari build, carried by the "Bracemark Extension"
// target.
@main
struct BracemarkApp: App {
  @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate

  var body: some Scene {
    Window("Bracemark", id: "main") {
      ContentView()
    }
    .windowResizability(.contentSize)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  // One window and nothing to do without it.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}
