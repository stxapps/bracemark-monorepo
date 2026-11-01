#!/usr/bin/env bash
#
# Which commit a store build came from, and the tag that records it once the
# build is released. docs/hosting.md, _which build is in a store_.
#
#   tools/scripts/store-release.sh build <store> -- <build command...>
#   tools/scripts/store-release.sh check <store>
#   tools/scripts/store-release.sh tag <store> [--yes] [--no-push]
#   tools/scripts/store-release.sh name <store>
#
# <store> is ios, android (bracemark-expo), chrome or firefox (the browser
# extension). Reached through the app-level scripts rather than by hand:
#
#   apps/bracemark-expo        ios:bundle  android:bundle    ios:tag  android:tag
#   apps/bracemark-extension   zip         zip:firefox       tag:chrome  tag:firefox
#
# WHY THERE ARE TWO STEPS
#
# A deploy can tag HEAD because it builds and ships in one run
# (tools/scripts/deploy-commit.sh). A store release cannot: the upload is a
# separate step, most of them by hand, and review takes days, so by the time a
# build is released HEAD has moved on and a tag on it would name the wrong commit.
# Nothing would say so. So `build` wraps the build and writes down what it was
# built from, and `tag` reads that, whenever it is run:
#
#   <app>/<output dir>/<store>.store-build      (gitignored)
#
#   tag=android/1.2.0-4
#   commit=<full sha>
#   built=2026-11-01T11:43:00Z
#   problem=<why this build cannot be tagged, or nothing>
#
# WHAT A TAG SAYS. <store>/<version>, plus the build number where the store has
# one (ios/1.2.0-1, android/1.2.0-4, chrome/1.2.0, firefox/1.2.0): the numbers a
# bug report, the console and Settings → About all print, read back from the
# native project or archive the build used rather than from app.config.ts. The
# tag means RELEASED, because `tag` is run after releasing, so a build a store
# rejected never gets one.
#
# WHEN A BUILD CANNOT BE TAGGED. A dirty tree or a tree that moved during the build
# is a warning at build time, because a trial build is a normal thing to want, and
# a refusal at tag time, because a tag has to name a commit that holds what shipped.
# That refusal comes after the build is live, so `check` makes the same one before
# an upload. `ios:upload` runs it; the other three uploads are by hand, so the
# warning at the end of their build is the last word.
#
# `build` also warns on release notes `npm run check:release-notes` would reject.
# A warning and not a stop: a trial build needs no notes, and a notes commit made
# after the build changes nothing that ships.
#
# The record is overwritten only by a build that succeeds, so a failed rebuild
# leaves the record of the last good one. It holds the LAST build, not the last
# upload, which is why `tag` shows the commit and asks: a rebuild under the same
# number after uploading would otherwise tag the wrong one.
#
# Requires: git, node; plutil (macOS) for ios.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage: store-release.sh build <ios|android|chrome|firefox> -- <build command...>
       store-release.sh check <ios|android|chrome|firefox>
       store-release.sh tag   <ios|android|chrome|firefox> [options]
       store-release.sh name  <ios|android|chrome|firefox>

  build   Run the build, and record the commit it came from.
  check   Fail unless the last build can be uploaded and later tagged.
  tag     Tag the recorded commit, and push the tag.
  name    Print the tag the native project or package would get now.

Options for tag:
  --yes, -y    Don't ask before creating the tag.
  --no-push    Tag, but don't push the tag to origin.
  -h, --help   Show this message.
USAGE
}

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
note() { printf '    %s\n' "$*"; }

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
[ "$#" -ge 2 ] || { usage; exit 1; }

readonly ACTION="$1"
readonly STORE="$2"
shift 2

case "$STORE" in
  ios)
    readonly APP_DIR="$REPO_ROOT/apps/bracemark-expo"
    readonly RECORD="$APP_DIR/build/$STORE.store-build"
    readonly TAG_COMMAND="ios:tag"
    ;;
  android)
    readonly APP_DIR="$REPO_ROOT/apps/bracemark-expo"
    readonly RECORD="$APP_DIR/build/$STORE.store-build"
    readonly TAG_COMMAND="android:tag"
    ;;
  chrome|firefox)
    readonly APP_DIR="$REPO_ROOT/apps/bracemark-extension"
    readonly RECORD="$APP_DIR/.output/$STORE.store-build"
    readonly TAG_COMMAND="tag:$STORE"
    ;;
  *) die "unknown store '$STORE' (expected ios, android, chrome or firefox)" ;;
esac

