import { type ApiClient, ApiError, type CallOptions } from './client';

// Transport-level retry for the contract client — the client half of the servers'
// per-IP/per-user rate limits (middleware/rate-limit.ts in bracemark-api and
// bracemark-extractor). The limits are shared buckets (tabs, devices, NATed users), so
// a client can never compute its remaining budget up front; reactive
// 429-check-and-wait is the required half, with the callers' natural pacing
// (sequential chunks, small pools) as the proactive half. Lives in `shared` beside
// the client it wraps so every app (web, extension, future expo) retries by
// identical rules.

// Is a thrown transport error worth retrying — might a later attempt succeed?
// RETRYABLE: a 429 (a shared rate-limit bucket that will refill), a 5xx, or a
// network error (fetch rejects with a TypeError — offline, DNS, CORS blip). NOT
// retryable: a non-429 4xx (the server rejected the request on its merits — it
// won't change on retry) or any non-transport throw (a bug should surface, not
// spin). An abort surfaces as a DOMException, so a cancelled call is never retried.
export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError;
}

// The server's Retry-After hint carried by a thrown error, in ms — or undefined
// when the error has none (network error, hintless 5xx). Callers prefer this over
// their own guessed backoff: the servers send the rate-limit window's full period,
// so waiting it out is the earliest retry guaranteed a fresh bucket.
export function retryAfterMsOf(err: unknown): number | undefined {
  if (err instanceof ApiError && err.retryAfterSeconds !== undefined) {
    return err.retryAfterSeconds * 1000;
  }
  return undefined;
}

// Upward jitter: [base, base * 1.25). Never earlier than `base` — a Retry-After
// hint is a floor, not a target — while still de-synchronizing parallel clients
// (tabs/devices behind one bucket) so they don't retry in lockstep and re-collide.
export function jitteredDelayMs(baseMs: number): number {
  return Math.round(baseMs * (1 + Math.random() * 0.25));
}

export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  tries?: number;
  /** First backoff delay when the server sent no Retry-After (default 1s). */
  baseDelayMs?: number;
  /** Ceiling on any single wait, hinted or not (default 60s). */
  maxDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Wrap an ApiClient so every call retries retryable transport failures with
// backoff: wait the server's Retry-After when the error carries one, else
// exponential (base × 2^attempt), both jittered upward and capped. Non-retryable
// errors and the final attempt's failure propagate unchanged, so callers'
// error handling sees the same ApiError they always did.
export function withRetry(api: ApiClient, options: RetryOptions = {}): ApiClient {
  const { tries = 4, baseDelayMs = 1_000, maxDelayMs = 60_000, sleep = defaultSleep } = options;

  return {
    call: async (endpoint, input, callOptions?: CallOptions) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await api.call(endpoint, input, callOptions);
        } catch (err) {
          if (attempt >= tries - 1 || !isRetryableTransportError(err)) throw err;
          // A caller-side abort mid-flight can surface as a retryable-looking
          // failure; a superseded request must not be revived.
          if (callOptions?.signal?.aborted) throw err;

          const hintMs = retryAfterMsOf(err);
          const backoffMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
          const baseMs = hintMs !== undefined ? Math.min(hintMs, maxDelayMs) : backoffMs;
          await sleep(jitteredDelayMs(baseMs));
        }
      }
    },
  };
}
