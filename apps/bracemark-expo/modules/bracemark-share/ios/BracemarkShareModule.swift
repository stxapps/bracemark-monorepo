import ExpoModulesCore
import Foundation

// The share sheet's one JS-callable control on iOS: dismiss the share extension.
// The iOS twin of android/…/BracemarkShareModule.kt — same module name, same
// `close()`, so share-host.ts makes one call on both platforms.
//
// It asks the extension's controller through `ShareExtensionHost`, which is nil
// in the app process: a stray call from the main app does nothing, as the
// Android half refuses to finish anything but its ShareActivity.
public final class BracemarkShareModule: Module {
  public func definition() -> ModuleDefinition {
    // The name is part of the JS contract (share-host.ts), shared with Android.
    Name("BracemarkShare")

    // A synchronous Function runs on the JS thread; completing the extension
    // request is UIKit's, hence the hop to main.
    Function("close") {
      DispatchQueue.main.async {
        ShareExtensionHost.current?.close()
      }
    }
  }
}
