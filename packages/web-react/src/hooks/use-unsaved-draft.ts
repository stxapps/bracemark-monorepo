'use client';

import { useEffect, useId } from 'react';

import { db } from '../data/db';

// Which editors on this page hold work Save hasn't written yet — so a reload the
// APP starts (the "updated, reload" pill, docs/offline-mode.md, _update policy_)
// can ask before it throws that work away. The editors already compute exactly
// this for their dirty close guard (docs/editors.md, invariant 3); they report the
// same flag here. Page-local, in memory: a draft is only ever at risk in the page
// holding it.
const dirtyEditors = new Set<string>();

export function hasUnsavedDrafts(): boolean {
  return dirtyEditors.size > 0;
}

// Report an editor's dirty flag for as long as it is mounted and dirty.
export function useUnsavedDraft(dirty: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!dirty) return;
    dirtyEditors.add(id);
    return () => {
      dirtyEditors.delete(id);
    };
  }, [id, dirty]);
}

// Resolve once every local write already started on this page has COMMITTED. A
// read-only transaction over the write edge's stores queues behind every earlier
// read-write transaction that touches them (IndexedDB orders overlapping scopes),
// so it starts only after they commit — which is what makes a reload right after a
// Save lose nothing. A closed database (update-required) has nothing to wait for.
export async function flushLocalWrites(): Promise<void> {
  try {
    await db.transaction('r', db.items, db.pendingOps, db.syncMeta, () => undefined);
  } catch {
    // Closed or unavailable: no write can still be landing.
  }
}
