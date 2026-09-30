'use client';

// The update-required signal (data/update-required.ts) as React state: false until
// a newer build takes one of this origin's databases, then true for the rest of
// this context — the signal is sticky, so it never turns back.
//
// useSyncExternalStore rather than useState + a subscribing effect: it re-reads
// the snapshot once subscribed, so a signal raised between render and subscribe
// isn't missed. The server snapshot is false — there is no database on the server.

import { useSyncExternalStore } from 'react';

import { isUpdateRequired, onUpdateRequired } from '../data/update-required';

export function useUpdateRequired(): boolean {
  return useSyncExternalStore(onUpdateRequired, isUpdateRequired, () => false);
}
