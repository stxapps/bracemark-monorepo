import { withTimeout } from '@stxapps/shared';

// The sync a sign-out runs BEFORE it asks about unsynced changes — the bounded
// wait both hoisted flows share (@stxapps/web-ui's and bracemark-expo's
// contexts/sign-out-provider.tsx; docs/data-lifecycle.md, _the press, and the
// wait_).
//
// A sign-out erases the pending queue, and the flows used to answer a
// non-empty one with "cancel and sync first". That is advice the app can take
// itself, and from one caller the user cannot take it at all: the app-lock
// pane's "forgot the password" link signs out from behind a lock, where there
// is no sync to press and nothing to cancel back to. So the flow runs one cycle
// and reads the queue again; the question is left for what a sync could not
// save.
//
// How long that may hold a dialog open is the number below. An offline cycle
// needs none of it: fetch rejects at once and the retry policy gives up inside
// nine seconds (shared's api/retry.ts — 1 s, 2 s, 4 s, each jittered up by at
// most a quarter). The bound is for the connection that accepts a request and
// does not answer, which would otherwise hold for the client's full call
// deadline, and for a queue too large to push in one sitting. Past it the flow
// asks with whatever is still queued. The cycle is not cancelled — it cannot
// be — and whatever it pushes after that is simply no longer in the queue.
export const SIGN_OUT_SYNC_TIMEOUT_MS = 15_000;

// Settles when `syncAndWait` does or when the bound passes, whichever is first,
// and never rejects: the caller re-reads the queue either way, so how the cycle
// went is not a verdict it needs.
//
// shared's `withTimeout` supplies the race and clears its timer; the policy is
// what is left here — the bound above, and the `catch` that makes a failed cycle
// and a passed bound the same answer. Its message is required and never read.
export async function syncBeforeSignOut(
  syncAndWait: () => Promise<void>,
  timeoutMs: number = SIGN_OUT_SYNC_TIMEOUT_MS,
): Promise<void> {
  await withTimeout(
    // Through a `then` so a synchronous throw settles it too.
    Promise.resolve().then(syncAndWait),
    timeoutMs,
    'Sign-out sync timed out.',
  ).catch(() => undefined);
}
