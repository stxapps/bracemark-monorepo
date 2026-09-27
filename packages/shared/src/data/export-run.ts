// The export run's shared vocabulary — what an export IS CALLED and what it
// REPORTS, not how it runs. The orchestration stays platform-bound (web-react /
// expo-react data/export-all-data.ts: the store reads, the zip library, the
// save — a streamed download on web, a cache file for the share sheet on expo),
// but both platforms offer the same formats, render the same progress phases
// and counters, and name the file the same way, so those live here rather than
// in two copies that can only agree by luck. The sibling of import-run.ts, beside
// backup.ts in the data-lifecycle namespace (docs/data-lifecycle.md).

// `bracemark` is the backup zip (backup.ts); the other three are the interop
// serializers in export/.
export type ExportFormat = 'bracemark' | 'netscape' | 'csv' | 'text';

// The running phases, in order. `sync` and `assemble` are indeterminate;
// `gather` counts link records, `files` counts blob downloads (bracemark only).
export interface ExportProgress {
  step: 'sync' | 'gather' | 'files' | 'assemble';
  done?: number;
  total?: number;
}

// The counters both platforms report. Expo's outcome extends this with the file
// it wrote (its save happens after the run); web's save happens during it.
export interface ExportOutcome {
  // Links written to the file (after the lock/Trash policy).
  linkCount: number;
  // `files/` blobs included in the zip (bracemark only; 0 otherwise).
  fileCount: number;
  // Referenced blobs that couldn't be included — deleted server-side or never
  // known locally (dangling refs). Reported, never fatal.
  missingFileCount: number;
  // The pre-export refresh failed (offline / server down); the export carried
  // on with this device's local copy. A warning, not an error — local-first.
  syncFailed: boolean;
}

// Bare media types; a caller writing text adds its own `;charset=utf-8`.
export const EXPORT_MIME: Record<ExportFormat, string> = {
  bracemark: 'application/zip',
  netscape: 'text/html',
  csv: 'text/csv',
  text: 'text/plain',
};

// Local (not UTC) YYYY-MM-DD — the date the user sees on their clock.
function datePart(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function exportFileName(format: ExportFormat, date = new Date()): string {
  const stamp = datePart(date);
  switch (format) {
    case 'bracemark':
      return `Bracemark backup ${stamp}.zip`;
    case 'netscape':
      return `Bracemark bookmarks ${stamp}.html`;
    case 'csv':
      return `Bracemark bookmarks ${stamp}.csv`;
    case 'text':
      return `Bracemark links ${stamp}.txt`;
  }
}
