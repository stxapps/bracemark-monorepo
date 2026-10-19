const { withFinalizedMod, IOSConfig } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

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

const xcode = fromConfigPlugins('xcode');
const plist = fromConfigPlugins('@expo/plist');

/**
 * What the iOS **share extension** target is born without.
 *
 * `expo-share-extension` creates `BracemarkShareExtension` from a hardcoded
 * build-settings map (`plugin/build/xcode/addToXCConfigurationList.js`) and a
 * hardcoded Info.plist (`plugin/build/withShareExtensionInfoPlist.js`), and
 * five values that are correct on the app target never reach it. All five are
 * SILENT — prebuild succeeds, the config is valid, and no lint, type or test
 * reads a pbxproj or a plist:
 *
 * - **`DEVELOPMENT_TEAM`.** Core config-plugins' `withDevelopmentTeam` does walk
 *   every native target, but it runs before this one EXISTS. `withMod` chains
 *   same-key mods so the last registered runs first, and `getPrebuildConfig`
 *   reads `app.config.ts` — registering `expo-share-extension` — before it
 *   applies `withIosExpoPlugins`, which is what registers `withDevelopmentTeam`.
 *   Symptom: Xcode → targets → BracemarkShareExtension → Signing &
 *   Capabilities with an empty Team, once per `--clean`.
 * - **`IPHONEOS_DEPLOYMENT_TARGET`.** This one is NOT about order.
 *   `expo-build-properties` filters its targets to
 *   `TargetType.APPLICATION` (`build/ios.js`, `updateDeploymentTargetXcodeProject`),
 *   so an `app-extension` target is skipped by design and would still be
 *   skipped if it ran last. The extension keeps the plugin's literal `"15.1"`
 *   while `ios.deploymentTarget` puts the app — and, through
 *   `Podfile.properties.json`, every Pod — on 26.0. Symptom: pods built for a
 *   newer iOS than the target linking them.
 * - **`TARGETED_DEVICE_FAMILY`.** Order again, the `DEVELOPMENT_TEAM` kind: core
 *   `withDeviceFamily` writes `ios.supportsTablet` onto every target that
 *   exists when it runs, which is before this one does, and the plugin's map
 *   names no family — so the extension builds for Xcode's default, iPhone
 *   only, inside an app that is iPad-native. Symptom: on an iPad the share
 *   sheet runs the extension as an iPhone-sized box over Safari, the very
 *   compatibility mode the app itself just left, and App Review exercises it
 *   there (guideline 2.4.1).
 * - **`MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`.** The extension's
 *   Info.plist takes `CFBundleShortVersionString` from `$(MARKETING_VERSION)`,
 *   and the plugin seeds that setting from the TOP-LEVEL `config.version` —
 *   while the app target's plist is written from `ios.version`. Two config keys
 *   for one number, and setting only one ships an extension whose version the
 *   app does not share. Symptom: nothing local at all. The first thing that
 *   reports it is App Store validation rejecting the upload, which is also the
 *   most expensive place to learn it. (`app.config.ts` now carries a single
 *   top-level `version` for the same reason; this is the belt to that braces,
 *   and the one that survives someone re-adding `ios.version`.)
 * - **`CFBundleDisplayName`.** Hardcoded to `"$(PRODUCT_NAME) Share Extension"`,
 *   which resolves to "BracemarkShareExtension Share Extension" — and that
 *   string is the label under the icon in the iOS share sheet, where the
 *   Android half of the same feature inherits the app's plain "Bracemark".
 *   Symptom: user-facing, on a surface no test opens and only a real share
 *   shows.
 *
 * None is fixable by reordering `plugins`, and hand-fixing them in Xcode works
 * only until the next `--clean` — `ios/` is CNG output, so the fix dies with a
 * clean working tree throughout. → docs/expo-build.md, _ios share extension
 * build settings_.
 *
 * **Why a `finalized` mod.** A `withXcodeProject` mod would work for the team,
 * but only if this plugin were listed BEFORE `expo-share-extension` in
 * `plugins` — reverse order, per the chaining above — so a later innocent
 * reorder of that array would silently undo it. Mod KEYS, unlike mods within a
 * key, have a fixed precedence (`mod-compiler.js`: `dangerous: -2`,
 * `xcodeproj: -1`, `finalized: 1`), so `finalized` runs after the whole
 * xcodeproj chain has run and written the file, wherever the array puts it. The
 * same holds for the plists: `expo-share-extension` writes the extension's from
 * inside an `infoPlist` mod, which `finalized` also outruns. That is why both
 * files here are re-read from disk: by `finalized` there is no `modResults` to
 * take, and what is on disk is what prebuild is about to leave behind.
 *
 * Everything is COPIED FROM THE APP TARGET rather than restated here — the
 * deployment target and the device family from its build settings, the
 * versions and the display name from the Info.plist it actually ships — so
 * `app.config.ts` stays the only place any of these live and a bump can't leave
 * the extension behind. The project-level configurations keep the template's
 * 15.1 and that is deliberate: target-level settings win, and upstream leaves
 * them alone for the app target too.
 *
 * Unset `APPLE_TEAM_ID` stays safe, matching `withDevelopmentTeam`: a falsy id
 * is skipped and no team is written, so a fresh clone still prebuilds and you
 * pick both teams by hand.
 */
