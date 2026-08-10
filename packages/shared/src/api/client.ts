import type { z } from 'zod';

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
  const { baseUrl, fetch: fetchImpl = fetch } = options;

  // Validate against the contract before hitting the network — the client fails
  // fast on the same rules the server would reject.
  const data = endpoint.request.parse(input) as Record<string, unknown>;

  const url = new URL(endpoint.path, baseUrl);
  const init: RequestInit = { method: endpoint.method, signal: callOptions.signal };

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

// Binds a baseUrl once so call sites stay terminal: `client.call(endpoint, input)`.
export function createApiClient(options: ApiClientOptions): ApiClient {
  return {
    call: (endpoint, input, callOptions) => callEndpoint(options, endpoint, input, callOptions),
  };
}
