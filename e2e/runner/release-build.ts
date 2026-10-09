import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { E2E_ROOT } from '../paths';
import { STAGING_ORIGINS } from './environment';
import { createRunId, writeJson } from './lib';
import { capture, inherit } from './process';
import { artifactHash, assertStagingBundle, type ReleaseReceipt } from './release-artifact';

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--platform' || !['ios', 'android'].includes(argv[1])) {
  throw new Error('usage: build-release:staging --platform ios|android');
}
const platform = argv[1] as 'ios' | 'android';
const root = join(E2E_ROOT, '..');
const appRoot = join(root, 'apps', 'bracemark-expo');
const output = join(E2E_ROOT, '.artifacts', 'releases', createRunId(`staging-${platform}`));
await mkdir(output, { recursive: true });

// Shell values outrank Expo/Nx dotenv loading. Keep NODE_ENV production: staging
// chooses the services, Release chooses compilation. No new env file is needed.
const env = {
  ...process.env,
  NODE_ENV: 'production',
  EXPO_PUBLIC_API_URL: STAGING_ORIGINS.api,
  EXPO_PUBLIC_SITE_URL: STAGING_ORIGINS.site,
  EXPO_PUBLIC_MEASURE_STALLS: '0',
};
const [commit, status] = await Promise.all([
  capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
  capture('git', ['status', '--porcelain'], { cwd: root }),
]);
// Regenerate the requested native project so plugins/R8 settings cannot be stale.
await inherit('npx', ['nx', 'prebuild', '@stxapps/bracemark-expo', '--', '--platform', platform], {
  cwd: root,
  env,
});
let artifact: string;
let mapping: ReleaseReceipt['mapping'];
if (platform === 'android') {
  const properties = await readFile(join(appRoot, 'android', 'gradle.properties'), 'utf8');
  for (const name of [
    'android.enableMinifyInReleaseBuilds',
    'android.enableShrinkResourcesInReleaseBuilds',
  ]) {
    if (!properties.split(/\r?\n/).includes(`${name}=true`))
      throw new Error(`${name} is not enabled after prebuild`);
  }
  await inherit(
    './gradlew',
    [
      ':app:createBundleReleaseJsAndAssets',
      '--rerun',
      ':app:assembleRelease',
      '--no-daemon',
      '--max-workers=2',
    ],
    {
      cwd: join(appRoot, 'android'),
      env,
    },
  );
  artifact = join(output, 'app-release.apk');
  await copyFile(join(appRoot, 'android/app/build/outputs/apk/release/app-release.apk'), artifact);
  const embedded = await promisify(execFile)(
    'unzip',
    ['-p', artifact, 'assets/index.android.bundle'],
    { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 },
  );
  assertStagingBundle(embedded.stdout);
  const mappingPath = join(output, 'mapping.txt');
  await copyFile(
    join(appRoot, 'android/app/build/outputs/mapping/release/mapping.txt'),
    mappingPath,
  );
  if (!(await readFile(mappingPath, 'utf8')).includes('# compiler: R8'))
    throw new Error('release build emitted no R8 mapping');
  mapping = { path: 'mapping.txt', sha256: await artifactHash(mappingPath) };
} else {
  const derivedData = join(output, 'derived-data');
  await inherit(
    'xcodebuild',
    [
      '-workspace',
      'ios/Bracemark.xcworkspace',
      '-scheme',
      'Bracemark',
      '-configuration',
      'Release',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derivedData,
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    { cwd: appRoot, env },
  );
  artifact = join(derivedData, 'Build/Products/Release-iphonesimulator/Bracemark.app');
  assertStagingBundle(await readFile(join(artifact, 'main.jsbundle')));
}
const receipt: ReleaseReceipt = {
  schemaVersion: 1,
  environment: 'staging',
  configuration: 'Release',
  platform,
  artifact: relative(output, artifact),
  sha256: await artifactHash(artifact),
  api: STAGING_ORIGINS.api,
  site: STAGING_ORIGINS.site,
  builtAt: new Date().toISOString(),
  checkout: { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 },
  mapping,
};
const receiptPath = await writeJson(join(output, 'release.json'), receipt);
console.log(`staging Release artifact: ${artifact}`);
console.log(`staging Release receipt: ${receiptPath}`);
console.log(
  platform === 'android'
    ? `Install: adb -s <serial> install -r "${artifact}"`
    : `Install: xcrun simctl install <udid> "${artifact}"`,
);
