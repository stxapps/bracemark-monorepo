// Race a promise against a deadline: resolve/reject with whatever `promise` does,
// or reject with `new Error(message)` if `timeoutMs` elapses first.
//
// The MECHANISM only. How long to wait and what to say when the wait runs out are
// the caller's policy, and they stay at the call site — sign-out's bounded sync
// (@stxapps/react lib/sync-before-sign-out.ts) keeps its number there, not here.
// A deadline that must stop partway — on a wait, before the work it guards — is
// untilAborted's job instead (./until-aborted.ts).
//
// `clearTimeout` in the `finally` is the whole reason this isn't an inline
// `Promise.race`: the winning path leaves the loser's timer armed, and a stray
// two-minute timer keeps a Node/jest event loop alive long after the run that
// created it (an "open handle" at best, a test that hangs at worst) and pins a
// closure in a React Native app that has already moved on.
//
// The loser's REJECTION needs no such handling: `Promise.race` subscribes to every
// input, so a wrapped promise that rejects after the deadline is observed — it is
// dropped, not reported as an unhandled rejection.
//
// No guard on `timeoutMs` (unlike `mapLimit`'s on `limit`, which refuses a 0 that
// would silently run nothing): every bad value here — 0, negative, NaN — makes
// `setTimeout` fire immediately, so the failure is the loud one, an error the
// caller already handles, never a deadline that silently never arrives.
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
