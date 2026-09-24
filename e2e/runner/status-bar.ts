import { type NativePlatform } from './cli';
import { adbShell, capture } from './process';

// A frozen status bar — the same clock, battery and signal in every capture —
// for the two things in e2e/ that photograph a device: the store captures
// (shot/mobile.ts) and the visual checkpoints (runner/visual-native.ts). A live
// clock is the one pixel that changes every minute on every screen.
//
// `deviceId` is a simulator udid (or `booted`) on iOS and an adb serial on
// Android, where leaving it out talks to the one attached device.

// Every SystemUI demo-mode instruction is this one broadcast plus `--es` pairs.
async function demoCommand(deviceId: string | undefined, ...extras: string[]): Promise<void> {
  const words = ['am', 'broadcast', '-a', 'com.android.systemui.demo'];
  for (let index = 0; index < extras.length; index += 2) {
    words.push('--es', extras[index], extras[index + 1]);
  }
  await adbShell(deviceId, words);
}

export async function freezeStatusBar(
  platform: NativePlatform,
  deviceId: string | undefined,
): Promise<void> {
  if (platform === 'ios') {
    // The clock renders in the device's REGION's format — `09:41` on a 24-hour
    // region. The store captures pin the region first (shot/mobile.ts,
    // SHOT_LOCALE); a visual baseline only needs the same device to agree with
    // itself, which it does either way.
    await capture('xcrun', [
      'simctl',
      'status_bar',
      deviceId ?? 'booted',
      'override',
      '--time',
      '9:41',
      '--batteryState',
      'discharging',
      '--batteryLevel',
      '100',
      '--cellularBars',
      '4',
      '--wifiBars',
      '3',
    ]);
    return;
  }

  // The same host dependency as iOS, through the emulator's own setting rather
  // than a region: SystemUI's demo clock renders `hhmm 0941` as `09:41` on a
  // device set to 24-hour time and `9:41` on one set to 12. It happens to read
  // 9:41 on the emulator these captures were taken from, which is exactly the
  // kind of accident that survives until someone else runs it. Set before demo
  // mode is entered, so the clock below is drawn with it already in force.
  await adbShell(deviceId, ['settings', 'put', 'system', 'time_12_24', '12']);
  await adbShell(deviceId, ['settings', 'put', 'global', 'sysui_demo_allowed', '1']);

  // ⚠ EXIT BEFORE ENTER, OR THIS RUN PHOTOGRAPHS THE LAST ONE'S LEAK.
  //
  // `enter` cannot repair a demo status bar that has already gone wrong:
  // IconManager.onDemoModeStarted builds its DemoStatusIcons only `if
  // (mDemoStatusIcons == null)`, so a second `enter` is a no-op — measured, it moves
  // nothing. And the container goes wrong on any CONFIGURATION CHANGE, which reaches
  // StatusBarIconControllerImpl.onDensityOrFontScaleChanged → refreshIconGroups():
  // that destroys and re-adds every icon group, and `destroy()` is only
  // `mGroup.removeAllViews()` — it leaves `mIsInDemoMode` true and the demo container
  // standing, because the container is a child of the group's PARENT. Re-adding the
  // wifi holder then reaches IconManager.addNewWifiIcon → DemoStatusIcons
  // .addModernWifiView a SECOND time; that method de-dups nothing and overwrites
  // `mModernWifiView`, so the first view is orphaned in the container, still drawn,
  // and the `onRemoveIcon` path can never reach it again. The status bar carries TWO
  // WIFI ICONS from then on, in every capture, and nothing in the run fails.
  //
  // Measured on the API 36 emulator, one extra icon per config change — a font-scale
  // write took the collapsed bar 1 → 2 → 3, the shade header with it. Demo mode
  // outlives an interrupted run (`clearStatusBar` only runs from a caller's
  // `finally`), so the count is INHERITED across runs until something exits: a fresh
  // `enter` on a dirty container is exactly the case this freeze cannot see. The
  // visual run's large-font case writes `font_scale` itself, and so freezes again
  // after every write.
  //
  // `exit` is all it takes — onDemoModeFinished → exitDemoMode removes the container,
  // nulls it and clears the flag — and it is harmless when demo mode was already off.
  // It must follow the `sysui_demo_allowed` write above: an unavailable
  // DemoModeController drops the command instead of queuing it.
  await demoCommand(deviceId, 'command', 'exit');
  await demoCommand(deviceId, 'command', 'enter');
  for (const extras of [
    ['command', 'clock', 'hhmm', '0941'],
    ['command', 'battery', 'level', '100', 'plugged', 'false'],
    ['command', 'notifications', 'visible', 'false'],
    // `fully true` is the wifi icon's inet condition: without it SystemUI paints the
    // "connected, no internet" ! badge over the bars, whatever the device's real link is.
    ['command', 'network', 'wifi', 'show', 'level', '4', 'fully', 'true'],
  ]) {
    await demoCommand(deviceId, ...extras);
  }
}

export async function clearStatusBar(
  platform: NativePlatform,
  deviceId: string | undefined,
): Promise<void> {
  if (platform === 'ios') {
    await capture('xcrun', ['simctl', 'status_bar', deviceId ?? 'booted', 'clear']);
    return;
  }
  await demoCommand(deviceId, 'command', 'exit');
}
