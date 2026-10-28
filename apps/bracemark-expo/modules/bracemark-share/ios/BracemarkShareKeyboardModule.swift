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
// IT MEASURES A VIEW, BECAUSE THE KEYBOARD'S EDGE IS ONLY HALF THE ANSWER. The
// other half is where the sheet is, and only a view in the sheet can say. It
// used to be an event carrying the keyboard's top edge, with JS assuming the
// sheet's bottom was the screen's — true on an iPhone, where the host hands us a
// full-width sheet flush with the bottom edge, and wrong twice over on an iPad
// (docs/share-sheet.md, _on an iPad the sheet floats_):
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
// neither problem: measured on the iPad (A16) simulator, iOS 26.5, the frame's
// origin in the window read y 90 at `keyboardWillChangeFrame` and y 52 — the
// host's move — on the NEXT main-queue turn, a whole keyboard animation before
// `keyboardDidChangeFrame`. Hence the `async` below: one turn late is exact and
// still early enough for the sheet to travel with the keys in one motion.
//
// ⚠ AND IT IS NOT A VIEW ITSELF. It was one — an `ExpoView` that was the
// frame — and the share extension cannot afford one: the first Expo native view
// in this process costs ~14MB on the simulator, and on an iPhone 12 (iOS 26.5)
// that view alone was the difference between a share extension running at the
// memory-warning line for its whole life and one that never got a warning,
// under a hard cap of 120MB (docs/share-sheet.md, _the share extension has
// almost no memory to spare_; BracemarkShareSwipeGuardModule.swift is the same
// lesson, learned first). So the frame is a plain React Native `View`, and it
// hands this module its tag from `onLayout` (`track`); the module finds the
// UIView behind it and measures THAT. Module functions and events cost nothing
// measurable. The keyboard's frame lives here rather than per view, so a frame
// that mounts under a keyboard already up — every picker the moment its search
// is focused, the compose screen on the way back — measures right away instead
// of waiting for the next notification.
//
// It reports, in the frame's own terms, the two things the frame needs
// (share-keyboard.ts, share-kit.tsx):
//
//   - `overlap` — how much of the FRAME'S bottom the keyboard covers, 0 while
//     it is down or clear of the frame; and
//   - `detached` — whether the frame stops short of the window's bottom edge,
//     i.e. the host made the sheet a floating card rather than a bottom sheet.
//
// iOS-only, and only the share extension calls it: the app's own screens run
// in a normal process where react-native-keyboard-controller works and is what
// they use (docs/soft-keyboard.md). Android's half of this module is
// BracemarkShareModule.kt — a different job entirely (the ShareActivity's
// close()), sharing only the package.
public final class BracemarkShareKeyboardModule: Module {
  // Everything below is touched on the main queue only: the observers are
  // registered on it and `track` hops to it before reading anything.
  private weak var frame: UIView?
  // The keyboard's end frame in screen coordinates, nil while it is down.
  private var keyboardFrame: CGRect?
  private var observers: [NSObjectProtocol] = []
  private var reported: (overlap: CGFloat, detached: Bool)?

