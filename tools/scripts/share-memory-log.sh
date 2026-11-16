#!/usr/bin/env bash
#
# Pull the share sheet's `share-memory` lines off a device, as text, so a memory
# run is recorded rather than read off Console.app by eye. Reached as `npm run
# share:memory -- <ios|android> [minutes]` from apps/bracemark-expo.
# docs/share-sheet.md, _the share extension has almost no memory to spare_;
# the run itself is SHARE-IOS-MEMORY-RELEASE-001 / SHARE-ANDROID-MEMORY-001 in
# e2e/mobile/RELEASE.md.
#
#   ios [minutes]      — the attached iPhone/iPad's unified log for the last N
#                        minutes (default 15): every `share-memory` line, each
#                        memory warning, and the kernel's jetsam line if the
#                        share extension was killed. `log collect` from a device
#                        needs root, so this asks for sudo once.
#   android [minutes]  — logcat's `share-memory` tag from the attached device or
#                        emulator, for the last N minutes (default 15). Raise
#                        the ring first (`adb logcat -G 16M`): a debug shell
#                        logs enough that the default one drops a ten-lap run's
#                        first laps.
#
# Prints `time  pid  line`; the pid is what tells two shares in one reused
# process apart from two processes. The device archive iOS needs holds the whole
# device's log, so it goes to a temporary directory OUTSIDE the worktree and is
# deleted on exit — only the filtered lines leave this script.

set -euo pipefail

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

platform="${1:-}"
minutes="${2:-15}"
[[ "$minutes" =~ ^[0-9]+$ ]] || die "minutes must be a whole number, got '$minutes'"

case "$platform" in
  ios)
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/share-memory.XXXXXX")"
    trap 'sudo rm -rf "$tmp" 2>/dev/null || rm -rf "$tmp"' EXIT
    # The first device found; with two attached, unplug one.
    sudo /usr/bin/log collect --device --last "${minutes}m" --output "$tmp/device.logarchive" >/dev/null
    sudo chown -R "$(id -u)" "$tmp"
    /usr/bin/log show --archive "$tmp/device.logarchive" --style compact --info \
      --predicate '(subsystem == "com.bracemark.share" AND category == "memory")
        OR (process == "kernel" AND eventMessage CONTAINS "BracemarkShareExtension")
        OR (process == "BracemarkShareExtension" AND eventMessage CONTAINS[c] "memory warning")' |
      awk '
        # compact style: "<date> <time> <type> <process>[<pid>:<tid>] <message>"
        /share-memory|memorystatus|memory warning/ {
          time = $2; sub(/\..*/, "", time)
          pid = $4; sub(/^[^[]*\[/, "", pid); sub(/[:\]].*$/, "", pid)
          i = index($0, "share-memory"); if (i == 0) i = index($0, "memorystatus"); if (i == 0) i = index($0, "Received")
          printf "%s  %-6s %s\n", time, pid, substr($0, i)
        }'
    ;;
  android)
    command -v adb >/dev/null || die "adb not on PATH"
    since="$(date -v-"${minutes}"M '+%m-%d %H:%M:%S.000' 2>/dev/null || date -d "-${minutes} min" '+%m-%d %H:%M:%S.000')"
    adb logcat -d -v time,printable -s share-memory:I -T "$since" |
      awk '/share-memory/ {
        time = $2; sub(/\..*/, "", time)
        pid = $0; sub(/^[^(]*\( */, "", pid); sub(/\).*$/, "", pid)
        i = index($0, "share-memory "); printf "%s  %-6s %s\n", time, pid, substr($0, i)
      }'
    ;;
  *)
    die "usage: share-memory-log.sh <ios|android> [minutes]"
    ;;
esac
