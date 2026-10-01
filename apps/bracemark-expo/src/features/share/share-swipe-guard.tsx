// Holds the SYSTEM's swipe-to-dismiss off while it is mounted — the JS half of
// `BracemarkShareSwipeGuard` (modules/bracemark-share/ios, whose header carries
// the derivation).
//
// The host presents the iOS share extension in a sheet of its own, and a
// downward drag on it belongs to that sheet: on the list and tag pickers a long
// one dismisses the whole share sheet and the unsaved share with it. Nothing in
// JS sees that gesture or can veto it, so the veto is native — the module asks
// the share extension's view controller to set `isModalInPresentation` for as
// long as this component is mounted. share-kit.tsx mounts it for the pickers
// and not for the compose screen (docs/share-sheet.md).
//
// IT RENDERS NOTHING, on purpose. The first version rendered a native view and
// that view is what killed the sheet on a real iPhone: this process runs close
// to iOS's memory limit for app extensions and an Expo native view costs more
// than the headroom (the Swift header has the numbers).
//
// OPTIONAL in the way share-keyboard.ts's module is, and for the same reasons:
// the module is iOS-only, so this does nothing in Android's share activity —
// which has no such gesture — and nothing under jest.

import { useEffect } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

type ShareSwipeGuardModule = { setHeld?: (held: boolean) => void };

const swipeGuard =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<ShareSwipeGuardModule>('BracemarkShareSwipeGuard')
    : null;

export function ShareSwipeGuard() {
  useEffect(() => {
    // `?.` twice: no module off iOS, and no `setHeld` on a dev build installed
    // before the function existed — a JS reload ahead of a native rebuild must
    // not take the picker down with a TypeError.
    swipeGuard?.setHeld?.(true);
    return () => swipeGuard?.setHeld?.(false);
  }, []);

  return null;
}
