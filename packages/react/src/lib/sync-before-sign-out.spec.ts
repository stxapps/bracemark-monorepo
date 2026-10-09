import { SIGN_OUT_SYNC_TIMEOUT_MS, syncBeforeSignOut } from './sync-before-sign-out';

// The wait a sign-out spends on a sync before it asks about unsynced changes. Both
// hoisted flows await this and then re-read the queue, so the one thing it owes them is
// to SETTLE: a wait that hangs is a dialog with a spinner and no question, in front of
// a user whose only way out of a forgotten app lock is this sign-out — and a wait that
// rejects is an unhandled rejection in a flow that then shows nothing at all.

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// Resolved or still out, read without waiting on it.
async function settled(wait: Promise<void>): Promise<boolean> {
  let done = false;
  void wait.then(() => {
    done = true;
  });
  await jest.advanceTimersByTimeAsync(0);
  return done;
}

it('settles as soon as the cycle does', async () => {
  const wait = syncBeforeSignOut(() => Promise.resolve());

  expect(await settled(wait)).toBe(true);
  // The bound is not left running behind a sync that has already answered.
  expect(jest.getTimerCount()).toBe(0);
});

// A failed cycle is the ordinary case here — offline is why the queue is not empty.
it('settles on a cycle that failed, without rejecting', async () => {
  const wait = syncBeforeSignOut(() => Promise.reject(new Error('offline')));

  await expect(wait).resolves.toBeUndefined();
});

it('settles on a cycle that throws before it returns a promise', async () => {
  const wait = syncBeforeSignOut(() => {
    throw new Error('no provider');
  });

  await expect(wait).resolves.toBeUndefined();
});

// The connection that accepts a request and never answers: the cycle is still out, and
// the flow goes on to ask with whatever is still queued.
it('stops waiting at the bound when the cycle never answers', async () => {
  const wait = syncBeforeSignOut(() => new Promise<void>(() => undefined));

  await jest.advanceTimersByTimeAsync(SIGN_OUT_SYNC_TIMEOUT_MS - 1);
  expect(await settled(wait)).toBe(false);

  await jest.advanceTimersByTimeAsync(1);
  expect(await settled(wait)).toBe(true);
});
