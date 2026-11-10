import ExpoModulesCore
import Foundation

// HOLDING THE SYSTEM'S SWIPE-TO-DISMISS OFF, ON REQUEST FROM JS.
//
// The host presents the iOS share extension inside a sheet of its own, and that
// sheet answers a downward drag anywhere on it — a short one settles back, a
// long one dismisses the whole sheet and the unsaved share with it. On the list
// and tag pickers "down" means "scroll the list", so they ask for the swipe to
// be held off while they are up (docs/share-sheet.md, _the pickers hold the
// system's swipe off_).
//
// `isModalInPresentation` is UIKit's own lever for exactly this, and it lives
// on the presented VIEW CONTROLLER — which this module cannot name: the
// controller is `ShareViewController` (modules/bracemark-share/ios-extension/),
// compiled into the extension target rather than this pod, and there is no
// window to walk down from (`UIApplication.shared` does not exist in an
// app-extension process). So the controller registers itself as
// `ShareExtensionHost.current` and this module asks it to set its own flag.
//
// ⚠ IT IS A FUNCTION AND NOT A VIEW, and the first version was a view. A
// sizeless Expo view whose `didMoveToWindow` walked the responder chain to the
// controller worked on the simulator and killed the share extension on an
// iPhone the moment a picker opened — no crash report, no error, the sheet just
// gone. Mounting the first Expo native view in this process costs ~14MB
// (simulator: a picker is +4MB without it, +18MB with), and the share extension
// runs close to iOS's per-process memory limit for app extensions — 120MB on an
// iPhone 12 — which the simulator does not enforce (docs/share-sheet.md, _the
// share extension has almost no memory to spare_). Nothing in this process may
// spend memory like that; a module function costs nothing measurable.
//
// iOS-only, and only the share extension calls it — the pod is linked into the
// app target too (BracemarkShare.podspec), where `ShareExtensionHost.current` is
// nil and the call does nothing.
public final class BracemarkShareSwipeGuardModule: Module {
  public func definition() -> ModuleDefinition {
    // The name is part of the JS contract (share-swipe-guard.tsx).
    Name("BracemarkShareSwipeGuard")

    Function("setHeld") { (held: Bool) in
      // On main because the controller flips a UIKit property.
      DispatchQueue.main.async {
        ShareExtensionHost.current?.setSwipeHeld(held)
      }
    }
  }
}
