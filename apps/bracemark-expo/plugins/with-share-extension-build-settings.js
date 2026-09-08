const { withFinalizedMod, IOSConfig } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// `xcode` is @expo/config-plugins' own parser, not a direct dependency of this
// app — resolved from that package rather than by bare `require('xcode')` so a
// change in npm hoisting can't silently pick up a different copy, or none.
const xcode = require(
  require.resolve('xcode', {
    paths: [path.dirname(require.resolve('@expo/config-plugins/package.json'))],
  }),
);

/**
 * Build settings the iOS **share extension** target is born without.
 *
 * `expo-share-extension` creates `BracemarkShareExtension` from a hardcoded
 * build-settings map (`plugin/build/xcode/addToXCConfigurationList.js`), and
 * two settings that are correct on the app target never reach it. Both are
 * SILENT — prebuild succeeds, the config is valid, and no lint, type or test
 * reads a pbxproj:
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
 *   `Podfile.properties.json`, every Pod — on 18.0. Symptom: pods built for a
 *   newer iOS than the target linking them.
 *
 * Neither is fixable by reordering `plugins`, and hand-fixing them in Xcode
 * works only until the next `--clean` — `ios/` is CNG output, so the fix dies
 * with a clean working tree throughout. → docs/expo-build.md, _ios share
 * extension build settings_.
 *
 * **Why a `finalized` mod.** A `withXcodeProject` mod would work for the team,
 * but only if this plugin were listed BEFORE `expo-share-extension` in
 * `plugins` — reverse order, per the chaining above — so a later innocent
 * reorder of that array would silently undo it. Mod KEYS, unlike mods within a
 * key, have a fixed precedence (`mod-compiler.js`: `dangerous: -2`,
 * `xcodeproj: -1`, `finalized: 1`), so `finalized` runs after the whole
 * xcodeproj chain has run and written the file, wherever the array puts it.
 * That is also why this re-reads the pbxproj from disk: by `finalized` there is
 * no `modResults` to take.
 *
 * The deployment target is COPIED FROM THE APP TARGET rather than restated
 * here, so the `expo-build-properties` value in `app.config.ts` stays the only
 * place the number lives and a bump can't leave the extension behind. The
 * project-level configurations keep the template's 15.1 and that is deliberate:
 * target-level settings win, and upstream leaves them alone for the app target
 * too.
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

      for (const target of otherTargets) {
        for (const buildConfig of configurationsOf(target)) {
          const deploymentTarget =
            appDeploymentTargets.get(buildConfig.name) ?? fallbackDeploymentTarget;
          if (deploymentTarget) {
            buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
          }
        }
      }

      fs.writeFileSync(pbxprojPath, project.writeSync());

      // Loud guards, because everything above fails silently. These pass
      // unchanged if Expo or expo-share-extension ever fixes either problem
      // upstream — the writes are idempotent. What they catch is a write that
      // MISSED a target: an empty Team dropdown, or a mismatched deployment
      // target, either of which otherwise surfaces at archive time.
      for (const target of targets) {
        for (const buildConfig of configurationsOf(target)) {
          const where = `${target.name}/${buildConfig.name}`;
          const settings = buildConfig.buildSettings ?? {};
          if (teamId && !settings.DEVELOPMENT_TEAM) {
            throw new Error(
              `with-share-extension-build-settings: ${where} has no DEVELOPMENT_TEAM — ` +
                `that target is unsigned and Xcode will ask for its team.`,
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
        }
      }

      return cfg;
    },
  ]);

module.exports = withShareExtensionBuildSettings;
