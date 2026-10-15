#!/usr/bin/env bash
#
# Build bracemark-expo's App Store archive without opening Xcode — the iOS twin of
# `android:bundle`. Reached as `npm run ios:bundle` from apps/bracemark-expo;
# `npm run ios:upload` (tools/scripts/ios-upload.sh) then signs it for the App
# Store and sends it. docs/expo-build.md, _the npm scripts_.
#
#   1. prebuild --clean --platform ios, so ios/ can't be stale against
#      app.config.ts (version, buildNumber, plugins, excludedPackages).
#   2. the build number, against App Store Connect — a read, before the
#      multi-minute archive rather than after an upload rejects it.
#   3. archive (`asc xcode archive`): Release, generic iOS device, automatic
#      signing under the team prebuild wrote from APPLE_TEAM_ID.
#   4. tools/scripts/check-native-bundle.mjs on the archive — production
#      origins only, in the app's bundle and the iOS share extension's.
#
# It stops at the archive ON PURPOSE. Exporting an App Store .ipa is not a local
# step: Xcode's `-exportArchive` with method app-store-connect asks App Store
# Connect for the build number and RESERVES it (POST /v1/buildUploads, state
# AWAITING_UPLOAD) even with destination=export — seen 2026-10-15, Xcode 26.6. A
# local export followed by a separate upload would reserve the number twice, so
# the export and the upload are one step, in ios:upload, as in Organizer.
#
# Output (gitignored): apps/bracemark-expo/build/Bracemark.xcarchive.
#
# Requires: the `asc` CLI with its App Store Connect API key in the keychain
# (`asc auth status`) — no credential in the worktree.

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

APP_ROOT="$(cd "$(dirname "$0")/../../apps/bracemark-expo" && pwd)"
CHECK="$APP_ROOT/../../tools/scripts/check-native-bundle.mjs"
BUNDLE_ID=com.bracemark.app
OUT="$APP_ROOT/build"
ARCHIVE="$OUT/Bracemark.xcarchive"

command -v asc >/dev/null || die "the asc CLI is not installed (brew install asc)"
cd "$APP_ROOT"

step "prebuild (iOS)"
# ios/ is deleted here rather than by --clean alone: prebuild's own rmdir of the
# ~1 GB Pods tree failed once with ENOTEMPTY (something, likely Spotlight,
# writing into it mid-delete), and a second rm -rf pass gets past that.
rm -rf ios || { sleep 2 && rm -rf ios; } || die "could not delete ios/ — close Xcode and rerun"
npx expo prebuild --clean --platform ios

# The app target's Info.plist carries the literal values prebuild wrote; the
# share extension's resolves to the same through its build settings.
VERSION="$(plutil -extract CFBundleShortVersionString raw ios/Bracemark/Info.plist)"
BUILD="$(plutil -extract CFBundleVersion raw ios/Bracemark/Info.plist)"

# App Store Connect refuses a build number already used for the version. Asked
# per version, as Apple keys it; a fresh version starts again from 1.
step "build number: $VERSION ($BUILD) against App Store Connect"
NEXT="$(asc builds next-build-number --app "$BUNDLE_ID" --version "$VERSION" --platform IOS --output json |
  node -pe 'JSON.parse(require("fs").readFileSync(0)).nextBuildNumber')"
[[ "$BUILD" =~ ^[0-9]+$ && "$NEXT" =~ ^[0-9]+$ ]] ||
  die "can't compare build numbers (local '$BUILD', next on App Store Connect '$NEXT')"
((BUILD >= NEXT)) ||
  die "build $BUILD is already taken for $VERSION — set ios.buildNumber in apps/bracemark-expo/app.config.ts to '$NEXT' (or higher) and rerun"
echo "ok — the next free build number for $VERSION is $NEXT"

rm -rf "$ARCHIVE" "$OUT/Bracemark.ipa" "$OUT/ExportOptions.plist"
mkdir -p "$OUT"

step "archive"
asc xcode archive \
  --workspace ios/Bracemark.xcworkspace \
  --scheme Bracemark \
  --configuration Release \
  --clean \
  --archive-path "$ARCHIVE" \
  --xcodebuild-flag=-destination \
  --xcodebuild-flag=generic/platform=iOS \
  --output table

step "bundle check"
node "$CHECK" "$ARCHIVE"

step "done"
echo "$ARCHIVE — Bracemark $VERSION ($BUILD), production origins"
echo "next: npm run ios:upload"
