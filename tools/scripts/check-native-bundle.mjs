// Checks that a bracemark-expo store build talks to production — the last check
// before an App Store / Play upload (docs/env-files.md, "bracemark-expo").
//
//   node tools/scripts/check-native-bundle.mjs <file.aab|file.apk|file.ipa|dir.xcarchive|dir.app>
//   node tools/scripts/check-native-bundle.mjs --latest-archive
//
// bracemark-expo's `android:bundle` runs the first form on the AAB it just built,
// and `ios:bundle` / `ios:upload` (tools/scripts/ios-{bundle,upload}.sh) on the
// archive they build and send; `ios:check-archive` runs the second, on the
// newest Xcode archive that holds Bracemark.app, for one made in Xcode's UI.
//
// WHY, WHEN metro.config.js ALREADY GUARDS. The guard reads the env as the bundle
// step starts; this reads the file that ships, and the two can differ:
//   - a STALE BUILD. A release bundle inlines EXPO_PUBLIC_* at transform time,
//     into Metro's cache, and the cache key does not include the env — so a
//     bundle step without --reset-cache bakes the PREVIOUS build's origins while
//     the guard approves the current env (seen: a staging export:embed run after
//     a production one came out byte-identical to it). Xcode and Gradle pass
//     --reset-cache, but `export:embed` drops it whenever CI is set; and Gradle
//     itself may skip the JS task as up to date after a staging build, since the
//     env is no input of it — hence `--rerun` in `android:bundle`.
//   - the guard bypassed (BRACEMARK_NONPROD_RELEASE=1 in the shell that built
//     it), or broken by an Expo upgrade that loads the env later.
//
// What it requires of EVERY embedded JS bundle — the app's, and on iOS the share
// extension's own main.jsbundle under PlugIns/:
//   - it names https://api.bracemark.com;
//   - it names no staging origin (dryrunbase.com) and no origin on the local
//     api's or site's port (:8787, :3001) on ANY host — localhost, the Mac's
//     `.local` name, a LAN address. Not bare `localhost`: a production bundle
//     legitimately carries http://localhost:3000 and :8081 from libraries.
// Hermes bytecode keeps its string table verbatim, so a byte search is exact —
// read as latin1, never as a grep without `-a`, which reports nothing for a
// binary file and reads as a pass. A bundle-less artifact is a failure too.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';

const REQUIRED = 'https://api.bracemark.com';
const FORBIDDEN = /dryrunbase\.com|https?:\/\/[A-Za-z0-9.[\]:-]+:(?:8787|3001)\b/g;
const ARCHIVES = join(homedir(), 'Library/Developer/Xcode/Archives');
const APP = 'Bracemark.app';

function die(message) {
  console.error(`check-native-bundle: ${message}`);
  process.exit(1);
}

// The newest archive holding Bracemark.app, by mtime. Xcode files them under
// <date>/<name>.xcarchive, alongside any other app's archives.
function latestArchive() {
  if (!existsSync(ARCHIVES)) die(`no Xcode archives at ${ARCHIVES}`);
  const archives = readdirSync(ARCHIVES)
    .flatMap((day) => {
      const dir = join(ARCHIVES, day);
      return statSync(dir).isDirectory()
        ? readdirSync(dir)
            .filter((n) => n.endsWith('.xcarchive'))
            .map((n) => join(dir, n))
        : [];
    })
    .filter((a) => existsSync(join(a, 'Products/Applications', APP)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (archives.length === 0) die(`no archive under ${ARCHIVES} holds ${APP}`);
  return archives[0];
}

// [label, bytes] for every JS bundle in the artifact.
function bundles(artifact) {
  if (!existsSync(artifact)) die(`${artifact} does not exist`);
  if (statSync(artifact).isFile()) {
    // AAB: base/assets/index.android.bundle; APK: assets/index.android.bundle;
    // IPA: Payload/Bracemark.app/main.jsbundle, and the share extension's under
    // Payload/Bracemark.app/PlugIns/.
    const entries = execFileSync('unzip', ['-Z1', artifact], { encoding: 'utf8' })
      .split('\n')
      .filter((e) => /(^|\/)assets\/[^/]+\.bundle$|^Payload\/.+\.jsbundle$/.test(e));
    return entries.map((e) => [
      e,
      execFileSync('unzip', ['-p', artifact, e], { maxBuffer: 256 * 1024 * 1024 }),
    ]);
  }
  const app = artifact.endsWith('.xcarchive')
    ? join(artifact, 'Products/Applications', APP)
    : artifact;
  if (!existsSync(app)) die(`${artifact} holds no ${APP}`);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.jsbundle')) found.push([relative(app, path), readFileSync(path)]);
    }
  };
  walk(app);
  return found;
}

const arg = process.argv[2];
if (!arg)
  die(
    'usage: check-native-bundle.mjs <file.aab|file.apk|file.ipa|dir.xcarchive|dir.app> | --latest-archive',
  );
const artifact = arg === '--latest-archive' ? latestArchive() : arg;
console.log(`checking ${artifact}`);

const found = bundles(artifact);
if (found.length === 0) die(`no JS bundle found in ${basename(artifact)}`);
let failed = false;
for (const [label, bytes] of found) {
  const text = bytes.toString('latin1');
  const bad = [...new Set(text.match(FORBIDDEN) ?? [])];
  const ok = text.includes(REQUIRED) && bad.length === 0;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!text.includes(REQUIRED)) console.log(`      does not name ${REQUIRED}`);
  if (bad.length > 0) console.log(`      names ${bad.join(', ')}`);
  failed ||= !ok;
}
if (failed) die('NOT a production build — do not upload it (docs/env-files.md, "bracemark-expo")');
console.log('production: every bundle names the production api and nothing else of ours');
