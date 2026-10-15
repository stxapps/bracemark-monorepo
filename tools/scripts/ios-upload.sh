#!/usr/bin/env bash
#
# Sign the archive `ios:bundle` built for the App Store and send it to App Store
# Connect — Organizer's Distribute, from the shell. Reached as `npm run
# ios:upload` from apps/bracemark-expo. docs/expo-build.md, _the npm scripts_.
#
#   1. tools/scripts/check-native-bundle.mjs on the archive again — the file
#      about to leave this Mac, however long ago it was built.
#   2. `asc xcode export --wait`: generates App Store Connect export options
#      with destination=upload, so xcodebuild's -exportArchive re-signs for the
#      App Store and uploads in one pass — one build-number reservation, as
#      Organizer makes — then polls until App Store Connect has processed the
#      build. -allowProvisioningUpdates lets Xcode's signed-in account supply the
#      cloud-managed Apple Distribution certificate and the App Store profiles;
#      no distribution certificate needs to live on this Mac.
#
# Submitting the processed build for review stays in App Store Connect.
#
# Requires: Xcode signed in to an account on the team; the `asc` CLI with its
# App Store Connect API key in the keychain (`asc auth status`).

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

APP_ROOT="$(cd "$(dirname "$0")/../../apps/bracemark-expo" && pwd)"
CHECK="$APP_ROOT/../../tools/scripts/check-native-bundle.mjs"
ARCHIVE="$APP_ROOT/build/Bracemark.xcarchive"
PLIST="$ARCHIVE/Products/Applications/Bracemark.app/Info.plist"

command -v asc >/dev/null || die "the asc CLI is not installed (brew install asc)"
[[ -f "$PLIST" ]] || die "no archive at $ARCHIVE — run npm run ios:bundle first"

VERSION="$(plutil -extract CFBundleShortVersionString raw "$PLIST")"
BUILD="$(plutil -extract CFBundleVersion raw "$PLIST")"

step "bundle check: Bracemark $VERSION ($BUILD)"
node "$CHECK" "$ARCHIVE"

step "sign for the App Store and upload"
asc xcode export \
  --archive-path "$ARCHIVE" \
  --wait \
  --xcodebuild-flag=-allowProvisioningUpdates \
  --output table

step "done"
echo "Bracemark $VERSION ($BUILD) is on App Store Connect — submit it for review there"
