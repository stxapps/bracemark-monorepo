'use client';

import { createSyncTraceRecorder, type SyncTraceRecorder } from '@stxapps/shared';

import { installSyncTrace } from './engine';

// The engine's timing spans, switched on for this browser by a localStorage flag
// (@stxapps/shared sync/trace.ts; docs/local-first-sync.md, _measuring a sync_).
// `measure:sync` sets the flag from an init script, before the app's code runs,
// and reads the recorder off `window` when a leg ends. By hand: set the flag,
// reload, sync, then `__bracemarkSyncTrace.summary()` in the console.
//
// A flag rather than a build, so the deployed staging app can be measured as it
// ships. Off, it costs one localStorage read per page load. The spans stay in
// memory on this page and go nowhere; paths are the only identifiers they hold.
export const SYNC_TRACE_FLAG = 'bracemark.syncTrace';

declare global {
  interface Window {
    __bracemarkSyncTrace?: SyncTraceRecorder;
  }
}

export function installSyncTraceFromFlag(): void {
  if (typeof window === 'undefined' || window.__bracemarkSyncTrace) return;
  let on = false;
  try {
    on = window.localStorage.getItem(SYNC_TRACE_FLAG) === '1';
  } catch {
    // Storage blocked: no flag to read, so no trace.
  }
  if (!on) return;
  const recorder = createSyncTraceRecorder();
  installSyncTrace(recorder);
  window.__bracemarkSyncTrace = recorder;
}
