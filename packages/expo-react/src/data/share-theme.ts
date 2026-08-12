// The theme mirror the share sheet reads (docs/theme.md, docs/share-sheet.md).
//
// The sheet renders outside the router tree — a separate PROCESS on iOS — so it
// cannot reach the preference at first hand: `theme` lives in the synced
// `settings/general.enc` and in the device-local `localSettings` row, i.e.
// behind sqlite and settings decryption, neither of which the extension may
// open (share-store's header). Left alone it followed Uniwind's adaptive
// default, so a user who pinned dark got a white sheet on a light OS — and on
// Android it was worse than wrong, it was INCONSISTENT: the share activity
// shares the app's warm React host, so a sheet opened while the app had run
// inherited the app's pinned theme, and the same sheet cold-started from the
// intent followed the OS.
//
// So the app mirrors the preference to one small file as it applies it, and the
// sheet reads that file SYNCHRONOUSLY on its first render — before first paint,
// which is the whole point: an async read paints the wrong theme and then
// flips. The same trick the taxonomy snapshot already turns (`File.textSync`),
// minus the schema, and it costs the cold-share path one ~90-byte read.
//
// THE STATE IS MIRRORED, NOT THE RESOLVED light/dark. `custom` mode's crossover
// is a function of the clock, so a sheet opened at 20:00 must read dark even if
// the app last ran at noon — mirroring `mode` + the two times and running the
// shared `resolveTheme` at open time gets that right with no timer and no
// freshness requirement. It also means this file never needs rewriting on a
// crossover, only on a real preference change.
//
// EVERY FAILURE DEGRADES TO `system`, which is exactly the behaviour this
// replaces: no file (never written, or swept by the sign-out teardown), an
// unreadable one, a JSON parse error, a shape from a build that predates a
// field — all land on DEFAULT_THEME via `coerceThemeState`, and the sheet
// follows the OS like it always did. Nothing here throws; the read is on a
// render path where a throw is a blank sheet, and the write is inside the app's
// theme effect where one would take the app tree down over a cosmetic mirror.
//
// No teardown entry of its own. On iOS the file sits under the App Group's
// `share/` subtree, which `clearShareData()` removes wholesale (by construction
// — see its header); on Android sign-out drops the `localSettings` row, so
// `useSettings` re-emits DEFAULT_THEME and the provider rewrites this file with
// it. It carries no account data either way — a mode and two clock times.

import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';

import { coerceThemeState, DEFAULT_THEME, type ThemeState } from '@stxapps/shared';

import { appGroupDir } from './app-group';

// iOS: the App Group container, the one place both processes can reach — and
// under `share/` so the sign-out sweep covers it. Android: the app's own
// document directory, since the share activity runs in the app's sandbox (and
// there is no App Group). Document storage, not cache: an OS purge would
// silently drop the user back to OS-follow.
function themeFile(): File | null {
  if (Platform.OS === 'ios') {
    const group = appGroupDir();
    return group ? new File(group, 'share/theme.json') : null;
  }
  return new File(Paths.document, 'share/theme.json');
}

// What this process last wrote, so a re-run of the provider's effect that
// carries the SAME preference doesn't touch the disk. `theme` is memoized by
// useSettings, so this is belt-and-braces rather than the main defence.
let lastWritten: string | null = null;

// Mirror the preference for the sheet. Called by the app's ThemeProvider as it
// applies the theme — the provider owns the resolved value, so mirroring from
// anywhere else would be a second reader of the same setting that could drift.
export function writeShareTheme(state: ThemeState): void {
  const json = JSON.stringify(state);
  if (json === lastWritten) return;
  try {
    const file = themeFile();
    if (!file) return;
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(json);
    lastWritten = json;
  } catch {
    // Cosmetic mirror: a failed write leaves the sheet on the previous value
    // (or on `system`), and the next preference change rewrites it.
  }
}

// The sheet's read. Synchronous by design — see the header. Returns the
// preference to resolve, never null: every failure path is DEFAULT_THEME, whose
// mode is `system`.
export function readShareTheme(): ThemeState {
  try {
    const file = themeFile();
    if (!file?.exists) return { ...DEFAULT_THEME };
    return coerceThemeState(JSON.parse(file.textSync()));
  } catch {
    return { ...DEFAULT_THEME };
  }
}
