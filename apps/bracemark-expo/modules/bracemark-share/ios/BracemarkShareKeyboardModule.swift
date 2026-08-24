import ExpoModulesCore
import UIKit

// THE KEYBOARD'S GEOMETRY, FOR A PROCESS WHERE REACT NATIVE'S OWN IS ZERO.
//
// This exists for one reason: in the iOS share extension, every keyboard frame
// RN hands JS is CGRectZero. `RCTKeyboardObserver.mm` reads the notification's
// `UIKeyboardFrameEndUserInfoKey` correctly and then converts it:
//
//     UIWindow *window = RCTKeyWindow();
//     endFrame = [window convertRect:endFrame fromCoordinateSpace:window.screen.coordinateSpace];
//
// and `RCTKeyWindow()` returns nil in an app extension BY CONTRACT — its first
// line is `if (RCTRunningInAppExtension()) return nil;`, because
// `UIApplication.sharedApplication` is unavailable there. Messaging nil yields a
// zeroed rect, so `Keyboard.metrics()`, every `keyboardWillShow` payload and
// therefore `KeyboardAvoidingView` all report `screenY: 0, height: 0` — a
// plausible number rather than an error. KAV then lifts by
// `frame.y + frame.height - 0`, i.e. the whole panel height, which is what
// collapsed the sheet (docs/share-sheet.md, _what an app-extension process
// breaks in React Native itself_).
//
// react-native-keyboard-controller is not an alternative here for the same
// reason one level up: its iOS layer finds the keyboard through
// `UIApplication.shared.windows` / `.activeWindow`
// (`KeyboardViewLocator.swift`, `KeyboardTrackingView.swift`,
// `KeyboardView.find()`), which is the very API an extension does not have.
//
// The NOTIFICATION ITSELF is fine — `UIKeyboardFrameEndUserInfoKey` is posted in
// screen coordinates by UIKit and needs no window to read. So this module does
// exactly what RN does minus the conversion that cannot work, and hands JS the
// two numbers the sheet's own lift is computed from (share-keyboard.ts).
//
// iOS-only, and only the share extension consumes it: the app's own screens run
// in a normal process where react-native-keyboard-controller works and is what
// they use (docs/soft-keyboard.md). Android's half of this module is
// BracemarkShareModule.kt — a different job entirely (the ShareActivity's
// close()), sharing only the package.
public final class BracemarkShareKeyboardModule: Module {
  // The event's name is part of the JS contract (share-keyboard.ts).
  private static let keyboardEvent = "keyboardFrameChange"

  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("BracemarkShareKeyboard")

    Events(BracemarkShareKeyboardModule.keyboardEvent)

    // Observing is scoped to "JS is listening", which on this surface means
    // "the sheet is mounted": the extension process is re-created for every
    // share, so there is nothing long-lived to leak into, and OnDestroy is the
    // belt-and-braces for a teardown that never emits OnStopObserving.
    OnStartObserving { self.startObserving() }
    OnStopObserving { self.stopObserving() }
    OnDestroy { self.stopObserving() }
  }

  private func startObserving() {
    guard observers.isEmpty else { return }

    let center = NotificationCenter.default
    // willChangeFrame covers show, hide and every reshape in between (the
    // accessory bar arriving, a language switch, the emoji keyboard); willHide
    // is subscribed as well because a dismissal can end on a frame that is
    // merely off-screen, and the sheet should not have to infer that.
    let names: [Notification.Name] = [
      UIResponder.keyboardWillChangeFrameNotification,
      UIResponder.keyboardWillHideNotification,
    ]

    observers = names.map { name in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
        self?.emit(notification)
      }
    }
  }

  private func stopObserving() {
    let center = NotificationCenter.default
    observers.forEach(center.removeObserver)
    observers = []
  }

  private func emit(_ notification: Notification) {
    let info = notification.userInfo
    let endFrame = (info?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
    let duration = (info?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0

    // A hide is reported as "the keyboard's top edge is the bottom of the
    // screen", so JS needs no special case: its lift is
    // `max(panelBottomOnScreen - screenY, 0)`, which falls to zero on its own.
    let hiding = notification.name == UIResponder.keyboardWillHideNotification
    let screenBottom = UIScreen.main.bounds.maxY

    sendEvent(
      BracemarkShareKeyboardModule.keyboardEvent,
      [
        // The keyboard's top edge in SCREEN points — the number the lift is
        // computed from. Height is sent alongside for diagnosis only; it is the
        // wrong thing to lift by if the keyboard is ever undocked or floating,
        // where screenY still lands correctly.
        "screenY": hiding ? screenBottom : endFrame.origin.y,
        "height": hiding ? 0 : endFrame.size.height,
        // Milliseconds, matching RN's own keyboard events, so the sheet can
        // drive its LayoutAnimation on the system's curve rather than a guess.
        "durationMs": duration * 1000,
      ]
    )
  }
}