head_commit() { git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}'; }
tree_changes() { git -C "$REPO_ROOT" status --porcelain; }
tag_exists() { git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/tags/$1" >/dev/null; }
record_value() { sed -n "s/^$1=//p" "$RECORD"; }

# The tag this build would get, from the numbers the build itself carries.
release_tag() {
  local plist gradle version number
  case "$STORE" in
    ios)
      plist="$APP_DIR/build/Bracemark.xcarchive/Products/Applications/Bracemark.app/Info.plist"
      version="$(plutil -extract CFBundleShortVersionString raw "$plist")"
      number="$(plutil -extract CFBundleVersion raw "$plist")"
      ;;
    android)
      gradle="$APP_DIR/android/app/build.gradle"
      version="$(sed -n 's/^[[:space:]]*versionName[[:space:]]*"\([^"]*\)".*/\1/p' "$gradle")"
      number="$(sed -n 's/^[[:space:]]*versionCode[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$gradle")"
      ;;
    chrome|firefox)
      version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' \
        "$APP_DIR/package.json")"
      number=""
      ;;
  esac
  [[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || die "can't read the $STORE build's version ('$version')"
  if [ "$STORE" = ios ] || [ "$STORE" = android ]; then
    [[ "$number" =~ ^[0-9]+$ ]] || die "can't read the $STORE build's build number ('$number')"
    printf '%s/%s-%s' "$STORE" "$version" "$number"
  else
    printf '%s/%s' "$STORE" "$version"
  fi
}

# Before the record goes: a different release sitting in it, never tagged, is the
# one way the commit is lost, because this is the last place it is written down.
warn_untagged_previous() {
  local tag="$1" previous commit
  [ -f "$RECORD" ] || return 0
  previous="$(record_value tag)"
  commit="$(record_value commit)"
  [ -n "$previous" ] && [ "$previous" != "$tag" ] || return 0
  [ -z "$(record_value problem)" ] || return 0
  tag_exists "$previous" && return 0
  warn "$previous was built but never tagged, and this build replaces its record.
       If it was released, record it by hand:
       git tag $previous $commit && git push origin $previous"
}

# A warning, not a stop: see the header.
warn_release_notes() {
  local notes
  notes="$(node "$REPO_ROOT/tools/scripts/check-release-notes.mjs" 2>&1)" && return 0
  warn "the release notes need attention before this goes to a store:"
  printf '%s\n' "$notes" | sed -n '/^  /s/^  /       /p' >&2
}

run_check() {
  local recorded current problem
  [ -f "$RECORD" ] || die "no $STORE build is recorded — build it through its npm script"
  recorded="$(record_value tag)"
  problem="$(record_value problem)"
  current="$(release_tag)"
  [ "$recorded" = "$current" ] || die "the $STORE build is $current, but the record says $recorded.
       It was not made by its npm script. Build it again."
  tag_exists "$recorded" && die "$recorded already exists, so this number has been released. Bump it."
  [ -z "$problem" ] || die "refusing to send $recorded: $problem, so it could never be tagged.
       Commit, build again, and upload that build."
  return 0
}

run_build() {
  local commit changes tag problem="" built
  [ "${1:-}" = "--" ] && [ "$#" -ge 2 ] || { usage; exit 1; }
  shift

  commit="$(head_commit)" || die "$REPO_ROOT has no commit — a store build records the commit it came from"
  changes="$(tree_changes)"
  [ -z "$changes" ] || warn "the working tree is not what $commit holds, so this build can't be tagged"

  # Exits with the build's own status, leaving the last good record in place.
  "$@"

  tag="$(release_tag)"
  if [ -n "$changes" ]; then
    problem="the working tree had uncommitted changes"
  elif [ "$(head_commit)" != "$commit" ] || [ -n "$(tree_changes)" ]; then
    problem="the working tree changed during the build"
  fi

  warn_release_notes
  warn_untagged_previous "$tag"
  if tag_exists "$tag"; then
    warn "$tag already exists, so this number has been released. Bump it before uploading."
  fi

  built="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$RECORD")"
  printf 'tag=%s\ncommit=%s\nbuilt=%s\nproblem=%s\n' "$tag" "$commit" "$built" "$problem" \
    >"$RECORD.tmp"
  mv "$RECORD.tmp" "$RECORD"

  if [ -n "$problem" ]; then
    warn "$tag can't be tagged: $problem. Commit, then build again before releasing it."
  else
    note "recorded: $tag → ${commit:0:12}"
    note "once it is released: npm run $TAG_COMMAND"
  fi
}

run_tag() {
  local assume_yes=false tag commit problem built behind answer
  PUSH_TAGS=true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) assume_yes=true ;;
      --no-push) PUSH_TAGS=false ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option '$1'" ;;
    esac
    shift
  done

  [ -f "$RECORD" ] || die "no $STORE build is recorded. Only a build made after this script
       existed has a record. Rebuild, or tag a past release by hand:
       git tag <$STORE/version> <commit> && git push origin <$STORE/version>"
  tag="$(record_value tag)"
  commit="$(record_value commit)"
  problem="$(record_value problem)"
  built="$(record_value built)"
  [ -n "$tag" ] && [ -n "$commit" ] || die "$RECORD is unreadable — build again"

  tag_exists "$tag" && die "$tag already exists. Each store build gets one tag — did you mean to bump?"
  [ -z "$problem" ] || die "refusing to tag $tag: $problem. No commit holds exactly what that build
       was made from. Commit, build again, and release that build instead."
  git -C "$REPO_ROOT" merge-base --is-ancestor "$commit" HEAD 2>/dev/null \
    || die "$commit is not in this branch's history (amended or rebased?).
       Tag the commit that replaced it by hand: git tag $tag <commit>"

  behind="$(git -C "$REPO_ROOT" rev-list --count "$commit..HEAD")"
  printf '\n'
  note "$tag → $(git -C "$REPO_ROOT" log -1 --format='%h %s' "$commit")"
  note "built $built, $behind commit(s) behind HEAD"
  printf '\n'

  if [ "$assume_yes" = false ]; then
    [ -t 0 ] || die "run this in a terminal, or pass --yes if you mean it"
    printf '    Is this the build you released? A pushed tag is public and permanent. [y/N] '
    read -r answer
    [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted"
  fi

  # What deploy-commit.sh's tag_deploy and push_deploy_tags read, so a store tag
  # goes out under the same rule as a deploy tag: never ahead of its commit.
  . "$REPO_ROOT/tools/scripts/deploy-commit.sh"
  DEPLOY_TAG="$tag"
  DEPLOY_UNTAGGED=""
  DEPLOY_COMMIT="$commit"
  DEPLOY_STAMP="${commit:0:12}"
  tag_deploy
  tag_exists "$tag" || exit 1
  push_deploy_tags
}

case "$ACTION" in
  build) run_build "$@" ;;
  check) run_check ;;
  tag) run_tag "$@" ;;
  name) release_tag ;;
  *) usage; exit 1 ;;
esac
