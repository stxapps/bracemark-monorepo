#!/usr/bin/env bash
#
# Build bracemark-expo's Play Store bundle from a fresh android/ — the Android twin
# of tools/scripts/ios-bundle.sh. Reached as `npm run android:bundle` from
# apps/bracemark-expo, which runs this inside tools/scripts/store-release.sh so the
# commit is recorded. The upload is by hand. docs/expo-build.md, _the npm scripts_.
#
#   1. prebuild --clean --platform android, so android/ can't be stale against
#      app.config.ts or a plugin. Nothing else reports that: a change to the
#      manifest policy, a blocked permission or the R8 settings reaches android/
#      only through a prebuild, and a stale one builds and uploads without a word.
#   2. versionCode against the highest android/* tag — a read, before the
#      multi-minute build rather than after Play rejects the upload. A tag means
#      released, so this cannot see a code that was uploaded and never released.
#   3. bundleRelease. `--rerun` stays even on a fresh android/: Gradle does not
#      count the env as an input, so this is what guarantees the JS bundle was
#      made under this shell's env (docs/expo-build.md, _the npm scripts_).
#   4. tools/scripts/check-native-bundle.mjs on the bundle — production origins
#      only.
#   5. Copied to build/Bracemark.aab, outside android/, because the next prebuild
#      deletes android/ and an artifact inside it with it.
#
# Output (gitignored): apps/bracemark-expo/build/Bracemark.aab.
#
# Requires: the Play upload key in ~/.gradle/gradle.properties
# (docs/expo-build.md, _android release signing_) — no credential in the worktree.

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

APP_ROOT="$(cd "$(dirname "$0")/../../apps/bracemark-expo" && pwd)"
SCRIPTS="$APP_ROOT/../../tools/scripts"
OUT="$APP_ROOT/build"
AAB="$OUT/Bracemark.aab"

cd "$APP_ROOT"

step "prebuild (Android)"
# Deleted here rather than by --clean alone, for the reason ios-bundle.sh gives.
rm -rf android || { sleep 2 && rm -rf android; } || die "could not delete android/ — stop Gradle and rerun"
npx expo prebuild --clean --platform android

TAG="$(bash "$SCRIPTS/store-release.sh" name android)"
CODE="${TAG##*-}"

step "versionCode: $CODE against the released tags"
HIGHEST=0
HIGHEST_TAG=""
while IFS= read -r released; do
  [ -n "$released" ] || continue
  if [ "${released##*-}" -gt "$HIGHEST" ]; then
    HIGHEST="${released##*-}"
    HIGHEST_TAG="$released"
  fi
done < <(git tag -l 'android/*')
[ "$CODE" -gt "$HIGHEST" ] ||
  die "versionCode $CODE is not above $HIGHEST_TAG, which is released — set android.versionCode in apps/bracemark-expo/app.config.ts to $((HIGHEST + 1)) (or higher) and rerun"
echo "ok — the highest released versionCode is $HIGHEST"

rm -f "$AAB"
mkdir -p "$OUT"

step "bundle"
(cd android && ./gradlew :app:createBundleReleaseJsAndAssets --rerun :app:bundleRelease)

step "bundle check"
node "$SCRIPTS/check-native-bundle.mjs" android/app/build/outputs/bundle/release/app-release.aab

cp android/app/build/outputs/bundle/release/app-release.aab "$AAB"

step "done"
echo "$AAB — $TAG, production origins"
echo "next: upload it to Play Console"
