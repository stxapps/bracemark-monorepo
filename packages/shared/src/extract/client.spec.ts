import { ApiError, ApiTimeoutError } from '../api/client';
import { createExtractClient } from './client';
import { FETCH_IMAGE_TIMEOUT_MS, MAX_EXTRACT_URLS } from './endpoints';

// The client binding to bracemark-extractor. `callEndpoint` already has its own spec
// (api/client.spec.ts) — what this file pins is the part that is this client's own
// judgement, none of which a type or a lint rule can catch:
//
//   - THE INLINE SPLIT. `extract` opts into `inlineImage`, `extractMany` must not:
//     the contract honors it only for a single URL, so a batch that asked for it
//     would get the flag ignored at best and N base64 blobs in one JSON body at
//     worst, defeating the streaming proxy the batch path exists to use.
//   - ANONYMITY. No bearer token ever rides these requests. Attaching one converts
//     the leak from "the server saw this URL" into "the server tied this URL to this
//     account" — the strictly-worse one the design forbids (docs/link-extraction.md,
//     _server extraction_).
//   - THE HAND-BUILT PROXY REQUEST. `fetchImage` can't ride `callEndpoint` (the
//     success body is a binary stream, not JSON), so it re-implements the URL build,
//     the front SSRF gate, the ApiError throw and the deadline. Each is a place the
//     two paths can silently drift apart.
//
// The extract CONTRACT's own schemas (endpoints.ts) are exercised here rather than in
// a spec of their own: this is where they run on a client, and the extractor's route
// specs run them on a server.

const BASE = 'https://extractor.example.test';
const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

// Duck-typed responses keep these specs free of the global Response/Headers — the
// client only reads .ok/.status/.headers.get()/.json()/.text()/.arrayBuffer().
function response(init: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
  text?: () => Promise<string>;
  retryAfter?: string | null;
}): Response {
  const { ok = true, status = ok ? 200 : 500, json, bytes, text, retryAfter = null } = init;
  return {
    ok,
    status,
    headers: { get: () => retryAfter },
    json: () => Promise.resolve(json),
    text: text ?? (() => Promise.resolve('')),
    arrayBuffer: () => Promise.resolve((bytes ?? new Uint8Array(0)).slice().buffer),
  } as unknown as Response;
}

// A fetch impl that records what the client handed it.
function recordingFetch(res: Response = response({ json: { results: [] } })) {
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
    // The request as it reaches the WIRE — an `inlineImage: undefined` the schema
    // left behind disappears here exactly as it would on the network.
    body: () => JSON.parse(String(calls[0][1].body)) as Record<string, unknown>,
  };
}

const results = (list: unknown[]) => response({ json: { results: list } });
const clientWith = (f: ReturnType<typeof recordingFetch>) =>
  createExtractClient({ baseUrl: BASE, fetch: f.fetch });

describe('extract — the interactive single save', () => {
  it('POSTs the URL to the contract path as a one-entry batch, asking for the inline image', async () => {
    // `inlineImage` is the whole reason this method is separate from a one-URL
    // extractMany: it saves the interactive save a second /v1/fetch-image round trip.
    const f = recordingFetch(results([{ url: URL_A, ok: true, title: 'A' }]));

    await clientWith(f).extract(URL_A);

    expect(f.url().origin + f.url().pathname).toBe(`${BASE}/v1/extract`);
    expect(f.init().method).toBe('POST');
    expect(f.body()).toEqual({ urls: [URL_A], inlineImage: true });
  });

  it('sends no credential of any kind — the extractor is anonymous by design', async () => {
    // A token here would tie the URL to the account. Asserting the whole header bag
    // (rather than the absence of one name) is what makes a future `authorization`,
    // `cookie` or `x-user` fail this.
    const f = recordingFetch(results([{ url: URL_A, ok: true }]));

    await clientWith(f).extract(URL_A);

    expect(f.init().headers).toEqual({ 'content-type': 'application/json' });
    expect(f.init().credentials).toBeUndefined();
  });

  it('returns that URL’s own result', async () => {
    const result = { url: URL_A, ok: true, title: 'A', imageUrl: 'https://cdn.example.com/a.png' };
    const f = recordingFetch(results([result]));

    await expect(clientWith(f).extract(URL_A)).resolves.toEqual(result);
  });

  it('returns a per-URL FAILURE as a value, not as a throw', async () => {
    // Partial success is the contract (docs/link-extraction.md — "pure function,
    // never a writer"): the caller needs `error`/`status` to reach a verdict
    // (verdictForExtractError), which a rejected promise would deny it.
    const failure = { url: URL_A, ok: false, error: 'bad_status' as const, status: 404 };
    const f = recordingFetch(results([failure]));

    await expect(clientWith(f).extract(URL_A)).resolves.toEqual(failure);
  });

  it('throws rather than handing back an undefined typed as a result', async () => {
    // `results[0]` on an empty array is `undefined` wearing the ExtractResult type.
    // Without the guard that value flows into the caller and fails somewhere else
    // entirely, as a property read on undefined.
    const f = recordingFetch(results([]));

    await expect(clientWith(f).extract(URL_A)).rejects.toThrow(/empty result/);
  });

  it('rejects a non-http(s) URL at the contract, before spending a request', async () => {
    const f = recordingFetch();

    await expect(clientWith(f).extract('javascript:alert(1)')).rejects.toThrow();
    expect(f.count()).toBe(0);
  });

  it('forwards an AbortSignal so an abandoned save can be cancelled', async () => {
    const f = recordingFetch(results([{ url: URL_A, ok: true }]));
    const controller = new AbortController();
    // Aborted up front: the fetch gets callEndpoint's own linked signal (its
    // deadline aborts it too), so the caller's abort REACHING it is the property.
    controller.abort();

    await clientWith(f).extract(URL_A, controller.signal);

    expect(f.init().signal?.aborted).toBe(true);
  });
});

