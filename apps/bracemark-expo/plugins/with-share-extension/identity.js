const fs = require('node:fs');
const path = require('node:path');

const { withFinalizedMod, IOSConfig } = require('expo/config-plugins');

const { fromConfigPlugins, shareExtensionNames, unquote } = require('./util');

const xcode = fromConfigPlugins('xcode');
const plist = fromConfigPlugins('@expo/plist');

/**
 * WHAT THE SHARE EXTENSION MUST AGREE WITH THE APP ON, made to agree — and
 * asserted, because every one of them fails silently.
 *
 * target.js sets what the config states directly (the team, the versions) and
 * files.js the display name. Two values are written onto the app target by
 * OTHER plugins, and so are copied across here, after everything has run:
 *
 * - **`IPHONEOS_DEPLOYMENT_TARGET`.** `expo-build-properties` filters its
 *   targets to `TargetType.APPLICATION` (`build/ios.js`,
 *   `updateDeploymentTargetXcodeProject`), so an `app-extension` target is
 *   skipped by design. Left alone the extension inherits the project's 15.1
 *   while `ios.deploymentTarget` puts the app — and, through
 *   `Podfile.properties.json`, every Pod — on 26.0. Symptom: pods built for a
 *   newer iOS than the target linking them.
 * - **`TARGETED_DEVICE_FAMILY`.** Core `withDeviceFamily` writes
 *   `ios.supportsTablet` onto every target that exists when it runs. Missing
 *   it, the extension builds for Xcode's default — iPhone only — inside an
 *   iPad-native app, and on an iPad the share sheet runs it in iPhone
 *   compatibility mode, where App Review exercises it (guideline 2.4.1).
 *
 * The versions go onto EVERY target from what the app's Info.plist ships. On
 * the app target that changes nothing that ships (its plist carries literals),
 * but the scaffold leaves `MARKETING_VERSION = 1.0` there, and Xcode's target →
 * General → Identity reads the build setting — so the app target showed a
 * version it did not ship.
 *
 * **Why `finalized`.** Mod KEYS have a fixed precedence (`mod-compiler.js`:
 * `dangerous: -2`, `xcodeproj: -1`, `finalized: 1`), so this runs after every
 * xcodeproj and Info.plist mod has written its file, wherever `plugins` puts
 * this entry. Hence both files are re-read from disk: by `finalized` there is
 * no `modResults`, and what is on disk is what prebuild leaves behind.
 *
 * Ported from plugins/with-share-extension-build-settings.js, which did all of
 * this as a patch on expo-share-extension's output (docs/expo-build.md, _ios
 * share extension build settings_).
 */
