import type { z } from 'zod';

import { withDeadline } from '../async/with-deadline';
import type { ApiEndpoint, HttpMethod } from './endpoint';

// Platform-agnostic typed fetch driven by the shared endpoint contracts. Lives
// in `shared` (not `react`) because it's framework-free and the future
// bracemark-expo client needs it too — it relies only on the global `fetch`/`URL`,
// available in browsers, RN, and Node 18+. Each app supplies its own `baseUrl`
// (and, in tests, a `fetch` impl) via createApiClient.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    /** Server's `Retry-After` hint in seconds (a 429/503 may carry one) — lets a
     *  retrying caller wait the window out instead of guessing. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

// bracemark-api's stable, client-parseable error code (`{ "error": "<code>" }` —
// see its lib/errors.ts) off a thrown ApiError. Null for anything that isn't one
// of ours, so a caller branching on a code can never mistake a proxy's HTML 403
// or a network failure for a server verdict.
//
// This exists so callers branch on the CODE rather than the status: the quota
// gate answers 403 `quota_exceeded` for an account at its storage ceiling, and
// the sync engine has to tell that apart from an ordinary authorization 403 it
// must still fail the cycle on — the two are indistinguishable by status alone.
export function apiErrorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  try {
    const body = JSON.parse(e.body) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

// Every call has a deadline. `fetch` has none of its own, so a server that
// accepts the connection and never answers — or a network that silently drops
// the packets — leaves a call pending forever, and a pending call in the sync
// engine's single-flight cycle takes all of sync down with it, not one screen.
// A default rather than per-call-site wiring, so an endpoint added later is
// bounded without anyone remembering to: the wrong guess is then a loud
// ApiTimeoutError, never a silent hang. 60 s is generous for a JSON API whose
// bodies are small; an endpoint that legitimately works longer before answering
// declares its own `timeoutMs` in its contract (delete-all pages the whole R2
// prefix server-side). docs/api-contracts.md, _deadlines_. The delete-all
// flow's sync-wait watchdog is derived from it (data/delete-all-data.ts on both
// platforms), so moving this moves that.
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

// A call that outlived its deadline. Its own class (not an
// ApiError — there is no status, the server never answered — and not the
// fetch's TypeError) so the retry policy can tell it apart from a network blip:
// see `isRetryableTransportError` in retry.ts for why a timeout is not retried.
export class ApiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'ApiTimeoutError';
  }
}

// `Retry-After` from an error response, in seconds. Handles both header forms
// (delta-seconds and HTTP-date); undefined when absent or unparseable.
export function parseRetryAfterSeconds(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, (date - Date.now()) / 1000);
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Override the global fetch (e.g. in tests, or to inject auth headers). */
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** Abort the request — TanStack Query passes its query `signal` here so a
   *  superseded request (e.g. a stale debounced username) is cancelled. */
  signal?: AbortSignal;
  /** Override this call's deadline in ms (else the endpoint's `timeoutMs`, else
   *  `DEFAULT_CALL_TIMEOUT_MS`). When it passes, the call rejects with
   *  ApiTimeoutError and the fetch is aborted. Covers the whole call, the
   *  response body included. */
  timeoutMs?: number;
}

// GET/DELETE carry their input as query params; everything else as a JSON body.
function isQueryMethod(method: HttpMethod): boolean {
  return method === 'GET' || method === 'DELETE';
}

export async function callEndpoint<
  TMethod extends HttpMethod,
  TPath extends string,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
>(
  options: ApiClientOptions,
  endpoint: ApiEndpoint<TMethod, TPath, TRequest, TResponse>,
  input: z.input<TRequest>,
  callOptions: CallOptions = {},
): Promise<z.infer<TResponse>> {
  const timeoutMs = callOptions.timeoutMs ?? endpoint.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return withDeadline(
    (signal) => send(options, endpoint, input, signal),
    timeoutMs,
    (ms) => new ApiTimeoutError(ms),
    callOptions.signal,
  );
}

async function send<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  options: ApiClientOptions,
  endpoint: ApiEndpoint<HttpMethod, string, TRequest, TResponse>,
  input: z.input<TRequest>,
  signal: AbortSignal | undefined,
): Promise<z.infer<TResponse>> {
  const { baseUrl, fetch: fetchImpl = fetch } = options;

  // Validate against the contract before hitting the network — the client fails
  // fast on the same rules the server would reject.
  const data = endpoint.request.parse(input) as Record<string, unknown>;

  const url = new URL(endpoint.path, baseUrl);
  const init: RequestInit = { method: endpoint.method, signal };

  if (isQueryMethod(endpoint.method)) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  } else {
    init.body = JSON.stringify(data);
    init.headers = { 'content-type': 'application/json' };
  }

  const res = await fetchImpl(url.toString(), init);
  if (!res.ok) {
    throw new ApiError(res.status, await res.text().catch(() => ''), parseRetryAfterSeconds(res));
  }

  return endpoint.response.parse(await res.json());
}

export interface ApiClient {
  call<
    TMethod extends HttpMethod,
    TPath extends string,
    TRequest extends z.ZodType,
    TResponse extends z.ZodType,
  >(
    endpoint: ApiEndpoint<TMethod, TPath, TRequest, TResponse>,
    input: z.input<TRequest>,
    callOptions?: CallOptions,
  ): Promise<z.infer<TResponse>>;
}

// What a bound client needs of a session record (both stacks' `SessionRecord`
// carry it): the token it sends, and the generation a verdict on it is tagged with.
export interface BoundSession {
  token: string;
  generation: string;
}

// The client each platform's `createAuthApiClient` returns: the ordinary client,
// which reads the module session per request, plus a way to pin one record's
// token for a run of requests made with that record's key (docs/sessions.md,
// _one record per run_).
export interface AuthApiClient extends ApiClient {
  // A client that sends THIS record's token on every request, whatever the
  // module session becomes in the meantime.
  withSession(session: BoundSession): ApiClient;
}

// Binds a baseUrl once so call sites stay terminal: `client.call(endpoint, input)`.
export function createApiClient(options: ApiClientOptions): ApiClient {
  return {
    call: (endpoint, input, callOptions) => callEndpoint(options, endpoint, input, callOptions),
  };
}
