import { useEffect, useState } from 'react';

// A stand-in for `dexie-react-hooks`, for the popup screens that read the local
// store through `useLiveQuery`. It keeps the two properties those screens actually
// depend on — the querier RUNS, and the hook answers `undefined` until it settles —
// and drops the one they don't: liveness. Nothing in the popup decides anything
// from a re-fire, so a spec that wired up a real Dexie would be paying for an
// IndexedDB to observe the same two states.
//
// Used as `jest.mock('dexie-react-hooks', () => require('<path>/live-query'))`.
export function useLiveQuery<T>(querier: () => Promise<T>, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void Promise.resolve(querier()).then((v) => {
      if (active) setValue(v);
    });
    return () => {
      active = false;
    };
    // The querier is re-created on every render, exactly as it is in the real hook;
    // the caller's deps are the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
