import { z } from '../zod';
import {
  ApiError,
  apiErrorCode,
  ApiTimeoutError,
  callEndpoint,
  createApiClient,
  DEFAULT_CALL_TIMEOUT_MS,
  parseRetryAfterSeconds,
} from './client';
import { API_V1, defineEndpoint } from './endpoint';

const BASE = 'https://api.example.test';

// Duck-typed responses keep these specs free of the global Response/Headers —
// the client only ever reads .ok/.status/.headers.get()/.json()/.text().
function response(init: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: () => Promise<string>;
  retryAfter?: string | null;
}): Response {
  const { ok = true, status = ok ? 200 : 500, json, text, retryAfter = null } = init;
  return {
    ok,
    status,
    headers: { get: () => retryAfter },
    json: () => Promise.resolve(json),
    text: text ?? (() => Promise.resolve('')),
  } as unknown as Response;
}

// A fetch impl that records what the client handed it.
function recordingFetch(res: Response = response({ json: {} })) {
  const calls: [string, RequestInit][] = [];
  const impl = ((url: string, requestInit: RequestInit) => {
    calls.push([url, requestInit]);
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return {
    fetch: impl,
    count: () => calls.length,
    url: () => new URL(calls[0][0]),
    init: () => calls[0][1],
  };
}

const getThings = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/things`,
  request: z.object({
    q: z.string().min(1),
    limit: z.number().optional(),
    all: z.boolean().default(false),
  }),
  response: z.object({ items: z.array(z.string()) }),
});

const createThing = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/things`,
  request: z.object({ name: z.string() }),
  response: z.object({ id: z.string() }),
});

const deleteThing = defineEndpoint({
  method: 'DELETE',
  path: `${API_V1}/things`,
  request: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

// How an input reaches the wire is the contract's other half: the server
// validates GET/DELETE as `query` and everything else as `json` (docs/api-contracts.md,
// "adding an endpoint"), so a client that picks the wrong carrier fails every
// request with a validation error the descriptor was supposed to make impossible.
describe('callEndpoint — request shaping', () => {
  it('sends a GET input as query params on the contract’s versioned path', async () => {
    const f = recordingFetch(response({ json: { items: [] } }));

    await callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' });

    expect(f.url().origin + f.url().pathname).toBe(`${BASE}/v1/things`);
    expect(f.init().method).toBe('GET');
    expect(f.init().body).toBeUndefined();
  });

  it('applies the contract’s defaults before sending, so the wire sees the parsed input', async () => {
    // `all` is absent from the input and defaulted by the schema; `limit` is
    // absent and optional. The defaulted one must reach the server.
    const f = recordingFetch(response({ json: { items: [] } }));

    await callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' });

    expect(Object.fromEntries(f.url().searchParams)).toEqual({ q: 'hello', all: 'false' });
  });

  it('stringifies non-string params and omits an undefined one', async () => {
    // The failure this pins is `?limit=undefined` — a string the server would
    // reject as a malformed number rather than treat as absent.
    const f = recordingFetch(response({ json: { items: [] } }));

    await callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, {
      q: 'hello',
      limit: 25,
      all: true,
    });

    expect(Object.fromEntries(f.url().searchParams)).toEqual({
      q: 'hello',
      limit: '25',
      all: 'true',
    });
  });

  it('carries a DELETE input as query params too, not as a body', async () => {
    const f = recordingFetch(response({ json: { ok: true } }));

    await callEndpoint({ baseUrl: BASE, fetch: f.fetch }, deleteThing, { id: 'x1' });

    expect(f.init().method).toBe('DELETE');
    expect(f.init().body).toBeUndefined();
    expect(f.url().searchParams.get('id')).toBe('x1');
  });

  it('sends a POST input as a JSON body with a content-type, leaving the URL bare', async () => {
    const f = recordingFetch(response({ json: { id: 'x1' } }));

    await callEndpoint({ baseUrl: BASE, fetch: f.fetch }, createThing, { name: 'a thing' });

    expect(f.init().body).toBe(JSON.stringify({ name: 'a thing' }));
    expect(f.init().headers).toEqual({ 'content-type': 'application/json' });
    expect([...f.url().searchParams]).toEqual([]);
  });

  it('validates the input against the contract BEFORE touching the network', async () => {
    // Fails fast on the same rule the server would reject, and spends no request
    // doing it — the point of typing the schema once.
    const f = recordingFetch();

    await expect(
      callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: '' }),
    ).rejects.toThrow();
    expect(f.count()).toBe(0);
  });

  it('forwards an AbortSignal so a superseded request can be cancelled', async () => {
    // The fetch gets the client's own signal (the deadline aborts it too), so what
    // is pinned is that the CALLER's abort reaches it, not the object's identity.
    // Mid-flight forwarding is under _deadline_ below.
    const f = recordingFetch(response({ json: { items: [] } }));
    const controller = new AbortController();
    controller.abort();

    await callEndpoint(
      { baseUrl: BASE, fetch: f.fetch },
      getThings,
      { q: 'hello' },
      { signal: controller.signal },
    );

    expect(f.init().signal?.aborted).toBe(true);
  });

  it('lets the contract’s leading-slash path REPLACE any path on the baseUrl', async () => {
    // `new URL('/v1/things', 'https://…/api')` discards `/api`. This is why the
    // version lives in the contract path and not in each app's baseUrl
    // (docs/api-contracts.md, "url versioning") — a baseUrl ending in `/v1`
    // would be silently dropped, and the same silence hides a stray path here.
    const f = recordingFetch(response({ json: { items: [] } }));

    await callEndpoint({ baseUrl: `${BASE}/api`, fetch: f.fetch }, getThings, { q: 'hello' });

    expect(f.url().pathname).toBe('/v1/things');
  });
});

