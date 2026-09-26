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
//
// During a bulk write (holdLiveReads, data/live-read-invalidation.ts) a change
// only marks the read as having missed one, and the hold's next flush re-runs
// it. The first read and a deps change are never held: a screen that mounts
// mid-import must not sit blank until the import ends.
//
// Under a paused LiveReadPause (contexts/live-read-pause.tsx), which marks a
// screen nobody can see, a change is noted the same way. A hold flush skips a
// paused read, and the read re-runs when the pause lifts.

import { useEffect, useRef, useState } from 'react';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { useLiveReadPaused } from '../contexts/live-read-pause';
import { DB_NAME } from '../data/db';
import {
  liveReadsHeld,
  subscribeToHeldFlushes,
  subscribeToLiveReadInvalidations,
} from '../data/live-read-invalidation';

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
  const paused = useLiveReadPaused();
  // Read by the listeners, which outlive the render that set it.
  const pausedRef = useRef(paused);
  // The current effect's `resume`, for the pause effect below to call.
  const resumeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    let running = false;
    let dirty = false;
    // A change that landed while live reads were held or paused (see the header).
    let missed = false;
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

    const scheduleRun = () => {
      // Defer to a macrotask so the many per-row events of one transaction,
      // or one explicit multi-table invalidation, batch into a single re-run.
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, 0);
    };

    const onChange = () => {
      if (liveReadsHeld() || pausedRef.current) {
        missed = true;
        return;
      }
      scheduleRun();
    };
    // Re-run a read that missed a change: on a hold's flush, which fires while the
    // hold is still taken, and when the pause lifts, even mid-hold, because the
    // screen is being revealed. Never while paused.
    const resume = () => {
      if (!missed || pausedRef.current) return;
      missed = false;
      scheduleRun();
    };
    resumeRef.current = resume;

    const subscription = addDatabaseChangeListener((event) => {
      // `databaseName` is SQLite's attached-schema name (`main` for the
      // connection opened in db.ts), NOT the database filename. Filtering that
      // field against DB_NAME drops every real native event. The absolute file
      // path is the event field that identifies which open database changed.
      if (!event.databaseFilePath.endsWith(`/${DB_NAME}`)) return;
      if (!tables.includes(event.tableName)) return;
      onChange();
    });
    // sqlite3_update_hook deliberately skips whole-table deletes that SQLite
    // services with its truncate optimization. Those writers explicitly
    // invalidate here after committing rather than forcing a potentially huge
    // library wipe through the slower row-by-row delete path.
    const unsubscribeFromExplicitInvalidations = subscribeToLiveReadInvalidations(
      (changedTables) => {
        if (changedTables.some((table) => tables.includes(table))) onChange();
      },
    );
    const unsubscribeFromHeldFlushes = subscribeToHeldFlushes(resume);

    return () => {
      alive = false;
      subscription.remove();
      unsubscribeFromExplicitInvalidations();
      unsubscribeFromHeldFlushes();
      if (resumeRef.current === resume) resumeRef.current = null;
      if (timer !== null) clearTimeout(timer);
    };
    // The caller-supplied keys ARE the dependency list (dexie's useLiveQuery
    // contract); `read`/`tables` identities are deliberately not tracked so
    // callers can pass inline literals without memoizing them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) resumeRef.current?.();
  }, [paused]);

  return value;
}
