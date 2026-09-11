// Explicit invalidation for writes that expo-sqlite's native change listener
// cannot observe. Its listener is backed by sqlite3_update_hook, and SQLite
// does not invoke that hook for a whole-table DELETE that takes the truncate
// optimization. Keep that fast delete path for library-sized wipes, then send
// one table-level invalidation through this tiny process-local channel.

type LiveReadInvalidationListener = (tables: readonly string[]) => void;

const listeners = new Set<LiveReadInvalidationListener>();

export function subscribeToLiveReadInvalidations(
  listener: LiveReadInvalidationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateLiveReads(tables: readonly string[]): void {
  for (const listener of listeners) listener(tables);
}
