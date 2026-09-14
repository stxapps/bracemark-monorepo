const { withFinalizedMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// The one line of `ShareExtensionViewController.swift` that puts the sheet's
// whole RN tree 72pt below the screen.
//
// `expo-share-extension` sizes the root view it hands React Native in
// `configureRootView` (`plugin/swift/ShareExtensionViewController.swift`), and
// with no `ShareExtensionHeight` in the Info.plist — which is this app's
// deliberate choice, see app.config.ts and docs/share-sheet.md, _the host view
// is full-screen_ — it takes the else branch:
//
//     rootView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
//     frame = screenBounds                       // UIScreen.main.bounds
//
// `frame` is in the SUPERVIEW's coordinate space, and the superview is the
// extension view controller's own `view` — which the share presentation places
// 72pt DOWN from the top of the screen, not at its origin. So a rect that is
// the right SIZE (402x874 on a 6.3" phone) lands at the wrong PLACE: screen y
// 72 through 946, hanging 72pt off the bottom of an 874pt screen. Measured on
// iOS 26.5, iPhone 17 and iPhone 17 Pro alike, via `maestro hierarchy`:
//
//     Safari (the screen)   [0,0][402,874]
//     share-backdrop        [0,72][402,946]      <- the RN root, 72 too low
//     Save                  [16,852][386,896]    <- 22pt of it off-screen
//
// The autoresizing mask does not save it: `.flexibleHeight` redistributes on a
// LATER superview resize and there is no later resize, so the initial rect is
// the final one.
//
// `frame = view.bounds` is the whole fix — fill the superview rather than the
// screen, which is what `[.flexibleWidth, .flexibleHeight]` on the line above
// already says this view is meant to do, and what the library's own
// `initialViewHeight` initial prop (`self.view.bounds.height`) already tells JS
// the container is. Nothing in `features/share/` was wrong: the panel is
// bottom-anchored in a `flex-1 justify-end` frame and had been anchoring itself
// correctly to the bottom of a box that was itself off the screen. Nor could
// anything there detect it — `useSafeAreaInsets()` reports 34 for a view whose
// bottom edge is below the display, because that is what `UIView.safeAreaInsets`
// says.
//
// **Why this is a plugin and not an edit.** `ios/` is CNG output and this file
// is copied fresh out of `node_modules` on every prebuild (`addPbxGroup.js`
// copies `plugin/swift/ShareExtensionViewController.swift` into the target
// directory), so an edit in `ios/` dies at the next `expo prebuild --clean`
// with a clean working tree throughout — the same trap `expo-build.md`, _ios
// share extension build settings_, describes for the build settings next door.
//
// **Why `finalized`.** That copy happens inside the library's `withXcodeProject`
// mod, and mod KEYS have fixed precedence (`mod-compiler.js`: `dangerous: -2`,
// `xcodeproj: -1`, `finalized: 1`), so `finalized` runs after the whole
// xcodeproj chain has written the file wherever `plugins` puts this entry —
// no dependency on array order. Same reasoning, at more length, in
// `with-share-extension-build-settings.js`.
//
// The rewrite is idempotent and asserts loudly, because everything about this
// failure is silent: prebuild succeeds, the Swift compiles, no lint or type or
// test reads a .swift, and the sheet renders — just 72pt too low. If upstream
// ever fixes this, there is no `frame = screenBounds` left to find and the
// rewrite becomes a no-op; if upstream merely REWORDS the branch, the throw is
// what tells you, rather than a clipped Save button on a device nobody tested.
// → docs/share-sheet.md, _the host view is full-screen_.

// The exact else-branch body, as upstream writes it.
const ANCHOR = `      rootView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      frame = screenBounds`;
const PATCHED = `      rootView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      // Patched by plugins/with-share-extension-root-view.js: fill the
      // superview, not the screen. \`frame\` is in the superview's coordinates
      // and the extension's view is not at the screen origin.
      frame = view.bounds`;

const CONTROLLER = 'ShareExtensionViewController.swift';

const withShareExtensionRootView = (config) =>
  withFinalizedMod(config, [
    'ios',
    (cfg) => {
      const { platformProjectRoot } = cfg.modRequest;

      // Located by walking the target directories rather than by rebuilding
      // `getShareExtensionName(config)` (`sanitizedName(config.name) +
      // "ShareExtension"`), so a rename of the app or of the library's naming
      // scheme can't make this silently find nothing.
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
          `with-share-extension-root-view: found ${matches.length} copies of ${CONTROLLER} ` +
            `(${matches.map((file) => path.relative(platformProjectRoot, file)).join(', ')}) — ` +
            `expected exactly one share extension target.`,
        );
      }

      const [file] = matches;
      const source = fs.readFileSync(file, 'utf8');

      // Already correct: upstream fixed it, or this ran twice.
      if (source.includes(PATCHED) || !source.includes('frame = screenBounds')) return cfg;

      if (!source.includes(ANCHOR)) {
        throw new Error(
          `with-share-extension-root-view: could not find the root-view sizing branch in ` +
            `${path.relative(platformProjectRoot, file)}. expo-share-extension has reworded ` +
            `configureRootView — re-check that the root view fills its superview rather than ` +
            `UIScreen.main.bounds, then update ANCHOR in this plugin. ` +
            `Left unpatched, the share sheet renders below the bottom of the screen.`,
        );
      }

      fs.writeFileSync(file, source.replace(ANCHOR, PATCHED));
      return cfg;
    },
  ]);

module.exports = withShareExtensionRootView;
