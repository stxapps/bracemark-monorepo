import SafariServices
import SwiftUI

// The extension target's bundle id: BRACEMARK_EXTENSION_ID in Config/Base.xcconfig.
private let extensionIdentifier = "com.bracemark.app.safari-extension"

private enum ExtensionState {
  case checking, on, off, unknown

  var message: String {
    switch self {
    case .checking:
      "Checking Safari…"
    case .on:
      "Bracemark is on in Safari."
    case .off:
      "Bracemark is off in Safari. Turn it on in Safari Settings, under Extensions."
    case .unknown:
      "Safari didn’t say whether Bracemark is on. Look in Safari Settings, under Extensions."
    }
  }
}

struct ContentView: View {
  @State private var state = ExtensionState.checking

  var body: some View {
    VStack(spacing: 16) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .frame(width: 96, height: 96)
        .accessibilityHidden(true)

      Text("Bracemark for Safari")
        .font(.title2.weight(.semibold))

      Text(state.message)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)

      Button("Open Safari Settings", action: openSafariSettings)
        .keyboardShortcut(.defaultAction)
        .controlSize(.large)

      Text("Then click the Bracemark button in Safari’s toolbar to sign in and save links.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(32)
    .frame(width: 420)
    .onAppear(perform: refresh)
    // The user turns it on in Safari, then comes back here: say so at once.
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      refresh()
    }
  }

  private func refresh() {
    SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionIdentifier) { found, error in
      DispatchQueue.main.async {
        if let found, error == nil {
          state = found.isEnabled ? .on : .off
        } else {
          state = .unknown
        }
      }
    }
  }

  private func openSafariSettings() {
    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionIdentifier) { _ in }
  }
}
