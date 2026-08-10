const path = require('node:path');

const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

/**
 * Release signing for the Play upload key.
 *
 * `android/` is prebuild output (CNG) — gitignored and deleted wholesale by
 * `npm run prebuild` (`expo prebuild --clean`), so a hand-added
 * `signingConfigs.release` survives exactly until the next regenerate. This
 * injects it instead, which makes `--clean` a no-op rather than a re-do. The
 * prebuild template signs `release` with the DEBUG config, which is fine for
 * `run-android --variant release` on a device but is rejected by the Play Store.
 *
 * Credentials come from `.env.local` — the `APPLE_TEAM_ID` precedent
 * (docs/env-files.md): gitignored, mode-agnostic (prebuild forces
 * NODE_ENV=development before loading env files), and NOT `EXPO_PUBLIC_`, since
 * these are config-time values that must never reach the JS bundle.
 *
 * Unset is safe — the plugin no-ops and the template's debug signing stands, so
 * a fresh clone still prebuilds and can build/run a release variant locally.
 * Same falsy-skip behaviour as `withDevelopmentTeam` on iOS.
 */
const PROPS = {
  storeFile: 'BRACEMARK_UPLOAD_STORE_FILE',
  storePassword: 'BRACEMARK_UPLOAD_STORE_PASSWORD',
  keyAlias: 'BRACEMARK_UPLOAD_KEY_ALIAS',
  keyPassword: 'BRACEMARK_UPLOAD_KEY_PASSWORD',
};

// The template's release buildType, anchored on its own comment so the rewrite
// can't hit the identical signingConfig line in the debug buildType just above
// it. `\s*=?\s*` because BOTH spellings ship in practice — observed on the same
// machine, from two different `expo-template-bare-minimum` versions: Groovy's
// method-call form (`signingConfig signingConfigs.debug`) and the assignment
// form (`signingConfig = signingConfigs.debug`). Matching only one is what made
// the first version of this plugin fail a `--clean` prebuild.
const RELEASE_SIGNING =
  /(\/\/ Caution! In production[\s\S]*?)signingConfig\s*=?\s*signingConfigs\.debug/;

// What the injected block leaves behind — the marker each guard below checks for,
// so a failure names the anchor that actually went missing.
const INJECTED = `storeFile file(${PROPS.storeFile})`;
const REWIRED = /signingConfig\s*=?\s*signingConfigs\.release/;

const withAndroidSigning = (config) => {
  const storeFile = process.env[PROPS.storeFile];
  const storePassword = process.env[PROPS.storePassword];
  const keyAlias = process.env[PROPS.keyAlias];
  const keyPassword = process.env[PROPS.keyPassword];
  if (!storeFile || !storePassword || !keyAlias || !keyPassword) return config;

  // Resolved against the app root (this file's parent), and absolute in the
  // output — gradle would otherwise resolve it relative to `android/app/`, and
  // the keystore deliberately lives OUTSIDE the directory prebuild deletes.
  const absStoreFile = path.resolve(__dirname, '..', storeFile);

  config = withGradleProperties(config, (cfg) => {
    const entries = {
      [PROPS.storeFile]: absStoreFile,
      [PROPS.storePassword]: storePassword,
      [PROPS.keyAlias]: keyAlias,
      [PROPS.keyPassword]: keyPassword,
    };
    // Replace rather than append: without `--clean`, prebuild re-runs this mod
    // over the gradle.properties a previous run already wrote.
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key in entries),
    );
    for (const [key, value] of Object.entries(entries)) {
      cfg.modResults.push({ type: 'property', key, value });
    }
    return cfg;
  });

  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-android-signing: expected a groovy app/build.gradle');
    }
    if (cfg.modResults.contents.includes('signingConfigs.release')) return cfg;

    const block = `
        release {
            storeFile file(${PROPS.storeFile})
            storePassword ${PROPS.storePassword}
            keyAlias ${PROPS.keyAlias}
            keyPassword ${PROPS.keyPassword}
        }
`;
    let contents = cfg.modResults.contents.replace(/signingConfigs\s*\{/, (m) => `${m}${block}`);
    // Group 1 is the comment only, so the whole `signingConfig … = …` line is
    // re-emitted — always in the assignment form, whichever spelling matched.
    // Both are valid Groovy, but AGP is moving toward `=`, and it keeps this
    // line consistent with the debug one the template writes beside it.
    contents = contents.replace(RELEASE_SIGNING, '$1signingConfig = signingConfigs.release');

    // Fail loudly rather than silently emitting a debug-signed bundle if an SDK
    // bump moves the template's anchors. Each guard checks the marker its own
    // replacement leaves, so the message names the anchor that actually moved.
    if (!contents.includes(INJECTED)) {
      throw new Error(
        'with-android-signing: could not find `signingConfigs {` in app/build.gradle — template changed',
      );
    }
    if (!REWIRED.test(contents)) {
      throw new Error(
        'with-android-signing: found `signingConfigs {` but could not rewire buildTypes.release — its `// Caution! In production` comment or `signingConfig signingConfigs.debug` line moved',
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
};

module.exports = withAndroidSigning;