describe('callEndpoint — responses', () => {
  it('returns the response PARSED by the contract, not the raw body', async () => {
    const f = recordingFetch(response({ json: { items: ['a'], leaked: 'server extra' } }));

    const res = await callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' });

    expect(res).toEqual({ items: ['a'] });
  });

  it('throws when a 2xx body does not match the contract', async () => {
    // A drifted server shape must surface here rather than flow into callers as
    // a value the types promise it cannot be.
    const f = recordingFetch(response({ json: { items: 'not an array' } }));

    await expect(
      callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' }),
    ).rejects.toThrow();
  });

  it('throws ApiError carrying the status and the body text on a non-2xx', async () => {
    const body = JSON.stringify({ error: 'unauthorized' });
    const f = recordingFetch(
      response({ ok: false, status: 401, text: () => Promise.resolve(body) }),
    );

    await expect(
      callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 401, body });
  });

  it('carries the server’s Retry-After hint onto the ApiError', async () => {
    // The hint is what withRetry waits instead of guessing (see retry.spec.ts);
    // dropping it here degrades every retry to blind backoff, silently.
    const f = recordingFetch(response({ ok: false, status: 429, retryAfter: '30' }));

    await expect(
      callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 30 });
  });

  it('leaves retryAfterSeconds undefined when the response sent no hint', async () => {
    const f = recordingFetch(response({ ok: false, status: 500 }));

    await expect(
      callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' }),
    ).rejects.toMatchObject({ status: 500, retryAfterSeconds: undefined });
  });

  it('still reports the status when the error body cannot be read', async () => {
    // An unreadable body (a truncated stream) must not replace the status with a
    // read error — the status is the part callers branch on.
    const f = recordingFetch(
      response({ ok: false, status: 503, text: () => Promise.reject(new Error('stream closed')) }),
    );

    await expect(
      callEndpoint({ baseUrl: BASE, fetch: f.fetch }, getThings, { q: 'hello' }),
    ).rejects.toMatchObject({ status: 503, body: '' });
  });
});

