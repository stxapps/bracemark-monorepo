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
// controller is expo-share-extension's `ShareExtensionViewController`, compiled
// into the extension target rather than this pod, and there is no window to
// walk down from (`UIApplication.shared` does not exist in an app-extension
// process). So this module only POSTS, and the controller sets its own flag:
// plugins/with-share-extension-swipe-hold.js patches an observer for this
// notification into it, beside the `close` observer the library already
// carries. That is the library's own module-to-controller channel, reused.
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
// app target too (BracemarkShare.podspec), where nothing observes the name.
public final class BracemarkShareSwipeGuardModule: Module {
  // Part of the contract with plugins/with-share-extension-swipe-hold.js, which
  // spells the same string into the controller.
  private static let holdNotification = Notification.Name("bracemarkShareSwipeHold")

  public func definition() -> ModuleDefinition {
    // The name is part of the JS contract (share-swipe-guard.tsx).
    Name("BracemarkShareSwipeGuard")

    Function("setHeld") { (held: Bool) in
      // Posted on main because the observer flips a UIKit property; the
      // controller's observer is registered on the main queue as well.
      DispatchQueue.main.async {
        NotificationCenter.default.post(
          name: BracemarkShareSwipeGuardModule.holdNotification,
          object: nil,
          userInfo: ["held": held]
        )
      }
    }
  }
}
