import { ApiError, ApiTimeoutError } from '../api/client';
import {
  BlobNetworkError,
  BlobRequestError,
  BlobTimeoutError,
  isTransientBlobStatus,
} from './blob-transfer';

// Retrying a sync that failed, above the request: which failures a retry can
// fix, and when to try. docs/local-first-sync.md, _retrying a failure_, has the
// four layers and the table of cases this encodes; in short —
//
//   L1  the request, in place      blob-transfer.ts, api/retry.ts
//   L2  a second pass, in the cycle `isSecondPassFailure`, both engines
//   L3  a scheduled cycle          `createSyncRetryScheduler`, both providers
//   L4  the person                 Retry, Sync now, the gate's button
//
// Platform-free, like the rest of `sync/`: the engines and providers that use it
// are web's and expo's siblings, and what a failure MEANS must not drift between
// them.

// What a cycle left behind that no transfer threw for: a path its sign did not
// answer, or a put its commit refused as `no_object`, still queued after the
// second pass. Each used to leave the cycle reporting a clean 'idle' over an
// unpushed edit — nothing for anyone to notice, and no retry but the next edit.
// Now it fails the cycle, transiently, and the timer takes it.
export class SyncIncompleteError extends Error {
  constructor(readonly count: number) {
    super(`${count} ${count === 1 ? 'change' : 'changes'} didn’t sync — sync will try again`);
    this.name = 'SyncIncompleteError';
  }
}

// A cycle that failed for a reason that may clear by itself: worth a timer (L3).
// Everything else waits for a write, a press or a launch, with its error on
// screen — a retry would fail the same way:
//   - a 401 (the session is gone; sync pauses — docs/sessions.md) and any other
//     non-429 4xx from the api: refused on its merits, or a contract one side
//     lacks. A `quota_exceeded` never gets here; the engines turn it into a
//     settled `blocked` outcome.
//   - a blob that will not open in a way the engines do not skip — an unknown
//     format version, which an update fixes.
//   - a local store error, or the account signed out under the cycle.
//
// A TypeError counts as transient because it is what fetch rejects with when
// the transport fails, from the api client on both platforms and from a web
// blob transfer. A bug that throws one gets a backoff that tops out at 30 min,
// with its message on screen the whole time — the same bargain api/retry.ts
// makes for L1.
export function isTransientSyncFailure(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  if (err instanceof ApiTimeoutError) return true;
  if (err instanceof BlobRequestError)
    return err.status === 403 || isTransientBlobStatus(err.status);
  if (err instanceof BlobTimeoutError || err instanceof BlobNetworkError) return true;
  if (err instanceof SyncIncompleteError) return true;
  return err instanceof TypeError;
}

// A transfer failure the cycle's own second pass can fix (L2): run once more,
// freshly signed, after the rest of its set has moved. Narrower than the timer's
// test — an api call's failure is not here, because withRetry already spent L1
// on it and the set has no second pass for a sign or a commit.
//   - a 5xx, a 429 or a dropped connection that outlived L1's tries;
//   - a deadline, which L1 never retries: by the time the set has moved, a stall
//     that is still on has had that long to clear;
//   - a 403, an expired token — L1 would send the same one.
// A browser's TypeError is the web engine's to add, as for L1.
export function isSecondPassFailure(err: unknown): boolean {
  if (err instanceof BlobRequestError)
    return err.status === 403 || isTransientBlobStatus(err.status);
  return err instanceof BlobTimeoutError || err instanceof BlobNetworkError;
}

// STOP FEEDING AN OUTAGE. Once this many of a set's transfers have spent their
// L1 tries, the set starts no more, skips its second pass, and fails the cycle
// into the timer. Without it an offline 10,000-link push would send every
// remaining PUT to fail on its own. A short burst — 35–63 PUTs dropped within a
// second on staging, which their L1 retries recovered — never reaches it, since
// a transfer counts only once its retries are spent.
export const SET_OUTAGE_FAILURES = 20;

// L3's schedule: the wait before each retry after a cycle that failed
// transiently, the last one repeating. The first step is short because the
// commonest cause — an R2 refusal, a dropped connection, a stalled call — has
// usually cleared; the tail is long because the one that has not is an outage
// (the Durable Object's free-tier write limit answered `500`s for hours on
// staging), and a device should not spend its battery or the server's limits on
// it.
export const SYNC_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

// The blocking first sync's schedule: three short retries behind a "Retrying…"
// line, then the gate's button. Short because a person is watching, and cheap
// because a first sync resumes rather than restarts.
export const INITIAL_SYNC_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];

