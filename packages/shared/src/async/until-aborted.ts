// Wait for `promise`, or stop waiting as soon as `signal` aborts — whichever is
// first. Rejects with the signal's reason (or a plain Error where a runtime's
// AbortSignal carries none) and leaves `promise` running: it cancels the WAIT,
// never the work, which is the point. The sync engines' holdSyncCycles waits
// for a cycle it must not cut short, under a watchdog that belongs to its
// caller (data/delete-all-data.ts on both platforms).
//
// Where withTimeout owns its deadline, this takes a signal, so the caller can
// stop the clock at the moment the wait ends and the work begins — a deadline
// on the wait that also ran over the work would cut a five-minute server wipe
// off at two.
//
// The listener is removed when `promise` settles first, so a long-lived signal
// does not collect one closure per wait.
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// React Native's AbortController predates `abort(reason)`, so its signal can
// abort with no reason at all; a rejection with `undefined` would reach a
// caller's catch as nothing.
function abortReason(signal: AbortSignal): unknown {
  return (signal.reason as unknown) ?? new Error('Aborted');
}
