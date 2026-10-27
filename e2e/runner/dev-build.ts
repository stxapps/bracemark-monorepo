import { readdir } from 'node:fs/promises';

import { type NativePlatform } from './cli';
import { capture } from './process';

// A local native run drives a DEVELOPMENT build: cold launch opens the app
// through the dev launcher's link and the JS comes from Metro
// (flows/subflows/cold-launch.yaml). A Release build installed in its place —
// the one a staging run leaves on the device — still launches, ignores that
// link, and runs the bundle embedded in it, which names the api it was built
// for. Nothing fails at launch: every online case then signs in against that
// api, which has never heard of the local throwaway account, and fails 300s
// later as "Incorrect username or password" with nothing in the local api's log
// (docs/e2e.md, _running it_). So a local run checks the installed build is a
// dev build first, the mirror of the staging preflight's refusal of a
// debuggable one (release-artifact.ts).

// `dumpsys package`'s pkgFlags carry DEBUGGABLE on a debug build and not on a
// Release one — the same test the staging preflight makes the other way round.
export function androidDevBuildProblem(packageDump: string): string | undefined {
  if (/\bDEBUGGABLE\b/.test(packageDump)) return undefined;
  return 'is not debuggable — a Release build, likely left by a staging run';
}

// A dev-client build carries the dev launcher's resource bundle; a Release one
// carries main.jsbundle instead (release-build.ts reads it from there).
export function iosDevBuildProblem(appEntries: string[]): string | undefined {
  if (appEntries.includes('EXDevLauncher.bundle')) return undefined;
  return appEntries.includes('main.jsbundle')
    ? 'embeds main.jsbundle and no dev launcher — a Release build, likely left by a staging run'
    : 'has no dev launcher (EXDevLauncher.bundle), so it is not an Expo development build';
}

const REINSTALL: Record<NativePlatform, string> = {
  ios: 'npm run expo:ios -- --no-bundler',
  // A debug APK cannot update one signed with the upload key in place.
  android: 'adb uninstall com.bracemark.app && npm run expo:android -- --no-bundler',
};

export async function assertInstalledDevBuild(options: {
  platform: NativePlatform;
  deviceId: string;
  appId: string;
  installPath: string;
}): Promise<void> {
  const problem =
    options.platform === 'android'
      ? androidDevBuildProblem(
          (
            await capture(
              'adb',
              ['-s', options.deviceId, 'shell', 'dumpsys', 'package', options.appId],
              { timeoutMs: 15_000 },
            )
          ).stdout,
        )
      : iosDevBuildProblem(await readdir(options.installPath));
  if (!problem) return;
  throw new Error(
    `The ${options.appId} installed on ${options.deviceId} ${problem}. A local run needs the ` +
      `development build: install it with \`${REINSTALL[options.platform]}\` (Metro running), ` +
      'or run the staging script for this device instead (docs/e2e.md, _running it_).',
  );
}
