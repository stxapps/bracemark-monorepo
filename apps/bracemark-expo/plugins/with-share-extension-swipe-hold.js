const { withFinalizedMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// The observer that lets JS hold the system's swipe-to-dismiss off the iOS
// share extension's sheet.
//
// The host presents the share extension in a sheet of its own, and a downward
// drag on it dismisses the whole sheet. The list and tag pickers ask for that to
// be held off while they are up (docs/share-sheet.md, _the pickers hold the
// system's swipe off_), and UIKit's lever for it is `isModalInPresentation` on
// the presented view controller — `ShareExtensionViewController`, which is
// `expo-share-extension`'s file, compiled into the extension target. Our own
// module (modules/bracemark-share/ios/BracemarkShareSwipeGuardModule.swift)
// cannot name that class or reach an instance of it, so it posts a
// notification and the controller sets its own flag. That is the channel the
// library already uses for `close()` and `openHostApp()`: this adds one more
// observer to `setupNotificationCenterObserver`, beside those two.
//
// **Why not a native view that finds the controller by itself.** That was the
// first version — no patch needed, the responder chain reaches the controller
// — and it killed the share extension on a real iPhone: mounting an Expo
// native view costs more memory than this process has to spare. The module's
// header has the numbers.
//
// **Why this is a plugin, and why `finalized`.** The reasons
// `with-share-extension-root-view.js` gives, unchanged: `ios/` is CNG output,
// the controller is copied fresh out of `node_modules` on every prebuild, and
// that copy happens inside the library's xcodeproj mod, which `finalized` runs
// after wherever `plugins` puts this entry.
//
// Idempotent, and it throws rather than skipping. A missing observer is silent
// in every other way — prebuild succeeds, the Swift compiles, the module's
// `setHeld` posts into nothing, and the only symptom is a picker that can still
// be swiped away on a device.

// The notification's name — the same string the module posts.
const NOTIFICATION = 'bracemarkShareSwipeHold';

// The method's opening line, as upstream writes it.
const ANCHOR = `  private func setupNotificationCenterObserver() {
`;
const PATCHED = `${ANCHOR}    // Patched by plugins/with-share-extension-swipe-hold.js: BracemarkShareSwipeGuard
    // posts this while a picker is up, to hold the system's swipe-to-dismiss off.
    NotificationCenter.default.addObserver(forName: NSNotification.Name("${NOTIFICATION}"), object: nil, queue: .main) { [weak self] notification in
      self?.isModalInPresentation = (notification.userInfo?["held"] as? Bool) ?? false
    }

`;

const CONTROLLER = 'ShareExtensionViewController.swift';

const withShareExtensionSwipeHold = (config) =>
  withFinalizedMod(config, [
    'ios',
    (cfg) => {
      const { platformProjectRoot } = cfg.modRequest;

      // Located by walking the target directories, for the reason the
      // root-view plugin gives: a rename can't make this silently find nothing.
      const matches = fs
        .readdirSync(platformProjectRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(platformProjectRoot, entry.name, CONTROLLER))
        .filter((file) => fs.existsSync(file));

      // No share extension target — dropping `expo-share-extension` from
      // `plugins` is a legitimate config, not a failure.
      if (!matches.length) return cfg;

      if (matches.length > 1) {
        throw new Error(
          `with-share-extension-swipe-hold: found ${matches.length} copies of ${CONTROLLER} ` +
            `(${matches.map((file) => path.relative(platformProjectRoot, file)).join(', ')}) — ` +
            `expected exactly one share extension target.`,
        );
      }

      const [file] = matches;
      const source = fs.readFileSync(file, 'utf8');

      // This ran twice.
      if (source.includes(NOTIFICATION)) return cfg;

      if (!source.includes(ANCHOR)) {
        throw new Error(
          `with-share-extension-swipe-hold: could not find setupNotificationCenterObserver in ` +
            `${path.relative(platformProjectRoot, file)}. expo-share-extension has reworded the ` +
            `controller — find where it registers its "close" observer and update ANCHOR in this ` +
            `plugin. Left unpatched, the share sheet's pickers can be swiped away mid-pick.`,
        );
      }

      fs.writeFileSync(file, source.replace(ANCHOR, PATCHED));
      return cfg;
    },
  ]);

module.exports = withShareExtensionSwipeHold;