describe('extractMany — the batch drain', () => {
  it('sends every URL in ONE request and does NOT ask for inline images', async () => {
    // Both halves matter and both are invisible in a diff: the single round trip is
    // the latency win the displayed-scoped / extract-all drains are built on, and the
    // absent flag is what keeps the response small (imageUrl strings, bytes later
    // through the streaming proxy).
    const f = recordingFetch(results([]));

    await clientWith(f).extractMany([URL_A, URL_B]);

    expect(f.count()).toBe(1);
    expect(f.url().origin + f.url().pathname).toBe(`${BASE}/v1/extract`);
    expect(f.body()).toEqual({ urls: [URL_A, URL_B] });
    expect(f.body()).not.toHaveProperty('inlineImage');
  });

  it('still omits inlineImage for a one-URL batch — the flag is the caller’s call, not urls.length', async () => {
    // The server would honor it here (urls.length === 1), which is exactly why this
    // has to be asserted: "interactive save" vs "bulk drain" is a distinction only
    // the CLIENT knows, and `extractMany([one])` is the drain.
    const f = recordingFetch(results([]));

    await clientWith(f).extractMany([URL_A]);

    expect(f.body()).toEqual({ urls: [URL_A] });
  });

  it('returns the results verbatim — failures kept, server order untouched', async () => {
    // The caller correlates by `result.url` (order is not guaranteed), so this must
    // not sort, filter or reshape: dropping the failures would strand those links
    // pending forever, and re-ordering would silently invite index-correlation.
    const list = [
      { url: URL_B, ok: false, error: 'timeout' as const },
      { url: URL_A, ok: true, title: 'A' },
    ];
    const f = recordingFetch(results(list));

    await expect(clientWith(f).extractMany([URL_A, URL_B])).resolves.toEqual(list);
  });

  it('refuses a batch over the fan-out cap without spending a request', async () => {
    // The abuse gate: one request may never fan out to more than MAX_EXTRACT_URLS
    // arbitrary-URL fetches. Failing at the client costs nothing; the server 400s the
    // whole request anyway, which would lose the batch's good URLs too.
    const f = recordingFetch();
    const urls = Array.from({ length: MAX_EXTRACT_URLS + 1 }, (_, i) => `https://example.com/${i}`);

    await expect(clientWith(f).extractMany(urls)).rejects.toThrow();
    expect(f.count()).toBe(0);

    // And exactly at the cap it goes through — otherwise the assertion above would
    // pass just as well against a client that refused every batch.
    const atCap = recordingFetch(results([]));
    await clientWith(atCap).extractMany(urls.slice(0, MAX_EXTRACT_URLS));
    expect(atCap.count()).toBe(1);
  });

  it('refuses an empty batch before the network', async () => {
    const f = recordingFetch();

    await expect(clientWith(f).extractMany([])).rejects.toThrow();
    expect(f.count()).toBe(0);
  });

  it('forwards an AbortSignal so a superseded drain is cancelled', async () => {
    const f = recordingFetch(results([]));
    const controller = new AbortController();
    // Aborted up front: the fetch gets callEndpoint's own linked signal (its
    // deadline aborts it too), so the caller's abort REACHING it is the property.
    controller.abort();

    await clientWith(f).extractMany([URL_A], controller.signal);

    expect(f.init().signal?.aborted).toBe(true);
  });
});