  public func definition() -> ModuleDefinition {
    // The module's and the event's names are part of the JS contract
    // (share-keyboard.ts).
    Name("BracemarkShareKeyboard")

    Events("onKeyboardGeometry")

    OnCreate {
      let center = NotificationCenter.default
      // willChangeFrame covers show, hide and every reshape in between (the
      // accessory bar arriving, a language switch, the emoji keyboard, a
      // rotation); willHide is subscribed as well because a dismissal can end
      // on a frame that is merely off-screen, and the frame should not have to
      // infer that.
      self.observers = [
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

    OnDestroy {
      self.observers.forEach(NotificationCenter.default.removeObserver)
    }

    // The frame's `onLayout`: a new frame (each screen of the sheet mounts its
    // own) or a new size (a rotation, a split). Fabric dispatches `onLayout`
    // from the commit, which can land before the mount it describes, hence the
    // hop and the retry below.
    Function("track") { (viewTag: Int) in
      DispatchQueue.main.async { [weak self] in
        self?.track(viewTag, attempts: 3)
      }
    }
  }

  private func track(_ viewTag: Int, attempts: Int) {
    guard let view = appContext?.findView(withTag: viewTag, ofType: UIView.self) else {
      // Not mounted yet. Give up after a few turns rather than spin: a frame
      // that never resolves leaves the lift at zero, with the safe-area inset
      // still on — the safe way to be wrong (share-keyboard.ts).
      if attempts > 1 {
        DispatchQueue.main.async { [weak self] in
          self?.track(viewTag, attempts: attempts - 1)
        }
      }
      return
    }
    frame = view
    // ALWAYS report on a track, even when nothing measured has changed. A track
    // is a layout of a frame on the JS side, and that frame's hook may be new
    // and have heard nothing — while the UIView behind it is NOT new: Fabric
    // recycles component views, so each screen of the sheet arrived here with a
    // fresh tag and the previous screen's UIView. Deduplicating by view then
    // swallowed every screen's first report after the first one, and on an iPad
    // the pickers and the compose screen after them fell back to `detached`
    // false — a bottom sheet pinned to the floor of the form sheet. A track
    // only comes from `onLayout`, so this costs one event per layout.
    reported = nil
    measure(durationMs: 0)
  }

  private func keyboardWillChange(_ notification: Notification, hiding: Bool) {
    let info = notification.userInfo
    let endFrame = (info?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
    let duration = (info?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
    // When the keyboard started moving, on the wall clock JS's `Date.now()`
    // reads: the panel only starts once this has crossed to JS and React has
    // committed, so it animates over what is LEFT of `duration`, not all of it
    // (share-keyboard.ts).
    let startedAtMs = Date().timeIntervalSince1970 * 1000

    keyboardFrame = hiding ? nil : endFrame
    // NOT measured here: the host moves an iPad's form sheet for this same
    // keyboard right after this notification, and the frame only shows where
    // the sheet lands on the next turn (the header).
    DispatchQueue.main.async { [weak self] in
      // Milliseconds, matching RN's own keyboard events.
      self?.measure(durationMs: duration * 1000, startedAtMs: startedAtMs)
    }
  }

  // `durationMs` 0 for a measure that no keyboard motion caused (a new frame, a
  // new size): the frame then takes the overlap without animating.
  private func measure(durationMs: Double, startedAtMs: Double = 0) {
    // Not before the frame has a size and a window: a zero box's maxY is its
    // own top — which reads as `detached` on an iPhone, a frame of the card
    // shape before the real layout corrects it. The size arriving fires
    // `onLayout`, which tracks again, so nothing is lost by waiting for it.
    guard let frame, let window = frame.window, !frame.bounds.isEmpty else { return }

    var overlap: CGFloat = 0
    if let keyboardFrame, !keyboardFrame.isEmpty {
      // Its top edge, not its height: a keyboard that is undocked or split
      // floats above the screen's bottom, and the edge still lands right.
      let keyboard = frame.convert(keyboardFrame, from: window.screen.coordinateSpace)
      if keyboard.intersects(frame.bounds) {
        overlap = min(max(frame.bounds.maxY - keyboard.minY, 0), frame.bounds.height)
      }
    }

    // Against the WINDOW, not `window.screen.bounds`: in the extension the
    // screen's bounds stayed on the launch orientation after a rotation, while
    // the window's followed it.
    let detached = frame.convert(frame.bounds, to: nil).maxY < window.bounds.maxY - 0.5

    if let reported, reported.overlap == overlap, reported.detached == detached { return }
    reported = (overlap, detached)

    sendEvent("onKeyboardGeometry", [
      "overlap": overlap,
      "detached": detached,
      "durationMs": durationMs,
      "startedAtMs": startedAtMs,
    ])
  }
}