// `fetch` has no deadline of its own: a server that accepts the connection and
// never answers leaves the call pending forever, and the sync engine's
// single-flight cycle — which every later sync joins — pending with it. The
// property that matters is that every call settles, including
// when the fetch impl ignores its signal; the abort is only there to release the
// connection. Fake timers, so the deadline is reached by advancing the clock and
// the armed-timer count is readable (the leak shared's `withTimeout` guards too).
describe('callEndpoint — deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // A fetch that never settles, and — the hard case — never looks at its signal.
  function hangingFetch() {
    let signal: AbortSignal | undefined;
    const impl = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    return { fetch: impl, signal: () => signal };
  }

  it('rejects with ApiTimeoutError at the deadline even if the fetch ignores its signal', async () => {
    const f = hangingFetch();
    const outcome = callEndpoint(
      { baseUrl: BASE, fetch: f.fetch },
      getThings,
      { q: 'hello' },
      { timeoutMs: 1000 },
    ).catch((err: unknown) => err);

    // Still pending one tick short — the positive control for the assertion
    // below, which a call that failed on the spot would also satisfy.
    await jest.advanceTimersByTimeAsync(999);
    await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('pending');
    expect(f.signal()?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(ApiTimeoutError);
    expect(f.signal()?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes an in-time answer through and leaves no timer armed', async () => {
    const f = recordingFetch(response({ json: { items: ['a'] } }));

    await expect(
      callEndpoint(
        { baseUrl: BASE, fetch: f.fetch },
        getThings,
        { q: 'hello' },
        { timeoutMs: 1000 },
      ),
    ).resolves.toEqual({ items: ['a'] });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes the server’s own failure through, not a timeout', async () => {
    // A wrapper that reported its deadline in place of the real rejection would
    // hide every 429's Retry-After — and every 5xx's retry — behind a timeout.
    const f = recordingFetch(response({ ok: false, status: 429, retryAfter: '30' }));

    await expect(
      callEndpoint(
        { baseUrl: BASE, fetch: f.fetch },
        getThings,
        { q: 'hello' },
        { timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ name: 'ApiError', status: 429, retryAfterSeconds: 30 });
  });

  it('still lets the caller cancel: its abort reaches the fetch', async () => {
    const f = hangingFetch();
    const caller = new AbortController();
    const outcome = callEndpoint(
      { baseUrl: BASE, fetch: f.fetch },
      getThings,
      { q: 'hello' },
      { signal: caller.signal, timeoutMs: 1000 },
    ).catch((err: unknown) => err);
    await jest.advanceTimersByTimeAsync(0);

    caller.abort();

    expect(f.signal()?.aborted).toBe(true);
    // The fetch here ignores the abort, so the deadline still settles the call.
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBeInstanceOf(ApiTimeoutError);
  });

  // Every call is bounded without a call site asking for it — the default is
  // the point: an endpoint added later can't hang forever because nobody
  // remembered. And the two overrides are ordered: an endpoint that works long
  // server-side declares so in its contract, and a call site's own wins over both.
  it('bounds every call by default; the endpoint’s deadline beats it, the call site’s beats both', async () => {
    const slowThing = { ...getThings, timeoutMs: DEFAULT_CALL_TIMEOUT_MS * 5 };
    const deadlineOf = async (run: (f: typeof fetch) => Promise<unknown>) => {
      const outcome = run(hangingFetch().fetch).catch((err: unknown) => err);
      await jest.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS * 10);
      const err = await outcome;
      expect(err).toBeInstanceOf(ApiTimeoutError);
      return (err as ApiTimeoutError).timeoutMs;
    };

    expect(
      await deadlineOf((f) => callEndpoint({ baseUrl: BASE, fetch: f }, getThings, { q: 'a' })),
    ).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(
      await deadlineOf((f) => callEndpoint({ baseUrl: BASE, fetch: f }, slowThing, { q: 'a' })),
    ).toBe(slowThing.timeoutMs);
    expect(
      await deadlineOf((f) =>
        callEndpoint({ baseUrl: BASE, fetch: f }, slowThing, { q: 'a' }, { timeoutMs: 1000 }),
      ),
    ).toBe(1000);
  });
});

describe('createApiClient', () => {
  it('binds the baseUrl and forwards the endpoint, input and call options', async () => {
    const f = recordingFetch(response({ json: { items: ['a'] } }));
    const controller = new AbortController();
    controller.abort();
    const api = createApiClient({ baseUrl: BASE, fetch: f.fetch });

    const res = await api.call(getThings, { q: 'hello' }, { signal: controller.signal });

    expect(res).toEqual({ items: ['a'] });
    expect(f.url().origin + f.url().pathname).toBe(`${BASE}/v1/things`);
    expect(f.init().signal?.aborted).toBe(true);
  });
});

// The sync engine branches on this code to tell a CAPACITY refusal
// (`quota_exceeded`) apart from an ordinary authorization 403 it must still fail
// the cycle on — so a wrong answer here either wedges the queue or swallows a
// real error.
describe('apiErrorCode', () => {
  it('reads bracemark-api’s error code off the body', () => {
    const e = new ApiError(403, JSON.stringify({ error: 'quota_exceeded', message: 'nope' }));
    expect(apiErrorCode(e)).toBe('quota_exceeded');
  });

  it('returns null for a non-JSON body (a proxy’s HTML 403, say)', () => {
    // The case that must not be mistaken for a server verdict: an edge device
    // returning its own 403 would otherwise be read as a quota refusal and
    // silently skip the user's puts.
    expect(apiErrorCode(new ApiError(403, '<html>Forbidden</html>'))).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(apiErrorCode(new ApiError(502, ''))).toBeNull();
  });

  it('returns null when the body is JSON without a string error', () => {
    expect(apiErrorCode(new ApiError(500, JSON.stringify({ error: 42 })))).toBeNull();
    expect(apiErrorCode(new ApiError(500, JSON.stringify({})))).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    // `null` is the sharp one — reading `.error` off it THROWS, and only the
    // try/catch keeps that from escaping as a TypeError to a caller that was
    // asking a yes/no question.
    expect(apiErrorCode(new ApiError(500, 'null'))).toBeNull();
    expect(apiErrorCode(new ApiError(500, '[]'))).toBeNull();
    expect(apiErrorCode(new ApiError(500, '"quota_exceeded"'))).toBeNull();
  });

  it('returns null for anything that is not an ApiError', () => {
    expect(apiErrorCode(new Error('network down'))).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
    expect(apiErrorCode(undefined)).toBeNull();
  });
});

describe('parseRetryAfterSeconds', () => {
  // Duck-typed responses keep the test free of the global Response/Headers.
  function resWithHeader(value: string | null): Response {
    return { headers: { get: () => value } } as unknown as Response;
  }

  it('parses the delta-seconds form', () => {
    expect(parseRetryAfterSeconds(resWithHeader('60'))).toBe(60);
  });

  it('parses the HTTP-date form as a delta from now', () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfterSeconds(resWithHeader(date));
    expect(parsed).toBeGreaterThan(25);
    expect(parsed).toBeLessThanOrEqual(30);
  });

  it('reads a zero-second hint as 0, not as absent', () => {
    // "retry immediately" and "no hint" take different branches in the retry
    // policy, and a `Number(header) || undefined` shortcut would merge them.
    expect(parseRetryAfterSeconds(resWithHeader('0'))).toBe(0);
  });

  it('clamps a hint that has already elapsed to 0', () => {
    expect(parseRetryAfterSeconds(resWithHeader('-5'))).toBe(0);
    expect(parseRetryAfterSeconds(resWithHeader(new Date(Date.now() - 60_000).toUTCString()))).toBe(
      0,
    );
  });

  it('returns undefined when absent, empty or garbage', () => {
    expect(parseRetryAfterSeconds(resWithHeader(null))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWithHeader(''))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWithHeader('soon'))).toBeUndefined();
  });
});
