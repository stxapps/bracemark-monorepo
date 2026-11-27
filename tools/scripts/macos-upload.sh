#!/usr/bin/env bash
#
# Signs apps/bracemark-macos/build/Bracemark.xcarchive for the App Store and
# uploads it, as tools/scripts/ios-upload.sh does for the iOS app. Run
# `npm run bundle` first; once it is submitted for review, `npm run tag`.
#
# The archive is signed with the developer's Apple Development certificate and no
# profile (Config/Base.xcconfig). Export re-signs it with automatic signing, and
# -allowProvisioningUpdates lets xcodebuild create the macOS App Store profiles
# for com.bracemark.app and its extension in the developer account the first time.

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARCHIVE="$REPO_ROOT/apps/bracemark-macos/build/Bracemark.xcarchive"
PLIST="$ARCHIVE/Products/Applications/Bracemark.app/Contents/Info.plist"

command -v asc >/dev/null || die "the asc CLI is not installed (brew install asc)"
[[ -f "$PLIST" ]] || die "no archive at $ARCHIVE — run npm run bundle first"

VERSION="$(plutil -extract CFBundleShortVersionString raw "$PLIST")"
BUILD="$(plutil -extract CFBundleVersion raw "$PLIST")"

step "commit record: Bracemark for macOS $VERSION ($BUILD)"
bash "$REPO_ROOT/tools/scripts/store-release.sh" check macos

step "sign for the App Store and upload"
asc xcode export \
  --archive-path "$ARCHIVE" \
  --wait \
  --xcodebuild-flag=-allowProvisioningUpdates \
  --output table

step "done"
echo "Bracemark for macOS $VERSION ($BUILD) is on App Store Connect — submit it for review there"
echo "once it is submitted for review: npm run tag"
