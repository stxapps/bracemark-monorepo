const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

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

// THE PRODUCTION GUARD — a release bundle that would not talk to production fails
// here instead of shipping. Every release path — `npm run android:release`,
// `./gradlew bundleRelease`, Xcode Run (Release) and Archive — bundles through
// `expo export:embed` (or `expo run`'s eager bundle), which sets
// NODE_ENV=production and loads the `.env*` files BEFORE it loads this file, so
// the values read here are the ones the bundle inlines, `.env.local`'s domain
// switch included. A pair left uncommented there used to reach a store upload
// with nothing to flag it.
//
// The one way past it is BRACEMARK_NONPROD_RELEASE=1 in the SHELL, for a
// deliberate non-production release bundle (e2e/runner/release-build.ts,
// e2e/measure/data-mobile.ts). Shell-only, and enforced: a shell var lasts one
// command, so it can't be left on the way a file line can, and a build started
// from Xcode's UI never sees it — an Archive is production or a failed build.
// → docs/env-files.md, "bracemark-expo".
const PRODUCTION = { api: 'https://api.bracemark.com', site: 'https://bracemark.com' };
if (process.env.NODE_ENV === 'production') {
  const OVERRIDE = 'BRACEMARK_NONPROD_RELEASE';
  const inFile = readdirSync(__dirname)
    .filter((f) => f.startsWith('.env'))
    .find((f) =>
      new RegExp(`^\\s*(export\\s+)?${OVERRIDE}\\s*=`, 'm').test(
        readFileSync(join(__dirname, f), 'utf8'),
      ),
    );
  if (inFile) {
    throw new Error(
      `${OVERRIDE} is set in apps/bracemark-expo/${inFile} — it is shell-only, so it ` +
        'cannot be left on. Remove it there (docs/env-files.md, "bracemark-expo").',
    );
  }
  const api = process.env.EXPO_PUBLIC_API_URL;
  const site = process.env.EXPO_PUBLIC_SITE_URL;
  if (process.env[OVERRIDE] !== '1' && (api !== PRODUCTION.api || site !== PRODUCTION.site)) {
    throw new Error(
      `Refusing a release bundle that talks to ${api} / ${site}, not ` +
        `${PRODUCTION.api} / ${PRODUCTION.site}. Comment the pair back out in ` +
        'apps/bracemark-expo/.env.local (and unset any EXPO_PUBLIC_*_URL in your shell). ' +
        `A deliberate non-production release build takes ${OVERRIDE}=1 on its ` +
        'command line (docs/env-files.md, "bracemark-expo").',
    );
  }
}

const defaultConfig = getDefaultConfig(__dirname);
const { assetExts, sourceExts } = defaultConfig.resolver;

// THE SHELL OUTRANKS THE FILES IN A DEV BUNDLE TOO. A dev bundle reads every
// EXPO_PUBLIC_* through `expo/virtual/env`, which @expo/metro-config generates as
// `{ ...process.env, ...<the .env* files, bundled as modules> }` — the files
// spread OVER the polyfilled process.env, so a shell value (`npm run start:lan`,
// `start:staging`, `start:production`, `ios:lan`) lost to `.env.development` and
// the phone got `localhost`, while the bundle's env preamble showed the right
// value. Metro only sees those files because Expo adds their extensions here;
// without them the context is empty and the module is plain `process.env`, which
// Metro fills from its own environment, where @expo/env already ranked the shell
// above `.env.local` above `.env.<mode>`. Lost with them: hot-applying a `.env`
// edit, which a Metro restart covers. Release bundles are unaffected — babel
// inlines from process.env. Still Expo's behaviour as of SDK 58.
// → docs/env-files.md, "bracemark-expo".
const DOTENV_EXTS = ['env', 'local', 'development'];

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const customConfig = {
  cacheVersion: '@stxapps/bracemark-expo',
  watcher: {
    additionalExts: defaultConfig.watcher.additionalExts.filter(
      (ext) => !DOTENV_EXTS.includes(ext),
    ),
  },
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
const shareConfig = withShareExtension(nxConfig);

// THE iOS SHARE EXTENSION'S BUNDLE, AS A DEV BUILD REQUESTS IT. iOS kills an app
// extension at a hard per-process cap — 120 MB on an iPhone 12, iOS 26.5 — and
// Hermes compiles whatever Metro serves inside that process, from source
// (docs/share-sheet.md, _the share extension has almost no memory to spare_).
// expo-share-extension's controller builds its URL with RCTBundleURLProvider and
// tags it `shareExtension=true`, so only the share extension is rewritten here;
// the app's requests pass through untouched. Two rewrites:
//
//   - `dev=false&minify=true` — A PRODUCTION BUNDLE, EVEN FROM A DEV BUILD. The
//     controller asks for `dev=true&minify=false` in every Debug build, and that
//     bundle does not fit: the iPhone 12 killed the sheet at 122,994 KB on its
//     first render, with or without an Expo native view mounted. The cost is
//     the share sheet's dev tooling — no LogBox, no console relay to Metro — so
//     BRACEMARK_SHARE_DEV_BUNDLE=1 in the shell restores the dev bundle for the
//     simulator, which enforces no cap.
//   - NO `transform.bytecode`, always. RCTBundleURLProvider sends no
//     `transform.engine`, so Expo's own rewriter fills in the Hermes trio,
//     `transform.bytecode=1` among them — and a bytecode request skips
//     minification, leaving it to a `hermesc` step that only an export runs.
//     The dev server then serves the text as is: the same 1,500 modules as
//     8.0 MB and 210,757 lines instead of 3.2 MB minified. The engine itself
//     stays (and is set here if Expo ever stops adding it): this process does
//     run Hermes, and a release build bundles for it.
const productionShareBundle = process.env.BRACEMARK_SHARE_DEV_BUNDLE !== '1';
const rewriteShareRequest = shareConfig.server.rewriteRequestUrl;
shareConfig.server.rewriteRequestUrl = (url) => {
  const rewritten = rewriteShareRequest(url);
  if (!url.includes('shareExtension=true')) return rewritten;
  // Metro passes either a path or a full URL; parse against a dummy origin and
  // hand back the same shape.
  const parsed = new URL(rewritten, 'http://localhost');
  const params = parsed.searchParams;
  if (!params.has('transform.engine')) params.set('transform.engine', 'hermes');
  params.delete('transform.bytecode');
  if (productionShareBundle) {
    params.set('dev', 'false');
    params.set('minify', 'true');
  }
  return rewritten.startsWith('/') ? `${parsed.pathname}${parsed.search}` : parsed.toString();
};

module.exports = withUniwindConfig(shareConfig, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-env.d.ts',
});
