#!/usr/bin/env bash
#
# Boot one of the two e2e AVDs and leave it ready to run against: the emulator
# in the foreground, and the `adb reverse` mappings set on it once it has booted.
#
#   tools/scripts/android-emulator.sh phone [--headless] [emulator options]
#   tools/scripts/android-emulator.sh tablet [--headless] [emulator options]
#
# Normally reached through the root scripts, `npm run
# expo:android:emulator:{phone,tablet}[:headless]`, each in a terminal of its
# own. ⌃C stops the emulator; so does `adb -s <serial> emu kill`.
#
# phone is `bracemark-pixel8`, tablet is `bracemark-tablet` (docs/app-drivers.md,
# the AVDs; docs/e2e.md, _narrow and wide_). Each gets a FIXED console port, so
# its serial is known before it boots — emulator-5554 for the phone,
# emulator-5556 for the tablet — and both can be up at once without anyone
# reading `adb devices` to tell them apart.
#
# --headless adds `-no-window`: a hidden emulator window is a throttled emulator
# (docs/app-drivers.md), so a run you walk away from goes on this one. `-gpu
# host` is passed either way because `-no-window` without it silently falls
# back to software rendering.
#
# THE REVERSE MAPPINGS
#
# The app reaches Metro, bracemark-api and bracemark-extractor on the host only
# through `adb reverse`, and a mapping lives in the device's adbd — every boot
# starts with none, and the e2e preflight refuses to run without them
# (e2e/runner/native-run.ts). A background job waits for `sys.boot_completed`
# and then runs the app's own `android:reverse` with ANDROID_SERIAL set to this
# emulator, so the port list stays in one place and two emulators never make a
# bare `adb reverse` choose between them. If adbd restarts later the mappings
# go with it; `npm run expo:android:reverse` (ANDROID_SERIAL in front, with
# both up) puts them back.
#
# WHY bash, AND THE EMULATOR IN THE FOREGROUND
#
# zsh renices a backgrounded job to nice 5 and macOS then schedules the emulator
# as background work (docs/app-drivers.md, BG_NICE). bash renices nothing, and
# the emulator is `exec`ed rather than backgrounded, so it keeps the terminal,
# receives ⌃C itself, and its pid is this script's — which is how the helper
# knows to give up if the emulator has gone.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# How long the helper waits for the boot before giving up. A cold boot is
# ~32 s on the M1 (docs/app-drivers.md); a first boot after a wipe is longer.
readonly BOOT_TIMEOUT_S=300

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '\033[2m%s\033[0m\n' "$*" >&2; }

usage() {
  sed -n '6,7p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 2
}

case "${1:-}" in
  phone) avd=bracemark-pixel8 port=5554 ;;
  tablet) avd=bracemark-tablet port=5556 ;;
  *) usage ;;
esac
shift

window=()
if [[ "${1:-}" == --headless ]]; then
  window=(-no-window)
  shift
fi

readonly serial="emulator-$port"

if [[ -n "${ANDROID_HOME:-}" && -x "$ANDROID_HOME/emulator/emulator" ]]; then
  emulator="$ANDROID_HOME/emulator/emulator"
else
  emulator="$(command -v emulator)" || die "no \`emulator\` on PATH and no ANDROID_HOME"
fi
command -v adb >/dev/null || die "no \`adb\` on PATH"

if adb devices | grep -q "^$serial[[:space:]]"; then
  die "$serial is already attached — $avd is up, or something else holds port $port"
fi

# Waits for this emulator's boot, then maps the ports. Exits quietly if the
# emulator (pid $$, after the exec below) goes away first.
reverse_when_booted() {
  local emulator_pid=$$ waited=0
  sleep 2
  while :; do
    kill -0 "$emulator_pid" 2>/dev/null || return 0
    if [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
      break
    fi
    if ((waited >= BOOT_TIMEOUT_S)); then
      note "android-emulator: $serial not booted after ${BOOT_TIMEOUT_S}s — no reverse mappings set; run \`ANDROID_SERIAL=$serial npm run expo:android:reverse\` once it is"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  if ANDROID_SERIAL="$serial" npm run --silent --prefix "$REPO_ROOT" expo:android:reverse >/dev/null; then
    note "android-emulator: $avd booted as $serial, reverse mappings set: $(adb -s "$serial" reverse --list | awk '{print $3}' | tr '\n' ' ')"
  else
    note "android-emulator: $serial booted but \`adb reverse\` failed; run \`ANDROID_SERIAL=$serial npm run expo:android:reverse\`"
  fi
}

reverse_when_booted &

exec "$emulator" -avd "$avd" -port "$port" -no-audio -no-boot-anim -gpu host ${window[@]+"${window[@]}"} "$@"
