// The share sheet's memory, per screen, in the device's log
// (BracemarkShareMemoryModule.swift / .kt have the why). Each ShareSheet marks its
// screen as it mounts (share-kit.tsx); the log, filtered on `share-memory`, then
// reads e.g. (iOS)
//
//     share-memory compose#3: footprint 31.6 MB, available 88.4 MB, js 6.1/12.0 MB, js-ext 1.2 MB, gcs 9, age 7.2 s
//
// — `#3` is the third time this screen mounted in this sheet, so laps read off
// the log without counting; `js` is the Hermes heap (live+garbage / reserved),
// `js-ext` the malloc its objects hold outside it. Android's line has the same
// tail after its own process numbers (PSS, Java and native heaps). The read-mode
// copy's size is not here: the sheet never holds it — the controller's own
// `copy-file` line logs it as it writes the file (ShareViewController.swift).
//
// The JS numbers are what split a growing footprint in two: a JS heap that grows
// in step points at what the sheet's JS keeps; a flat one points at native —
// Fabric's views, text layout, images (docs/share-sheet.md, _the share extension
// has almost no memory to spare_).
//
// OPTIONAL, and a no-op wherever the module is absent (jest). One registry lookup
// at module scope and one function call per screen: nothing here may cost the
// memory it is measuring (docs/share-sheet.md, _keep index.share.js lean_).
// NUMBERS ONLY reach the native side — the stats are a map of numbers under fixed
// keys, and the label is one of the sheet's own constants. No URL, no title.

import { requireOptionalNativeModule } from 'expo-modules-core';

type ShareMemoryStats = Record<string, number>;
type ShareMemoryModule = { mark: (label: string, stats: ShareMemoryStats) => void };

const shareMemory = requireOptionalNativeModule<ShareMemoryModule>('BracemarkShareMemory');

// Hermes's own counters, in every build (release included). Absent under jest
// and any other engine, where the line simply goes without them.
type HermesStats = {
  js_allocatedBytes?: number;
  js_heapSize?: number;
  js_mallocSizeEstimate?: number;
  js_numGCs?: number;
};
declare const HermesInternal: { getInstrumentedStats?: () => HermesStats } | undefined;

// Per sheet, not per process: Android's share root rides the app's process and
// bundle, so module state outlives a sheet there. `beginShareMemory` resets it.
const mounts = new Map<string, number>();

// Called once per sheet, from the share root's first render.
export function beginShareMemory(): void {
  mounts.clear();
}

export function markShareMemory(label: string): void {
  if (!shareMemory) return;
  const n = (mounts.get(label) ?? 0) + 1;
  mounts.set(label, n);

  const stats: ShareMemoryStats = {};
  const hermes =
    typeof HermesInternal !== 'undefined' ? HermesInternal?.getInstrumentedStats?.() : undefined;
  if (hermes) {
    if (typeof hermes.js_allocatedBytes === 'number') stats.jsAllocated = hermes.js_allocatedBytes;
    if (typeof hermes.js_heapSize === 'number') stats.jsHeap = hermes.js_heapSize;
    if (typeof hermes.js_mallocSizeEstimate === 'number')
      stats.jsMalloc = hermes.js_mallocSizeEstimate;
    if (typeof hermes.js_numGCs === 'number') stats.gcs = hermes.js_numGCs;
  }

  shareMemory.mark(`${label}#${n}`, stats);
}
