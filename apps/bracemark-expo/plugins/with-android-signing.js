const { withAppBuildGradle } = require('expo/config-plugins');

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
 * **No credential reaches this repo.** The four values live in
 * `~/.gradle/gradle.properties`, which Gradle merges into every build on this
 * machine; the block below only ever names them. That is why this plugin no
 * longer reads `process.env` and no longer writes `android/gradle.properties`:
 * a plaintext copy of the upload-key passwords used to land in the worktree on
 * every prebuild. Naming a property cannot leak one.
 * → docs/expo-build.md, _android release signing_.
 *
 * `BRACEMARK_UPLOAD_STORE_FILE` must be ABSOLUTE. Gradle's `file()` resolves a
 * relative path against `android/app/`, and the keystore deliberately lives
 * outside the directory `--clean` deletes. Nothing here can check that — the
 * value is invisible to JS now — so a relative path fails at build time with a
 * missing-keystore error rather than at prebuild.
 *
 * Unset is safe for a DEBUG build and fatal for a release one, and that split is
 * the whole point of the emitted `else` branch. With any of the four properties
 * missing the `release` config is never created and `findByName` hands
 * `buildTypes.release` the debug config, so a fresh clone still prebuilds and
 * still runs `assembleDebug`. But a debug-signed release artifact is rejected by
 * the Play Store *after* a multi-minute build and an upload, so when the
 * requested tasks name a release the guard throws instead, listing exactly which
 * properties are missing. The check cannot live in this JS: prebuild runs long
 * before Gradle resolves a property, and the values are deliberately invisible
 * here. Gradle is the only place that knows, so the plugin writes the check
 * rather than performing it.
 */
const PROPS = [
  'BRACEMARK_UPLOAD_STORE_FILE',
  'BRACEMARK_UPLOAD_STORE_PASSWORD',
  'BRACEMARK_UPLOAD_KEY_ALIAS',
  'BRACEMARK_UPLOAD_KEY_PASSWORD',
];

// The template's release buildType, anchored on its own comment so the rewrite
// can't hit the identical signingConfig line in the debug buildType just above
// it. `\s*=?\s*` because BOTH spellings ship in practice — observed on the same
// machine, from two different `expo-template-bare-minimum` versions: Groovy's
// method-call form (`signingConfig signingConfigs.debug`) and the assignment
// form (`signingConfig = signingConfigs.debug`). Matching only one is what made
// the first version of this plugin fail a `--clean` prebuild.
const RELEASE_SIGNING =
  /(\/\/ Caution! In production[\s\S]*?)signingConfig\s*=?\s*signingConfigs\.debug/;

// What each rewrite leaves behind — the marker its own guard checks for, so a
// failure names the anchor that actually went missing. INJECTED doubles as the
// idempotency check for a prebuild run without `--clean`.
const INJECTED = `storeFile file(${PROPS[0]})`;
const REWIRED = /signingConfigs\.findByName\('release'\)/;

const withAndroidSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-android-signing: expected a groovy app/build.gradle');
    }
    if (cfg.modResults.contents.includes(INJECTED)) return cfg;

    // All four are required together — a half-set machine is a misconfiguration,
    // not a debug machine. `logger.warn` on a debug build, `GradleException` when
    // the requested tasks name a release: silence there is what ships a
    // debug-signed bundle to the Play Store and finds out at upload.
    const names = PROPS.map((p) => `'${p}'`).join(', ');
    const block = `
        def bracemarkUploadMissing = [${names}].findAll { !project.hasProperty(it) }
        if (bracemarkUploadMissing.isEmpty()) {
            release {
                storeFile file(${PROPS[0]})
                storePassword ${PROPS[1]}
                keyAlias ${PROPS[2]}
                keyPassword ${PROPS[3]}
            }
        } else {
            def bracemarkSigningMsg = 'Play upload signing is not configured: ' +
                bracemarkUploadMissing.join(', ') +
                ' missing from ~/.gradle/gradle.properties' +
                ' (see docs/expo-build.md, "android release signing").'
            if (gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }) {
                throw new GradleException(bracemarkSigningMsg +
                    ' Refusing to build a release artifact with debug signing:' +
                    ' the Play Store rejects it, but only after the upload.')
            }
            logger.warn('w: ' + bracemarkSigningMsg +
                ' Release variants would fall back to debug signing.')
        }`;

    let contents = cfg.modResults.contents.replace(/signingConfigs\s*\{/, (m) => `${m}${block}`);
    // Group 1 is the comment only, so the whole `signingConfig … = …` line is
    // re-emitted — always in the assignment form, whichever spelling matched.
    // Both are valid Groovy, but AGP is moving toward `=`, and it keeps this
    // line consistent with the debug one the template writes beside it.
    contents = contents.replace(
      RELEASE_SIGNING,
      "$1signingConfig = signingConfigs.findByName('release') ?: signingConfigs.debug",
    );

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

module.exports = withAndroidSigning;
