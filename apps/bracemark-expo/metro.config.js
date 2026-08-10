const { withNxMetro } = require('@nx/expo');
// expo-doctor advises the `expo/metro-config` sub-export over this bare
// specifier; ignore it here. The root manifest must declare @expo/metro-config
// anyway so npm HOISTS it: uniwind's metro transformer does a bare
// require('@expo/metro-config') from node_modules/uniwind, which can't see a
// copy nested under node_modules/expo. Same for @expo/cli, which @nx/expo's
// start/prebuild executors require.resolve() — hence its root devDependency.
const { getDefaultConfig } = require('@expo/metro-config');
const { mergeConfig } = require('metro-config');
const { withShareExtension } = require('expo-share-extension/metro');
const { withUniwindConfig } = require('uniwind/metro');

const defaultConfig = getDefaultConfig(__dirname);
const { assetExts, sourceExts } = defaultConfig.resolver;

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const customConfig = {
  cacheVersion: '@stxapps/bracemark-expo',
  transformer: {
    babelTransformerPath: require.resolve('react-native-svg-transformer'),
  },
  resolver: {
    assetExts: assetExts.filter((ext) => ext !== 'svg'),
    sourceExts: [...sourceExts, 'cjs', 'mjs', 'svg'],
  },
};

const nxConfig = withNxMetro(mergeConfig(defaultConfig, customConfig), {
  // Change this to true to see debugging info.
  // Useful if you have issues resolving modules
  debug: false,
  // all the file extensions used for imports other than 'ts', 'tsx', 'js', 'jsx', 'json'
  extensions: [],
  // Specify folders to watch, in addition to Nx defaults (workspace libraries and node_modules)
  watchFolders: [],
});

// withShareExtension points the iOS share-extension target's bundle at
// index.share.js (docs/share-sheet.md); withUniwindConfig must stay the
// outermost wrapper.
module.exports = withUniwindConfig(withShareExtension(nxConfig), {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-env.d.ts',
});
