const fs = require('node:fs');
const path = require('node:path');

const { withDangerousMod, withInfoPlist } = require('expo/config-plugins');

const { fromConfigPlugins, shareExtensionNames, expoFonts } = require('./util');

const plist = fromConfigPlugins('@expo/plist');

// The share sheet accepts one web page (with Safari's preprocessing run) or
// text, and nothing else: the controller (modules/bracemark-share/ios-extension)
// reads only `url`, `preprocessingResults` and `text`. Each rule maps onto the
// NSExtensionActivationRule keys expo-share-extension wrote for it.
function activationRule(rules, { preprocessing }) {
  const rule = {};
  for (const { type, max } of rules) {
    if (type === 'url') {
      // Safari offers a web PAGE when the extension has a preprocessing file,
      // and the page is what carries the preprocessing results.
      if (preprocessing) rule.NSExtensionActivationSupportsWebPageWithMaxCount = max ?? 1;
      rule.NSExtensionActivationSupportsWebURLWithMaxCount = max ?? 1;
    } else if (type === 'text') {
      rule.NSExtensionActivationSupportsText = true;
    } else {
      throw new Error(
        `with-share-extension: activation rule "${type}" is not supported — the share ` +
          `extension's controller reads only a web URL and text.`,
      );
    }
  }
  return rule;
}

/**
 * The extension's Info.plist.
 *
 * Phase 1 of the vendoring (docs/dependency-upgrades.md, _the app-side
 * blocker_) keeps every key expo-share-extension 5.0.6 wrote, odd ones
 * included — `UIDesignRequiresCompatibility`, `UIRequiredDeviceCapabilities:
 * armv7`, an empty scene manifest, the localhost ATS exception — so the sheet
 * runs exactly as before. Three keys are gone because nothing reads them any
 * more: `ShareExtensionBackgroundColor` (the controller's root is clear in
 * code), `HostAppScheme` (no `openHostApp`) and `WithFirebase`.
 *
 * `CFBundleDisplayName` is the label under the icon in the iOS share sheet,
 * and it is the app's own name here at birth. (Upstream hardcoded
 * "$(PRODUCT_NAME) Share Extension" — "BracemarkShareExtension Share
 * Extension" — and a fifth plugin had to overwrite it.) identity.js asserts it
 * still matches what the app ships.
 */
function infoPlist(config, { activationRules, preprocessingFile, fonts, appGroup }) {
  return {
    CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
    CFBundleDisplayName: config.name,
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
    CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    LSRequiresIPhoneOS: true,
    UIDesignRequiresCompatibility: true,
    NSAppTransportSecurity: {
      NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } },
    },
    UIRequiredDeviceCapabilities: ['armv7'],
    UIStatusBarStyle: 'UIStatusBarStyleDefault',
    UISupportedInterfaceOrientations: [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
    ],
    UIUserInterfaceStyle: 'Automatic',
    UIViewControllerBasedStatusBarAppearance: false,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {},
    },
    UIAppFonts: fonts.map((font) => path.basename(font)),
    AppGroup: appGroup,
    AppGroupIdentifier: appGroup,
    NSExtension: {
      NSExtensionAttributes: {
        NSExtensionActivationRule: activationRule(activationRules, {
          preprocessing: Boolean(preprocessingFile),
        }),
        ...(preprocessingFile && {
          // Safari looks the file up by its name without the extension.
          NSExtensionJavaScriptPreprocessingFile: path.basename(
            preprocessingFile,
            path.extname(preprocessingFile),
          ),
        }),
      },
      NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
      NSExtensionPointIdentifier: 'com.apple.share-services',
    },
  };
}

/**
 * Writes `ios/<target>/Info.plist` and `ios/<target>/<target>.entitlements` —
 * the only two files of the extension that live in `ios/`. Everything else the
 * target builds (the controller, the font, preprocessing.js) is referenced in
 * place by target.js.
 *
 * A `dangerous` mod because these are new files, not mod results of any kind;
 * it runs before the xcodeproj mod that points the target at them.
 */
const withShareExtensionFiles = (config, props) => {
  // The app's Info.plist carries the group too, as it did under
  // expo-share-extension. Nothing in this app reads it from there; it stays
  // for phase 1, which changes no output it doesn't have to.
  config = withInfoPlist(config, (cfg) => {
    const { appGroup } = shareExtensionNames(cfg);
    cfg.modResults.AppGroup = appGroup;
    cfg.modResults.AppGroupIdentifier = appGroup;
    return cfg;
  });

  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { targetName, appGroup, entitlementsFile } = shareExtensionNames(cfg);
      const dir = path.join(cfg.modRequest.platformProjectRoot, targetName);
      fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(
        path.join(dir, 'Info.plist'),
        plist.build(
          infoPlist(cfg, {
            activationRules: props.activationRules,
            preprocessingFile: props.preprocessingFile,
            fonts: expoFonts(cfg),
            appGroup,
          }),
        ),
      );

      // Just the App Group. Its id doubles as the keychain access group the
      // session mirror lives under (packages/expo-crypto, shared-keychain.ts),
      // so this one entitlement covers both.
      fs.writeFileSync(
        path.join(dir, entitlementsFile),
        plist.build({ 'com.apple.security.application-groups': [appGroup] }),
      );
      return cfg;
    },
  ]);
};

module.exports = { withShareExtensionFiles };
