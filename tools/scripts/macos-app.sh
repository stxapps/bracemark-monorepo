#!/usr/bin/env bash
#
# Builds apps/bracemark-macos with the browser extension's Safari build inside it.
# docs/browser-extension.md, _Safari_; docs/hosting.md, _which build is in a store_.
#
#   macos-app.sh staging   Debug build against the staging api, then opens the app,
#                          which is what makes Safari list the extension. Reached
#                          through `npm run app:staging` in apps/bracemark-macos.
#   macos-app.sh bundle    The App Store build: production api, Release archive at
#                          apps/bracemark-macos/build/Bracemark.xcarchive. Reached
#                          through `npm run bundle`, which records the commit
#                          (store-release.sh). Then `npm run upload`.
#
# The extension's code is never built by Xcode. This script builds it with WXT
# (through Nx, so a cached build is reused) and copies the output to build/extension,
# and the "Bracemark Extension" target copies that folder into the appex.

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_ROOT="$REPO_ROOT/apps/bracemark-macos"
EXT_ROOT="$REPO_ROOT/apps/bracemark-extension"
OUT="$APP_ROOT/build"
ARCHIVE="$OUT/Bracemark.xcarchive"
APP_ID=com.bracemark.app

MODE="${1:-}"
case "$MODE" in
  staging)
    TARGET=build:staging:safari
    WXT_OUT="$EXT_ROOT/.output/safari-mv3-staging"
    ;;
  bundle)
    TARGET=build:safari
    WXT_OUT="$EXT_ROOT/.output/safari-mv3"
    ;;
  *) die "usage: macos-app.sh staging|bundle" ;;
esac

[[ -f "$APP_ROOT/Config/Local.xcconfig" ]] ||
  die "no apps/bracemark-macos/Config/Local.xcconfig — create it with one line, DEVELOPMENT_TEAM = <your team id> (the APPLE_TEAM_ID in apps/bracemark-expo/.env.local)"

step "browser extension: $TARGET"
(cd "$REPO_ROOT" && npx nx run-many -t "$TARGET" -p @stxapps/bracemark-extension --output-style=stream)
[[ -f "$WXT_OUT/manifest.json" ]] || die "no Safari build at $WXT_OUT"

# The store build must talk to production. wxt.config.ts already refuses a
# production build that doesn't; this reads the result, because it is what ships.
HOSTS="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).host_permissions.join(" ")' "$WXT_OUT/manifest.json")"
if [[ "$MODE" == bundle && "$HOSTS" != "https://api.bracemark.com/*" ]]; then
  die "the Safari build talks to '$HOSTS', not https://api.bracemark.com/* — refusing to archive it"
fi

rm -rf "$OUT/extension"
mkdir -p "$OUT"
cp -R "$WXT_OUT" "$OUT/extension"
echo "copied $(basename "$WXT_OUT") into build/extension ($HOSTS)"

cd "$APP_ROOT"

if [[ "$MODE" == staging ]]; then
  step "Debug build"
  xcodebuild -project Bracemark.xcodeproj -scheme Bracemark -configuration Debug \
    -derivedDataPath "$OUT/DerivedData" -destination 'generic/platform=macOS' build -quiet
  APP="$OUT/DerivedData/Build/Products/Debug/Bracemark.app"
  # Safari refuses an extension whose signature doesn't cover its files, and says
  # nothing: the toolbar button and the background just don't appear.
  codesign --verify --deep --strict "$APP" || die "the built app's signature is broken — see docs/browser-extension.md, _Safari_"
  step "open"
  open "$APP"
  echo "$APP"
  echo "Safari lists it under Settings → Extensions as \"Bracemark: Private Bookmarks\" (staging api)."
  exit 0
fi

command -v asc >/dev/null || die "the asc CLI is not installed (brew install asc)"

VERSION="$(xcodebuild -project Bracemark.xcodeproj -target Bracemark -configuration Release -showBuildSettings |
  sed -n 's/^ *MARKETING_VERSION = //p' | head -1)"
BUILD="$(xcodebuild -project Bracemark.xcodeproj -target Bracemark -configuration Release -showBuildSettings |
  sed -n 's/^ *CURRENT_PROJECT_VERSION = //p' | head -1)"

step "build number: $VERSION ($BUILD) against App Store Connect"
NEXT="$(asc builds next-build-number --app "$APP_ID" --version "$VERSION" --platform MAC_OS --output json |
  node -pe 'JSON.parse(require("fs").readFileSync(0)).nextBuildNumber')"
[[ "$BUILD" =~ ^[0-9]+$ && "$NEXT" =~ ^[0-9]+$ ]] ||
  die "can't compare build numbers (local '$BUILD', next on App Store Connect '$NEXT')"
((BUILD >= NEXT)) ||
  die "build $BUILD is already taken for $VERSION — set CURRENT_PROJECT_VERSION in apps/bracemark-macos/Config/Base.xcconfig to $NEXT (or higher) and rerun"
echo "ok — the next free build number for $VERSION is $NEXT"

rm -rf "$ARCHIVE"
step "archive"
asc xcode archive \
  --project Bracemark.xcodeproj \
  --scheme Bracemark \
  --configuration Release \
  --clean \
  --archive-path "$ARCHIVE" \
  --xcodebuild-flag=-destination \
  --xcodebuild-flag=generic/platform=macOS \
  --output table

step "done"
echo "$ARCHIVE — Bracemark for macOS $VERSION ($BUILD), production api"
echo "next: npm run upload"
