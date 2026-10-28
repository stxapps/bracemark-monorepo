const { withFinalizedMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// THE COMMUNITY MODULES THE iOS SHARE EXTENSION LINKS AND NEVER CALLS.
//
// expo-share-extension gives the extension target its own autolinking pass in
// the generated Podfile (`withPodfile`): `use_expo_modules!(exclude: …)` for the
// Expo modules — which app.config.ts's `excludedPackages` feeds — and then
//
//     config = use_native_modules!(config_command)
//
// for every React Native community module in the app, with no exclusion list at
// all. So the share extension linked Reanimated, Worklets and NetInfo, though
// neither share bundle, production or dev, names a native module of any of
// them.
//
// One of them is worse than dead weight. The sheet's Save path loads
// react-native-quick-crypto, whose react-native-nitro-modules runs
// `installWorkletsSupport()` on import: a try/catch'd `require` of
// react-native-worklets. With Worklets linked, that require installs its
// TurboModule, and `WorkletsModuleProxy`'s constructor builds a whole second
// Hermes runtime (the UI runtime) — in a process with a 120MB cap, for a
// serializer the sheet never uses. Unlinked, the require throws inside Nitro's
// own try and nothing else changes (docs/share-sheet.md, _the share extension
// has almost no memory to spare_).
//
// THE REWRITE splits `use_native_modules!` into its two halves — it is exactly
// `link_native_modules!(list_native_modules!(config_command))`
// (react-native/scripts/cocoapods/autolinking.rb) — and filters between them.
// NOT by filtering the config command's JSON: `list_native_modules!` also writes
// that JSON to `build/generated/autolinking/autolinking.json`, the file codegen
// reads to build the providers BOTH targets share, and an extension-shaped copy
// there would unregister Screens' and Gesture Handler's components from the APP.
// Filtering the list after it has been written leaves that file the app's.
//
// ⚠ WHICH IS ALSO WHY THE LIST IS SHORT. Those shared providers bind the share
// extension to every library the APP registers a Fabric component from:
// codegen's `RCTThirdPartyComponentsProvider` builds an NSDictionary LITERAL of
// `NSClassFromString(@"…ComponentView")` values, and in a target that does not
// link the library that class is nil — and a nil in a dictionary literal is an
// uncaught NSInvalidArgumentException ("attempt to insert nil object from
// objects[0]") the moment React Native starts. It compiles, links and prebuilds
// clean; on the iPhone 12 the share extension died before its first screen. So
// the date picker, Gesture Handler, react-native-keyboard-controller and Screens
// stay linked, sheet or no sheet, for as long as the app registers their
// components. What CAN go is a library with no entry in that provider — check
// `ios/build/generated/ios/RCTThirdPartyComponentsProvider.mm` after a prebuild
// before adding one here. TurboModules are a different, safe shape: the
// module provider maps names to strings and resolves them lazily, so an
// unlinked one is merely not found, which is all Nitro's optional require asks.
//
// **Why a plugin and `finalized`**, as next door: `ios/` is CNG output, the
// Podfile is regenerated on every prebuild, and `finalized` runs after every
// `withPodfile` mod — expo-share-extension's included — and before `pod
// install`. Idempotent, and it throws on an anchor it cannot find rather than
// leave the extension silently linking everything again.

// npm package names, as `list_native_modules!` reports them.
// None registers a Fabric component (the ⚠ above).
const SHARE_EXCLUDED_COMMUNITY = [
  'react-native-reanimated',
  'react-native-worklets',
  '@react-native-community/netinfo',
];

const TARGET = /^target '([^']*ShareExtension)' do\s*$/m;
const ANCHOR = '  config = use_native_modules!(config_command)';
const MARKER = '# Patched by plugins/with-share-extension-native-links.js';

const patched = (excluded) => `  ${MARKER}: link only what the share
  # extension's bundle can reach. Filtered AFTER list_native_modules! has written
  # autolinking.json, which codegen reads for both targets.
  share_native_modules = list_native_modules!(config_command)
  share_native_modules[:ios_packages].reject! do |package|
    ${JSON.stringify(excluded)}.include?(package[:name])
  end
  config = link_native_modules!(share_native_modules)`;

const withShareExtensionNativeLinks = (config) =>
  withFinalizedMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfile)) return cfg;

      const source = fs.readFileSync(podfile, 'utf8');
      const target = TARGET.exec(source);
      // No share extension target — dropping `expo-share-extension` from
      // `plugins` is a legitimate config, not a failure.
      if (!target) return cfg;

      // The extension's block runs from its `target` line to the next one (or
      // the end); the app's own `use_native_modules!` sits before it and is
      // left alone.
      const start = target.index;
      const next = source.slice(start + target[0].length).search(/^target '/m);
      const end = next === -1 ? source.length : start + target[0].length + next;
      const block = source.slice(start, end);

      if (block.includes(MARKER)) return cfg;

      if (!block.includes(ANCHOR)) {
        throw new Error(
          `with-share-extension-native-links: could not find "${ANCHOR.trim()}" in the ` +
            `${target[1]} block of ios/Podfile. expo-share-extension has changed how it ` +
            `autolinks the extension — re-check that the extension still gets its own ` +
            `use_native_modules! pass, then update ANCHOR in this plugin. Left unpatched, ` +
            `the share extension links every community module the app does, Worklets' ` +
            `second JS runtime included.`,
        );
      }

      const rewritten = block.replace(ANCHOR, patched(SHARE_EXCLUDED_COMMUNITY));
      fs.writeFileSync(podfile, source.slice(0, start) + rewritten + source.slice(end));
      return cfg;
    },
  ]);

module.exports = withShareExtensionNativeLinks;
