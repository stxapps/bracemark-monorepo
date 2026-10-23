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
// screen coordinates by UIKit and needs no key window to read.
//
// IT IS A VIEW, AND NOT A MODULE EVENT, BECAUSE THE KEYBOARD'S EDGE IS ONLY
// HALF THE ANSWER. The other half is where the sheet is, and only a view in the
// sheet can say. It used to be an event carrying the keyboard's top edge, with
// JS assuming the sheet's bottom was the screen's — true on an iPhone, where the
// host hands us a full-width sheet flush with the bottom edge, and wrong twice
// over on an iPad (docs/share-sheet.md, _on an iPad the sheet floats_):
//
//   - the host presents the extension as a FORM SHEET, a 580x640 card centred
//     on the screen, so its bottom edge is 90pt above the screen's in landscape
//     and 270pt in portrait; and
//   - the host then MOVES that card out of the keyboard's way itself —
//     re-centred in the room above the keys, stopping at a top margin — so the
//     sheet was avoided twice: in landscape a 422pt lift where 294 was due, the
//     picker's list squeezed to nothing; in portrait, where the card clears the
//     keys entirely, a lift where none was due.
//
// Nothing in JS can see either. Fabric's `measureInWindow` reads a cached
// viewport offset, so it still reported the resting origin after the host had
// moved the card and after a rotation had re-centred it, and `Dimensions` stays
// on the orientation the extension launched in. A UIView's own conversion has
// neither problem: measured on the iPad (A16) simulator, iOS 26.5, this view's
// origin in the window read y 90 at `keyboardWillChangeFrame` and y 52 — the
// host's move — on the NEXT main-queue turn, a whole keyboard animation before
// `keyboardDidChangeFrame`. Hence the `async` below: one turn late is exact and
// still early enough for the sheet to travel with the keys in one motion.
//
// So the view reports, in its own terms, the two things the frame needs
// (share-keyboard.ts, share-kit.tsx):
//
//   - `overlap` — how much of THIS view's bottom the keyboard covers, 0 while
//     it is down or clear of the view; and
//   - `detached` — whether this view stops short of the window's bottom edge,
//     i.e. the host made the sheet a floating card rather than a bottom sheet.
//
// iOS-only, and only the share extension mounts it: the app's own screens run
// in a normal process where react-native-keyboard-controller works and is what
// they use (docs/soft-keyboard.md). Android's half of this module is
// BracemarkShareModule.kt — a different job entirely (the ShareActivity's
// close()), sharing only the package.
public final class BracemarkShareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BracemarkShareKeyboard")

    // The event's name is part of the JS contract (share-keyboard.ts).
    View(BracemarkShareKeyboardView.self) {
      Events("onKeyboardGeometry")
    }
  }
}

final class BracemarkShareKeyboardView: ExpoView {
  let onKeyboardGeometry = EventDispatcher()

  // The keyboard's end frame in screen coordinates, nil while it is down.
  private var keyboardFrame: CGRect?
  private var observers: [NSObjectProtocol] = []
  private var reported: (overlap: CGFloat, detached: Bool)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    let center = NotificationCenter.default
    // willChangeFrame covers show, hide and every reshape in between (the
    // accessory bar arriving, a language switch, the emoji keyboard, a
    // rotation); willHide is subscribed as well because a dismissal can end on
    // a frame that is merely off-screen, and the frame should not have to infer
    // that.
    observers = [
      center.addObserver(
        forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
      ) { [weak self] notification in
        self?.keyboardWillChange(notification, hiding: false)
      },
      center.addObserver(
        forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
      ) { [weak self] notification in
        self?.keyboardWillChange(notification, hiding: true)
      },
    ]
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    measure(durationMs: 0)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    measure(durationMs: 0)
  }

  private func keyboardWillChange(_ notification: Notification, hiding: Bool) {
    let info = notification.userInfo
    let endFrame = (info?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
    let duration = (info?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0

    keyboardFrame = hiding ? nil : endFrame
    // NOT measured here: the host moves an iPad's form sheet for this same
    // keyboard right after this notification, and this view only sees where
    // the sheet lands on the next turn (the header).
    DispatchQueue.main.async { [weak self] in
      // Milliseconds, matching RN's own keyboard events, so the frame can drive
      // its LayoutAnimation on the system's curve rather than a guess.
      self?.measure(durationMs: duration * 1000)
    }
  }

  private func measure(durationMs: Double) {
    // Not before the view has a size: `didMoveToWindow` can run before the
    // frame lands, and a zero box's maxY is its own top — which reads as
    // `detached` on an iPhone, a frame of the card shape before the real
    // layout corrects it. The size arriving runs `layoutSubviews`, which
    // measures again, so nothing is lost by waiting for it.
    guard let window, !bounds.isEmpty else { return }

    var overlap: CGFloat = 0
    if let keyboardFrame, !keyboardFrame.isEmpty {
      // Its top edge, not its height: a keyboard that is undocked or split
      // floats above the screen's bottom, and the edge still lands right.
      let keyboard = convert(keyboardFrame, from: window.screen.coordinateSpace)
      if keyboard.intersects(bounds) {
        overlap = min(max(bounds.maxY - keyboard.minY, 0), bounds.height)
      }
    }

    // Against the WINDOW, not `window.screen.bounds`: in the extension the
    // screen's bounds stayed on the launch orientation after a rotation, while
    // the window's followed it.
    let detached = convert(bounds, to: nil).maxY < window.bounds.maxY - 0.5

    if let reported, reported.overlap == overlap, reported.detached == detached { return }
    reported = (overlap, detached)

    onKeyboardGeometry([
      "overlap": overlap,
      "detached": detached,
      "durationMs": durationMs,
    ])
  }
}
