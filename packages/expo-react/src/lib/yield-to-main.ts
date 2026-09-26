// Hand the JS thread back for a turn — to commit the progress line, answer a
// tap — before the next chunk of a long loop. The expo sibling of web-react's
// lib/yield-to-main.ts, and what the import and export orchestrators await
// between chunks (data/import-all-data.ts, data/export-all-data.ts).
//
// A macrotask via `setTimeout(0)`. Never a resolved promise: that resumes as a
// microtask inside the same task, so nothing else gets the thread. That is
// exactly how the orchestrators ran every chunk as one block before this
// existed: they `await`ed store calls that are `async` in signature but
// synchronous inside (expo-sqlite through drizzle), and each await resumed at
// once. Hermes has no `scheduler.yield()`.
//
// The transaction callbacks are synchronous here, so a caller cannot await this
// inside one, and every caller is between transactions.
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
