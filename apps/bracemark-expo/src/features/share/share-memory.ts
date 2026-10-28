// The share extension's memory, per screen, in the device's log
// (BracemarkShareMemoryModule.swift has the why). Each ShareSheet marks its
// screen as it mounts (share-kit.tsx); Console, filtered on `share-memory`,
// then reads e.g.
//
//     share-memory compose: footprint <MB> MB, available <MB> MB
//
// OPTIONAL, and a no-op wherever the module is absent — Android's share
// activity, which rides the app's own process and has no such cap, and jest.
// One registry lookup at module scope and one function call per screen: nothing
// here may cost the memory it is measuring (docs/share-sheet.md, _keep
// index.share.js lean_).

import { requireOptionalNativeModule } from 'expo-modules-core';

type ShareMemoryModule = { mark: (label: string) => void };

const shareMemory = requireOptionalNativeModule<ShareMemoryModule>('BracemarkShareMemory');

export function markShareMemory(screen: string): void {
  shareMemory?.mark(screen);
}
