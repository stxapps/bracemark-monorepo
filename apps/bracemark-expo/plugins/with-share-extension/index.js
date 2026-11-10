const { withShareExtensionFiles } = require('./files');
const { withShareExtensionIdentity } = require('./identity');
const { withShareExtensionPodfile } = require('./podfile');
const { withShareExtensionTarget } = require('./target');

/**
 * THE iOS SHARE EXTENSION — the share sheet's target inside bracemark-expo
 * (not the browser extension; docs/share-sheet.md).
 *
 * Vendored from expo-share-extension 5.0.6 (MIT, © Max Ast; licence in
 * ./LICENSE-expo-share-extension) on 2026-11-09, when upstream had stopped
 * moving and was the one thing holding the Expo SDK at 54
 * (docs/dependency-upgrades.md, _the app-side blocker_). It replaces that
 * package's config plugin AND the four local plugins that patched its output
 * (with-share-extension-{build-settings,root-view,swipe-hold,native-links}).
 *
 * Five mods, each in its own file:
 *
 * - files.js    — `dangerous`: the extension's Info.plist + entitlements, and
 *                 the App Group keys on the app's Info.plist
 * - podfile.js  — `podfile`: the extension's own autolinking block
 * - target.js   — `xcodeproj`: the target, its phases, and the app embedding it
 * - identity.js — `finalized`: deployment target, device family and versions
 *                 copied from the app target, and the guards
 *
 * The controller is native code of the share sheet, not of this plugin:
 * modules/bracemark-share/ios-extension/ShareViewController.swift, referenced
 * in place by the target. The App Group comes from app.config.ts's
 * `ios.entitlements`, and the fonts from `expo-font`'s entry, so each is
 * stated once.
 *
 * @param {object} props
 * @param {{ type: 'url' | 'text', max?: number }[]} props.activationRules
 *   what the share sheet offers Bracemark for
 * @param {string[]} props.excludedExpoModules
 *   Expo modules the extension target must not link (`use_expo_modules!(exclude:)`)
 * @param {string[]} props.excludedCommunityModules
 *   community modules it must not link — see podfile.js for the one rule that
 *   bounds this list
 * @param {string} [props.preprocessingFile]  Safari's preprocessing JS, project-relative
 */
const withShareExtension = (config, props = {}) => {
  const options = {
    activationRules: props.activationRules ?? [{ type: 'url', max: 1 }, { type: 'text' }],
    excludedExpoModules: props.excludedExpoModules ?? [],
    excludedCommunityModules: props.excludedCommunityModules ?? [],
    preprocessingFile: props.preprocessingFile,
    // Fixed rather than options: each is a contract with a file elsewhere.
    controller: './modules/bracemark-share/ios-extension/ShareViewController.swift',
    entryFile: 'index.share.js',
  };

  config = withShareExtensionFiles(config, options);
  config = withShareExtensionPodfile(config, options);
  config = withShareExtensionTarget(config, options);
  config = withShareExtensionIdentity(config, options);
  return config;
};

module.exports = withShareExtension;