// The response half of the contract, checked where it runs on a client. A drifted or
// hostile extractor is the threat model here: whatever it answers, the client must
// not pass it on as a value its types promise it cannot be.
describe('the response, validated against the contract', () => {
  it('refuses an imageUrl that is not http(s)', async () => {
    // The one with teeth: an unvalidated `imageUrl` is handed straight back to
    // `fetchImage`, so a `data:`/`javascript:` value would ride into the proxy call.
    const f = recordingFetch(
      results([{ url: URL_A, ok: true, imageUrl: 'data:image/png;base64,x' }]),
    );

    await expect(clientWith(f).extract(URL_A)).rejects.toThrow();
  });

  it('refuses a body whose shape drifted', async () => {
    const f = recordingFetch(response({ json: { results: 'not an array' } }));

    await expect(clientWith(f).extractMany([URL_A])).rejects.toThrow();
  });

  it('throws ApiError with the status on a non-2xx extract', async () => {
    const f = recordingFetch(response({ ok: false, status: 429, retryAfter: '30' }));

    await expect(clientWith(f).extract(URL_A)).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      retryAfterSeconds: 30,
    });
  });
});

describe('fetchImage — the streaming proxy', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('POSTs the target in the body of the contract path, and no credential', async () => {
    const f = recordingFetch(response({ bytes: PNG }));

    await clientWith(f).fetchImage('https://cdn.example.com/a.png?v=2&x=1');

    expect(f.url().origin + f.url().pathname).toBe(`${BASE}/v1/fetch-image`);
    expect(f.init().method).toBe('POST');
    expect(f.body()).toEqual({ url: 'https://cdn.example.com/a.png?v=2&x=1' });
    // The whole header bag, as for extract: a future `authorization` fails this.
    expect(f.init().headers).toEqual({ 'content-type': 'application/json' });
    expect(f.init().credentials).toBeUndefined();
  });

  it('puts nothing of the target in the request URL', async () => {
    // The address is something a person saved, and a URL is what a request log, a
    // firewall event and an HTTP cache write down. This was `GET …?url=<address>`;
    // the body is the only place it may travel (endpoints.ts, fetchImageEndpoint).
    const f = recordingFetch(response({ bytes: PNG }));

    await clientWith(f).fetchImage('https://cdn.example.com/a.png?v=2&x=1');

    expect(f.url().search).toBe('');
    expect(f.url().href).toBe(`${BASE}/v1/fetch-image`);
  });

  it('lets the contract path replace a path on the baseUrl, exactly as callEndpoint does', async () => {
    // This URL is hand-built rather than built by callEndpoint, so the two can drift.
    // `new URL('/v1/fetch-image', 'https://…/api')` drops `/api` — same silent rule the
    // JSON endpoints live by (docs/api-contracts.md, "url versioning").
    const f = recordingFetch(response({ bytes: PNG }));

    await createExtractClient({ baseUrl: `${BASE}/api`, fetch: f.fetch }).fetchImage(URL_A);

    expect(f.url().pathname).toBe('/v1/fetch-image');
  });

  it('returns the raw bytes, not a parsed body', async () => {
    const f = recordingFetch(response({ bytes: PNG }));

    const bytes = await clientWith(f).fetchImage(URL_A);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
  });

  it.each([
    ['a data uri', 'data:image/png;base64,iVBORw0KGgo='],
    ['a javascript url', 'javascript:alert(1)'],
    ['an unparseable url', 'not a url'],
    ['an empty url', ''],
    ['a url past the length cap', `https://example.com/${'a'.repeat(2048)}`],
  ])('re-runs the contract’s front SSRF gate on %s, before the network', async (_name, url) => {
    // The gate `callEndpoint` runs for the JSON endpoints — a binary success body
    // can't ride that path, so this call site has to run it itself, and nothing but
    // this assertion says so.
    const f = recordingFetch();

    await expect(clientWith(f).fetchImage(url)).rejects.toThrow();
    expect(f.count()).toBe(0);
  });

  it('throws ApiError carrying the status and body on a non-2xx', async () => {
    // `instanceof ApiError` + `.status` is precisely how the caller decides an image
    // failure is permanent vs. retryable (web-react's `loadImage`): a plain Error
    // here would make every 404 look transient and retry it forever.
    const f = recordingFetch(
      response({ ok: false, status: 502, text: () => Promise.resolve('upstream refused') }),
    );

    const err = await clientWith(f)
      .fetchImage(URL_A)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, body: 'upstream refused' });
  });

  it('carries the proxy’s Retry-After hint onto the error', async () => {
    const f = recordingFetch(response({ ok: false, status: 429, retryAfter: '30' }));

    await expect(clientWith(f).fetchImage(URL_A)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  it('still reports the status when the error body cannot be read', async () => {
    const f = recordingFetch(
      response({ ok: false, status: 503, text: () => Promise.reject(new Error('stream closed')) }),
    );

    await expect(clientWith(f).fetchImage(URL_A)).rejects.toMatchObject({ status: 503, body: '' });
  });

  it('forwards an AbortSignal', async () => {
    const f = recordingFetch(response({ bytes: PNG }));
    const controller = new AbortController();
    // Aborted up front: the fetch gets the deadline's own linked signal, so the
    // caller's abort REACHING it is the property.
    controller.abort();

    await clientWith(f).fetchImage(URL_A, controller.signal);

    expect(f.init().signal?.aborted).toBe(true);
  });
});

// The proxy call can't ride `callEndpoint`, so it doesn't get that deadline for
// free — and without one a proxy that accepts the connection and never answers
// leaves the image load pending forever (a server-extraction drain slot, a favicon
// request). ApiTimeoutError, not ApiError, is also what the caller's verdict turns
// on: web-react's `loadImage` reads it as transient and leaves the facet for a retry.
describe('fetchImage — deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const pending = async (outcome: Promise<unknown>) =>
    Promise.race([outcome, Promise.resolve('pending')]);

  // A fetch whose promise is `settle`'s to decide, and — the hard case — which
  // never looks at its signal.
  function fetchOnce(settle: () => Promise<Response>) {
    let signal: AbortSignal | undefined;
    const impl = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return settle();
    }) as unknown as typeof fetch;
    return { fetch: impl, signal: () => signal };
  }

  it('rejects with ApiTimeoutError at the contract’s deadline when the proxy never answers', async () => {
    const f = fetchOnce(() => new Promise<Response>(() => undefined));
    const outcome = createExtractClient({ baseUrl: BASE, fetch: f.fetch })
      .fetchImage(URL_A)
      .catch((err: unknown) => err);

    await jest.advanceTimersByTimeAsync(FETCH_IMAGE_TIMEOUT_MS - 1);
    await expect(pending(outcome)).resolves.toBe('pending');
    expect(f.signal()?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      name: 'ApiTimeoutError',
      timeoutMs: FETCH_IMAGE_TIMEOUT_MS,
    });
    expect(f.signal()?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('covers the body too: headers that arrive, then a stream that stalls, still time out', async () => {
    // The proxy's success is a STREAM, so the headers are no evidence the bytes will
    // follow — a deadline that stopped at the headers would leave this one hanging.
    const f = fetchOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
      } as unknown as Response),
    );
    const outcome = createExtractClient({ baseUrl: BASE, fetch: f.fetch })
      .fetchImage(URL_A)
      .catch((err: unknown) => err);

    await jest.advanceTimersByTimeAsync(FETCH_IMAGE_TIMEOUT_MS);

    expect(await outcome).toBeInstanceOf(ApiTimeoutError);
  });

  it('passes an in-time image through and leaves no timer armed', async () => {
    const f = recordingFetch(response({ bytes: new Uint8Array([1, 2, 3]) }));

    const bytes = await clientWith(f).fetchImage(URL_A);

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes the proxy’s own failure through, not a timeout', async () => {
    // `loadImage` settles a non-429 4xx as permanent; masking it behind a timeout
    // would retry a dead image forever.
    const f = recordingFetch(response({ ok: false, status: 404 }));

    await expect(clientWith(f).fetchImage(URL_A)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
  });
});

describe('createExtractClient', () => {
  it('falls back to the global fetch when the app injects none', async () => {
    // bracemark-web builds this client from a baseUrl alone, so the default parameter
    // is the only fetch that path ever gets.
    const f = recordingFetch(results([{ url: URL_A, ok: true }]));
    const original = globalThis.fetch;
    globalThis.fetch = f.fetch;
    try {
      await createExtractClient({ baseUrl: BASE }).extract(URL_A);
    } finally {
      globalThis.fetch = original;
    }

    expect(f.count()).toBe(1);
  });
});
