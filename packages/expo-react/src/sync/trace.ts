import {
  createSyncTraceRecorder,
  formatSyncTraceSummary,
  type SyncTraceRecorder,
} from '@stxapps/shared';

import { installSyncTrace } from './engine';

// The sync engine's timing spans on bracemark-expo (@stxapps/shared
// sync/trace.ts; docs/local-first-sync.md, _measuring a sync_). Web's are read off
// the page by `measure:sync`; a device has no page to read, so each cycle prints
// its own table when its `cycle` span lands — to Metro's terminal on a debug
// build, to `adb logcat -s ReactNativeJS` / the simulator's log otherwise, tagged
// `[sync-trace]` so it greps out of either.
//
// OFF unless the app starts it, and the app starts it only in a bundle built with
// EXPO_PUBLIC_SYNC_TRACE=1 — set in Metro's environment for a measuring run,
// never in an env file (docs/env-files.md). A shipped build never records.

declare global {
  var __bracemarkSyncTrace: SyncTraceRecorder | undefined;
}

export function startSyncTrace(): void {
  if (globalThis.__bracemarkSyncTrace) return;
  const recorder: SyncTraceRecorder = createSyncTraceRecorder({
    onRecord: (span) => {
      if (span.name !== 'cycle') return;
      const rows = recorder.summary({ since: span.start, until: span.end });
      const seconds = ((span.end - span.start) / 1000).toFixed(1);
      const kind = span.attrs?.kind ?? 'cycle';
      const failed = span.failed ? `, failed (${span.failed})` : '';
      console.log(
        `[sync-trace] ${kind} cycle, ${seconds} s${failed}\n${formatSyncTraceSummary(rows)}`,
      );
    },
  });
  installSyncTrace(recorder);
  globalThis.__bracemarkSyncTrace = recorder;
}
