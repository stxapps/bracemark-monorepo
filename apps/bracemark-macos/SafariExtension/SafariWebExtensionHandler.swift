import Foundation

// The extension's native side, which every Safari web extension has to carry.
// Bracemark's browser extension never talks to it — it asks for no
// `nativeMessaging` permission, and everything it does runs in Safari — so it
// answers any request with nothing.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
  func beginRequest(with context: NSExtensionContext) {
    context.completeRequest(returningItems: [], completionHandler: nil)
  }
}
