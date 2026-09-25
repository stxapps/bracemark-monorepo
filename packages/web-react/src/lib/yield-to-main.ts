// Hand the main thread back to the browser for a turn — to paint the progress
// line, answer a click — before the next chunk of a long loop. What the import
// and export orchestrators await between chunks (data/import-all-data.ts,
// data/export-all-data.ts), because a library-sized loop run in one go held the
// page for 1.5–2.2 s at 50,000 links (docs/data-lifecycle.md, _main-thread
// cost_).
//
// `scheduler.yield()` where the browser has it (Chromium): the continuation
// resumes AHEAD of other queued tasks, so a yield costs a paint, not a place in
// line. Elsewhere a macrotask via `setTimeout(0)` — never a resolved promise,
// which is a microtask and would run before the browser got its turn at all.
//
// Never await this inside a Dexie transaction: a transaction commits once its
// callback stops issuing requests, and a yield is exactly such a gap. Every
// caller today is between transactions (plain reads, or around bulkWrite calls).
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