const withShareExtensionIdentity = (config) =>
  withFinalizedMod(config, [
    'ios',
    (cfg) => {
      const { platformProjectRoot, projectName } = cfg.modRequest;
      const { targetName } = shareExtensionNames(cfg);
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
      const [appTarget] = targets.filter((target) =>
        Target.isTargetOfType(target, Target.TargetType.APPLICATION),
      );
      const extension = targets.find((target) => unquote(target.name) === targetName);
      if (!appTarget || !extension) {
        throw new Error(
          `with-share-extension: expected an application target and "${targetName}" in ` +
            `${projectName}.xcodeproj — target.js did not run, or the project was renamed.`,
        );
      }

      // Keyed by configuration name so Debug and Release stay independent,
      // with any app value as the fallback for a name the app doesn't have.
      // Kept in pbxproj spelling (`"1,2"`, quotes included), since they go
      // straight back into a pbxproj.
      const appSetting = (key) => {
        const byName = new Map(
          configurationsOf(appTarget)
            .map((buildConfig) => [buildConfig.name, buildConfig.buildSettings?.[key]])
            .filter(([, value]) => value),
        );
        return { byName, fallback: [...byName.values()][0] };
      };
      const deploymentTargets = appSetting('IPHONEOS_DEPLOYMENT_TARGET');
      const deviceFamilies = appSetting('TARGETED_DEVICE_FAMILY');

      // A target's Info.plist, located the way the build locates it. Values in
      // it may be `$(BUILD_SETTING)` references, substituted at build time, so
      // nothing read here compares until resolved against the settings of the
      // configuration doing the building.
      const infoPlistPathOf = (target) => {
        const relative = configurationsOf(target)
          .map((buildConfig) => buildConfig.buildSettings?.INFOPLIST_FILE)
          .find(Boolean);
        if (!relative) return null;
        const plistPath = path.join(platformProjectRoot, unquote(relative));
        return fs.existsSync(plistPath) ? plistPath : null;
      };
      const readPlist = (plistPath) => plist.parse(fs.readFileSync(plistPath, 'utf8'));
      const resolve = (value, buildSettings) =>
        typeof value === 'string'
          ? value.replace(/\$\((\w+)\)/g, (reference, key) =>
              buildSettings[key] === undefined ? reference : String(unquote(buildSettings[key])),
            )
          : value;
      // pbxproj leaves bare tokens unquoted and quotes anything else; a version
      // is normally a bare token, a prerelease suffix is not.
      const pbxValue = (value) => (/^[A-Za-z0-9_.]+$/.test(value) ? value : `"${value}"`);

      const appPlistPath = infoPlistPathOf(appTarget);
      const appPlist = appPlistPath ? readPlist(appPlistPath) : {};
      const appSettings = configurationsOf(appTarget)[0]?.buildSettings ?? {};
      // The three keys every bundle in the app has to agree on. Versions are
      // not per-configuration in this project, so one app value covers both.
      const appIdentity = Object.fromEntries(
        ['CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleDisplayName']
          .map((key) => [key, resolve(appPlist[key], appSettings)])
          .filter(([, value]) => value),
      );

      for (const buildConfig of configurationsOf(extension)) {
        const deploymentTarget =
          deploymentTargets.byName.get(buildConfig.name) ?? deploymentTargets.fallback;
        if (deploymentTarget)
          buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
        const deviceFamily = deviceFamilies.byName.get(buildConfig.name) ?? deviceFamilies.fallback;
        if (deviceFamily) buildConfig.buildSettings.TARGETED_DEVICE_FAMILY = deviceFamily;
      }

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

      // Loud guards, because everything above fails silently. What they catch
      // is a value that MISSED the extension: an empty Team dropdown, a
      // mismatched deployment target, an iPhone-only extension in an iPad app,
      // or a bundle whose identity differs from the app's — each of which
      // otherwise surfaces at archive time, at upload, or in front of a user.
      const teamId = cfg.ios?.appleTeamId;
      const extensionPlistPath = infoPlistPathOf(extension);
      const extensionPlist = extensionPlistPath ? readPlist(extensionPlistPath) : {};
      for (const buildConfig of configurationsOf(extension)) {
        const where = `${targetName}/${buildConfig.name}`;
        const settings = buildConfig.buildSettings ?? {};
        if (teamId && !settings.DEVELOPMENT_TEAM) {
          throw new Error(
            `with-share-extension: ${where} has no DEVELOPMENT_TEAM — that target is ` +
              `unsigned and Xcode will ask for its team.`,
          );
        }
        const expectedFamily = deviceFamilies.byName.get(buildConfig.name);
        if (expectedFamily && settings.TARGETED_DEVICE_FAMILY !== expectedFamily) {
          throw new Error(
            `with-share-extension: ${where} targets device family ` +
              `${settings.TARGETED_DEVICE_FAMILY ?? '(unset — iPhone only)'}, but the app ` +
              `targets ${expectedFamily} — on an iPad the share sheet would run it in ` +
              `iPhone compatibility mode.`,
          );
        }
        const expectedTarget = deploymentTargets.byName.get(buildConfig.name);
        if (expectedTarget && settings.IPHONEOS_DEPLOYMENT_TARGET !== expectedTarget) {
          throw new Error(
            `with-share-extension: ${where} is on iOS ${settings.IPHONEOS_DEPLOYMENT_TARGET}, ` +
              `but the app target is on ${expectedTarget} — the Pods are built for the latter.`,
          );
        }
        for (const [key, appValue] of Object.entries(appIdentity)) {
          const shipped = resolve(extensionPlist[key], settings);
          if (shipped !== appValue) {
            throw new Error(
              `with-share-extension: ${where} ships ${key} "${shipped}", but the app ships ` +
                `"${appValue}" — every bundle inside the app has to agree on these. App Store ` +
                `validation rejects a version mismatch at upload, and CFBundleDisplayName is ` +
                `the share sheet's own label.`,
            );
          }
        }
      }

      return cfg;
    },
  ]);

module.exports = { withShareExtensionIdentity };
