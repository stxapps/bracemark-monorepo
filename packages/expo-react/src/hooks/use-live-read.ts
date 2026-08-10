// The composite-read reactivity primitive — this platform's stand-in for
// Dexie's liveQuery (web) for reads that drizzle's own `useLiveQuery` can't
// serve: that hook subscribes ONE drizzle query builder, while the read layer's
// entry points (readLinks, readLists, use-settings' pair) each run SEVERAL
// statements and JS post-passes. So instead of tracking touched ranges, this
// re-runs the whole read whenever the underlying tables change — expo-sqlite's
// addDatabaseChangeListener (the connection opens with enableChangeListener —
// db.ts) reports every row change, coarse-grained by table.
//
// Coarseness is fine at this scale: the reads are cheap (SQLite is sync + local,
// decode is memoized via the shared decode-cache), and web's read edge already
// tolerates the same over-firing (any `items` write re-runs every querier; its
// use-links builds a content signature precisely because re-runs often return
// identical content).
//
// Contract, matching dexie-react-hooks' useLiveQuery where it matters to
// callers: `undefined` until the first read resolves, and a STALE value for one
// beat after `deps` change (the new read replaces it when it lands — use-links
// relies on exactly this to tell a stale page from a fresh one via the echoed
// page identity). A failed re-read keeps the last good value: a transient read
// error must not blank a rendered screen; the next change event retries.

import { useEffect, useState } from 'react';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { DB_NAME } from '../data/db';

export function useLiveRead<T>(
  read: () => Promise<T>,
  // Re-run keys, spread into the effect deps like dexie's useLiveQuery: the
  // caller lists what its querier closes over (query, limit, …).
  deps: readonly unknown[],
  // The tables whose changes re-run the read. Callers name what they touch
  // (e.g. ['items', 'item_tag_ids']) so an unrelated table's churn (pending_ops
  // during a sync drain) doesn't re-fire every read on screen.
  tables: readonly string[],
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Serialized re-run: one read in flight at a time; events landing meanwhile
    // set `dirty`, and the loop runs once more — so a burst (every row of a
    // sync-cycle transaction fires its own event) coalesces into at most one
    // trailing read.
    const run = async () => {
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        do {
          dirty = false;
          try {
            const result = await read();
            if (!alive) return;
            setValue(result);
          } catch {
            // Keep the last good value (see the header); the next event retries.
          }
        } while (alive && dirty);
      } finally {
        running = false;
      }
    };

    void run();

    const subscription = addDatabaseChangeListener((event) => {
      if (event.databaseName !== DB_NAME) return;
      if (!tables.includes(event.tableName)) return;
      // Defer to a macrotask so the many per-row events of one transaction
      // batch into a single re-run.
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, 0);
    });

    return () => {
      alive = false;
      subscription.remove();
      if (timer !== null) clearTimeout(timer);
    };
    // The caller-supplied keys ARE the dependency list (dexie's useLiveQuery
    // contract); `read`/`tables` identities are deliberately not tracked so
    // callers can pass inline literals without memoizing them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
