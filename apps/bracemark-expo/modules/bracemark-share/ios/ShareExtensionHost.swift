import Foundation

// THE SEAM BETWEEN THIS POD'S MODULES AND THE iOS SHARE EXTENSION'S CONTROLLER.
//
// The share extension's view controller (`ShareViewController`,
// modules/bracemark-share/ios-extension/) is compiled into the extension TARGET,
// not into this pod, so nothing here can name its class. It can name this pod,
// though — the extension target links it (BracemarkShare.podspec) and imports
// it — so the controller registers itself here as it loads, and the modules
// reach it through this protocol.
//
// This replaced a pair of NotificationCenter names (`close`, and a
// `bracemarkShareSwipeHold` observer patched into the vendored library's
// controller by a config plugin). A string that nobody observes is silent; a
// controller that stops conforming to this protocol does not compile.
//
// In the APP process `current` is nil — no share extension controller ever
// loads there — so every call through it is a no-op, which is what a stray call
// from the main app should be. Main-thread only, on both sides: the controller
// registers from `viewDidLoad`, and the modules hop to the main queue before
// calling, because both requests change UIKit state.
public protocol ShareExtensionHosting: AnyObject {
  /// Complete the extension request and tear the React Native surface down.
  func close()
  /// Hold the host sheet's swipe-to-dismiss off (`isModalInPresentation`).
  func setSwipeHeld(_ held: Bool)
}

public enum ShareExtensionHost {
  public static weak var current: ShareExtensionHosting?
}