const withShareExtensionBuildSettings = (config) =>
  withFinalizedMod(config, [
    'ios',
    (cfg) => {
      const { platformProjectRoot, projectName } = cfg.modRequest;
      const pbxprojPath = path.join(
        platformProjectRoot,
        `${projectName}.xcodeproj`,
        'project.pbxproj',
      );

      const project = xcode.project(pbxprojPath);
      project.parseSync();

      const { Target, XcodeUtils } = IOSConfig;
      const configurationsOf = (target) =>
        XcodeUtils.getBuildConfigurationsForListId(project, target.buildConfigurationList).map(
          ([, buildConfig]) => buildConfig,
        );

      const targets = Target.getNativeTargets(project).map(([, target]) => target);
      const appTargets = targets.filter((target) =>
        Target.isTargetOfType(target, Target.TargetType.APPLICATION),
      );
      const otherTargets = targets.filter((target) => !appTargets.includes(target));

      // Nothing to fix up without a second target — the share extension is what
      // puts one there, and dropping it from `plugins` is a legitimate config,
      // not a failure. Returning early keeps the guards below from firing on it.
      if (!otherTargets.length) return cfg;

      const teamId = cfg.ios?.appleTeamId;
      if (teamId) {
        IOSConfig.DevelopmentTeam.updateDevelopmentTeamForPbxproj(project, teamId);
      }

      // Keyed by configuration name so Debug and Release stay independent, with
      // any app value as the fallback for a name the app target doesn't have.
      const appDeploymentTargets = new Map(
        appTargets
          .flatMap(configurationsOf)
          .map((buildConfig) => [
            buildConfig.name,
            buildConfig.buildSettings?.IPHONEOS_DEPLOYMENT_TARGET,
          ])
          .filter(([, deploymentTarget]) => deploymentTarget),
      );
      const fallbackDeploymentTarget = [...appDeploymentTargets.values()][0];
      // The device families, the same way: keyed by configuration, app value as
      // the fallback. Kept in its pbxproj spelling (`"1,2"`, quotes included),
      // since it goes straight back into a pbxproj.
      const appDeviceFamilies = new Map(
        appTargets
          .flatMap(configurationsOf)
          .map((buildConfig) => [
            buildConfig.name,
            buildConfig.buildSettings?.TARGETED_DEVICE_FAMILY,
          ])
          .filter(([, family]) => family),
      );
      const fallbackDeviceFamily = [...appDeviceFamilies.values()][0];

      // A target's Info.plist, located the way the build locates it. Values in
      // it may be `$(BUILD_SETTING)` references, substituted at build time, so
      // nothing read here can be compared to anything until it is resolved
      // against the settings of the configuration doing the building.
      const infoPlistPathOf = (target) => {
        const relative = configurationsOf(target)
          .map((buildConfig) => buildConfig.buildSettings?.INFOPLIST_FILE)
          .find(Boolean);
        if (!relative) return null;
        const plistPath = path.join(platformProjectRoot, relative.replace(/^"|"$/g, ''));
        return fs.existsSync(plistPath) ? plistPath : null;
      };
      const readPlist = (plistPath) => plist.parse(fs.readFileSync(plistPath, 'utf8'));
      const resolve = (value, buildSettings) =>
        typeof value === 'string'
          ? value.replace(/\$\((\w+)\)/g, (reference, key) =>
              // pbxproj values keep their quoting, a resolved plist value has
              // none — strip it or a quoted setting never compares equal.
              buildSettings[key] === undefined
                ? reference
                : String(buildSettings[key]).replace(/^"|"$/g, ''),
            )
          : value;
      // pbxproj leaves bare tokens unquoted and quotes anything else; a version
      // is normally a bare token, a prerelease suffix is not.
      const pbxValue = (value) => (/^[A-Za-z0-9_.]+$/.test(value) ? value : `"${value}"`);

      const [appTarget] = appTargets;
      const appPlistPath = appTarget && infoPlistPathOf(appTarget);
      const appPlist = appPlistPath ? readPlist(appPlistPath) : {};
      const appSettings = (appTarget ? configurationsOf(appTarget) : [])[0]?.buildSettings ?? {};
      // The three keys every bundle in the app has to agree on. Versions are not
      // per-configuration in this project (Debug and Release ship the same
      // numbers), so one app value covers both.
      const appIdentity = Object.fromEntries(
        ['CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleDisplayName']
          .map((key) => [key, resolve(appPlist[key], appSettings)])
          .filter(([, value]) => value),
      );

      for (const target of otherTargets) {
        for (const buildConfig of configurationsOf(target)) {
          const deploymentTarget =
            appDeploymentTargets.get(buildConfig.name) ?? fallbackDeploymentTarget;
          if (deploymentTarget) {
            buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
          }
          const deviceFamily = appDeviceFamilies.get(buildConfig.name) ?? fallbackDeviceFamily;
          if (deviceFamily) {
            buildConfig.buildSettings.TARGETED_DEVICE_FAMILY = deviceFamily;
          }
        }

        // The display name has no build setting to write — `GENERATE_INFOPLIST_FILE`
        // is on for this target, but a key already present in the file wins over
        // the `INFOPLIST_KEY_*` merge — so the plist is where it has to go.
        const plistPath = infoPlistPathOf(target);
        if (plistPath && appIdentity.CFBundleDisplayName) {
          const targetPlist = readPlist(plistPath);
          if (targetPlist.CFBundleDisplayName !== appIdentity.CFBundleDisplayName) {
            targetPlist.CFBundleDisplayName = appIdentity.CFBundleDisplayName;
            fs.writeFileSync(plistPath, plist.build(targetPlist));
          }
        }
      }

      // Versions go to the build settings the extension's plist already
      // references, rather than into the plist, so the two stay one source of
      // truth — and onto EVERY target, app included. On the app target they
      // change nothing that ships (its plist carries literals, written from
      // `ios.version`), but the scaffold leaves `MARKETING_VERSION = 1.0` there
      // forever, and Xcode's target → General → Identity reads the build
      // setting, not the plist. So the app target shows a version it does not
      // ship, and the only way to tell which one is real is to open the plist.
      // Aligning them costs nothing and removes the question.
      for (const target of targets) {
        for (const buildConfig of configurationsOf(target)) {
          if (appIdentity.CFBundleShortVersionString) {
            buildConfig.buildSettings.MARKETING_VERSION = pbxValue(
              appIdentity.CFBundleShortVersionString,
            );
          }
          if (appIdentity.CFBundleVersion) {
            buildConfig.buildSettings.CURRENT_PROJECT_VERSION = pbxValue(
              appIdentity.CFBundleVersion,
            );
          }
        }
      }

      fs.writeFileSync(pbxprojPath, project.writeSync());

      // Loud guards, because everything above fails silently. These pass
      // unchanged if Expo or expo-share-extension ever fixes any of it
      // upstream — the writes are idempotent. What they catch is a write that
      // MISSED a target: an empty Team dropdown, a mismatched deployment
      // target, an iPhone-only extension in an iPad app, or a bundle whose
      // identity differs from the app's, each of
      // which otherwise surfaces at archive time or later.
      for (const target of targets) {
        const plistPath = infoPlistPathOf(target);
        const targetPlist = plistPath ? readPlist(plistPath) : {};
        for (const buildConfig of configurationsOf(target)) {
          const where = `${target.name}/${buildConfig.name}`;
          const settings = buildConfig.buildSettings ?? {};
          if (teamId && !settings.DEVELOPMENT_TEAM) {
            throw new Error(
              `with-share-extension-build-settings: ${where} has no DEVELOPMENT_TEAM — ` +
                `that target is unsigned and Xcode will ask for its team.`,
            );
          }
          const expectedFamily = appDeviceFamilies.get(buildConfig.name);
          if (expectedFamily && settings.TARGETED_DEVICE_FAMILY !== expectedFamily) {
            throw new Error(
              `with-share-extension-build-settings: ${where} targets device family ` +
                `${settings.TARGETED_DEVICE_FAMILY ?? '(unset — iPhone only)'}, but the app ` +
                `targets ${expectedFamily} — on an iPad the share sheet would run it in ` +
                `iPhone compatibility mode.`,
            );
          }
          const expected = appDeploymentTargets.get(buildConfig.name);
          if (expected && settings.IPHONEOS_DEPLOYMENT_TARGET !== expected) {
            throw new Error(
              `with-share-extension-build-settings: ${where} is on iOS ` +
                `${settings.IPHONEOS_DEPLOYMENT_TARGET}, but the app target is on ${expected} — ` +
                `the Pods are built for the latter.`,
            );
          }
          for (const [key, appValue] of Object.entries(appIdentity)) {
            if (targetPlist[key] === undefined) continue;
            const shipped = resolve(targetPlist[key], settings);
            if (shipped !== appValue) {
              throw new Error(
                `with-share-extension-build-settings: ${where} ships ${key} ` +
                  `"${shipped}", but the app ships "${appValue}" — every bundle inside ` +
                  `the app has to agree on these. App Store validation rejects a version ` +
                  `mismatch at upload, and CFBundleDisplayName is the share sheet's own label.`,
              );
            }
          }
        }
      }

      return cfg;
    },
  ]);

module.exports = withShareExtensionBuildSettings;