// Every scheduled wait moves by up to this fraction either way, so devices and
// tabs that failed together do not retry together.
export const SYNC_RETRY_JITTER = 0.25;

// Coming back online or to the app starts a pending retry at once, but no more
// often than this: a tab flicked back and forth, or a flapping connection, would
// otherwise start a cycle per event.
export const SYNC_WAKE_MIN_INTERVAL_MS = 30_000;

export function jitteredSyncDelayMs(baseMs: number, random: () => number = Math.random): number {
  return Math.round(baseMs * (1 - SYNC_RETRY_JITTER + 2 * SYNC_RETRY_JITTER * random()));
}

export interface SyncRetryScheduler {
  // Follow a cycle to its end: a clean one resets the backoff and drops any
  // pending retry; a transient failure schedules the next step; any other
  // failure drops the retry and waits for a person. Coalesced callers share one
  // cycle promise, so a promise already watched is not counted twice.
  watch(cycle: Promise<unknown>): void;
  // The device came back online, or the person came back to the tab or app:
  // start the pending retry now, if there is one and the last wake-up was long
  // enough ago. Nothing pending, nothing started — a wake-up is not a schedule.
  wake(): void;
  // Whether a retry is scheduled.
  readonly pending: boolean;
  // Stop for good: the account, the session or the provider went away.
  dispose(): void;
}

export interface SyncRetrySchedulerOptions {
  // Start a cycle. The provider's own runner, which watches what it starts.
  run: () => void;
  // Test seams.
  now?: () => number;
  random?: () => number;
  setTimer?: (fire: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

// L3: one timer per provider, in the tab or app whose cycle failed. Another
// tab's cycle takes the same Web Lock, so a cycle it runs meanwhile drains the
// same queue, and this tab's retry then finds little left.
export function createSyncRetryScheduler(options: SyncRetrySchedulerOptions): SyncRetryScheduler {
  const { run, now = Date.now, random = Math.random } = options;
  const setTimer = options.setTimer ?? ((fire, ms) => setTimeout(fire, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let step = 0;
  let timer: unknown;
  let lastWake = -Infinity;
  let disposed = false;
  const watched = new WeakSet<Promise<unknown>>();

  const cancel = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };
  const fire = (): void => {
    timer = undefined;
    if (!disposed) run();
  };
  const succeeded = (): void => {
    cancel();
    step = 0;
  };
  const failed = (err: unknown): void => {
    cancel();
    if (disposed) return;
    if (!isTransientSyncFailure(err)) {
      step = 0;
      return;
    }
    const base = SYNC_RETRY_DELAYS_MS[Math.min(step, SYNC_RETRY_DELAYS_MS.length - 1)];
    step += 1;
    timer = setTimer(fire, jitteredSyncDelayMs(base, random));
  };

  return {
    watch(cycle) {
      if (watched.has(cycle)) return;
      watched.add(cycle);
      cycle.then(succeeded, failed);
    },
    wake() {
      if (disposed || timer === undefined) return;
      const at = now();
      if (at - lastWake < SYNC_WAKE_MIN_INTERVAL_MS) return;
      lastWake = at;
      cancel();
      run();
    },
    get pending() {
      return timer !== undefined;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

export interface InitialSyncRetryOptions {
  // Called before each wait, with the retry it is waiting for (1, 2, 3).
  onRetry: (retry: number) => void;
  sleep: (ms: number) => Promise<void>;
  // Checked after each wait: false stops without another attempt, and resolves.
  // The caller's own state says it was abandoned.
  stillWanted: () => boolean;
  random?: () => number;
}

// Run the blocking first sync, and run it again on a transient failure, on
// INITIAL_SYNC_RETRY_DELAYS_MS. A first sync resumes rather than restarts (the
// staleness skip in each engine's startPull), so each retry costs only what is
// left. Rejects with the last failure once the schedule is spent, or at once
// with one no retry can fix — the gate's button is what remains.
export async function runInitialSyncWithRetries(
  attempt: () => Promise<void>,
  options: InitialSyncRetryOptions,
): Promise<void> {
  const { onRetry, sleep, stillWanted, random } = options;
  for (let retry = 0; ; retry++) {
    try {
      await attempt();
      return;
    } catch (err) {
      if (retry >= INITIAL_SYNC_RETRY_DELAYS_MS.length || !isTransientSyncFailure(err)) throw err;
      onRetry(retry + 1);
      await sleep(jitteredSyncDelayMs(INITIAL_SYNC_RETRY_DELAYS_MS[retry], random));
      if (!stillWanted()) return;
    }
  }
}
