const path = require('node:path');

const { IOSConfig } = require('expo/config-plugins');

// `xcode` and `@expo/plist` are @expo/config-plugins' own parsers, not direct
// dependencies of this app — resolved from that package rather than by bare
// `require('xcode')` so a change in npm hoisting can't silently pick up a
// different copy, or none.
const fromConfigPlugins = (id) => {
  const mod = require(
    require.resolve(id, {
      paths: [path.dirname(require.resolve('@expo/config-plugins/package.json'))],
    }),
  );
  return mod.default ?? mod;
};

/**
 * Every name the share extension is known by, derived once from the app config.
 *
 * ⚠ The target name and the bundle id are what the App Store and the Apple
 * Developer account already know this extension as (`com.bracemark.app.ShareExtension`,
 * its provisioning profile, its App Group). They are expo-share-extension's
 * derivation, kept verbatim when it was vendored — changing either ships a NEW
 * extension, not a renamed one.
 */
function shareExtensionNames(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error('with-share-extension: `ios.bundleIdentifier` is required.');
  }

  const groups = config.ios?.entitlements?.['com.apple.security.application-groups'];
  if (!Array.isArray(groups) || groups.length !== 1) {
    throw new Error(
      'with-share-extension: `ios.entitlements["com.apple.security.application-groups"]` ' +
        'must name exactly one App Group — the one the app and the share extension share ' +
        '(packages/expo-react/src/data/app-group.ts reads the same id).',
    );
  }

  const targetName = `${IOSConfig.XcodeUtils.sanitizedName(config.name)}ShareExtension`;
  return {
    targetName,
    bundleIdentifier: `${bundleIdentifier}.ShareExtension`,
    appGroup: groups[0],
    entitlementsFile: `${targetName}.entitlements`,
  };
}

/**
 * The fonts the app embeds through `expo-font`, which the share extension
 * embeds too — read from that plugin's entry so app.config.ts names each font
 * once. Paths relative to the project root, as app.config.ts writes them.
 */
function expoFonts(config) {
  const entry = config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-font',
  );
  return entry?.[1]?.fonts ?? [];
}

// A pbxproj scalar: bare when it is a plain token, quoted (and escaped)
// otherwise. Values the `xcode` parser hands back are already in this form.
const pbx = (value) => {
  const text = String(value);
  return /^[A-Za-z0-9_./]+$/.test(text)
    ? text
    : `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const unquote = (value) => (typeof value === 'string' ? value.replace(/^"|"$/g, '') : value);

module.exports = { fromConfigPlugins, shareExtensionNames, expoFonts, pbx, unquote };
