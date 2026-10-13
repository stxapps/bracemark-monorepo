import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXTRACT_TIMEOUT_MS, FETCH_IMAGE_TIMEOUT_MS } from '@stxapps/shared';

import {
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  readAllWithLimit,
  readCappedBytes,
  safeFetch,
  SafeFetchError,
  streamWithLimit,
} from './safe-fetch';

// safeFetch is the single funnel every arbitrary-URL fetch goes through, so the
// caps and the SSRF re-validation are asserted here rather than once per route.
// The REDIRECT cases are the load-bearing ones: docs/link-extraction.md calls
// per-hop re-validation "the guard's teeth" — a public URL that 30x's into
// private space is the bypass a host-only check misses, and it is invisible to
// ssrf.spec.ts (which only ever sees the initial URL).

function stubFetch(impl: (url: string) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const redirectTo = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

const htmlOk = (body = 'ok'): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

// The thrown SafeFetchError itself, so a test can assert on `code` AND on the
// ABSENCE of `status` (which `rejects.toMatchObject` can't distinguish).
async function failureOf(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SafeFetchError) return err;
    throw err;
  }
  throw new Error('expected safeFetch to reject');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safeFetch', () => {
  it('returns the upstream response with its body unconsumed', async () => {
    stubFetch(() => htmlOk('<title>hi</title>'));

    const { response, finalUrl } = await safeFetch('https://example.test/a', 'text/html');
    expect(finalUrl.toString()).toBe('https://example.test/a');
    await expect(response.text()).resolves.toBe('<title>hi</title>');
  });

  it('identifies the bot with the User-Agent published on /extractor', async () => {
    // bracemark-site's /extractor page is what a site operator reaches from this
    // header, so the URL in it is a public commitment, not a cosmetic string.
    const mock = stubFetch(() => htmlOk());

    await safeFetch('https://example.test/a', 'text/html');
    const init = mock.mock.calls[0][1] as RequestInit;
    const userAgent = (init.headers as Record<string, string>)['user-agent'];
    expect(userAgent).toContain('bracemark-extractor');
    expect(userAgent).toContain('https://bracemark.com/extractor');
  });

  it('follows a redirect and reports the FINAL url', async () => {
    stubFetch((url) =>
      url === 'https://example.test/old' ? redirectTo('https://moved.test/new', 301) : htmlOk(),
    );

    const { finalUrl } = await safeFetch('https://example.test/old', 'text/html');
    expect(finalUrl.toString()).toBe('https://moved.test/new');
  });

  it('resolves a RELATIVE Location against the CURRENT hop, not the original url', async () => {
    // A relative Location arriving after a cross-host hop: resolving it against
    // the requested URL would silently fetch a different site.
    const mock = stubFetch((url) => {
      if (url === 'https://example.test/a/old') return redirectTo('https://moved.test/s/page');
      if (url === 'https://moved.test/s/page') return redirectTo('../other/final');
      return htmlOk();
    });

    const { finalUrl } = await safeFetch('https://example.test/a/old', 'text/html');
    expect(finalUrl.toString()).toBe('https://moved.test/other/final');
    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://example.test/a/old',
      'https://moved.test/s/page',
      'https://moved.test/other/final',
    ]);
  });

  it('blocks a redirect into private space and never connects to it', async () => {
    // The bypass the per-hop re-validation exists for: the initial URL is public
    // and passes assertPublicHttpUrl, then 302s at the cloud metadata service.
    const mock = stubFetch(() => redirectTo('http://169.254.169.254/latest/meta-data/'));

    const err = await failureOf(safeFetch('https://example.test/redir', 'text/html'));
    expect(err.code).toBe('blocked');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0][0])).toBe('https://example.test/redir');
  });

  it('blocks a redirect into a non-http(s) scheme', async () => {
    stubFetch(() => redirectTo('file:///etc/passwd'));

    const err = await failureOf(safeFetch('https://example.test/redir', 'text/html'));
    expect(err.code).toBe('blocked');
  });

  // A chain of `length` redirects ending in a 200.
  function stubChain(length: number): ReturnType<typeof vi.fn> {
    return stubFetch((url) => {
      const hop = Number(/hop(\d+)/.exec(url)?.[1] ?? '0');
      return hop < length ? redirectTo(`https://hop${hop + 1}.test/`) : htmlOk();
    });
  }

  it(`follows up to ${MAX_REDIRECTS} hops`, async () => {
    stubChain(MAX_REDIRECTS);

    const { finalUrl } = await safeFetch('https://hop0.test/', 'text/html');
    expect(finalUrl.toString()).toBe(`https://hop${MAX_REDIRECTS}.test/`);
  });

  it('gives up on the hop AFTER the cap rather than looping', async () => {
    const mock = stubChain(MAX_REDIRECTS + 1);

    const err = await failureOf(safeFetch('https://hop0.test/', 'text/html'));
    expect(err.code).toBe('fetch_failed');
    // Bounded: the cap stops it, so an infinite chain can't pin the Worker.
    expect(mock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('treats a 3xx with no Location as bad_status WITHOUT relaying a status', async () => {
    // A malformed 3xx is not a verdict on the URL, so the client must keep its
    // transient default rather than read the 301 as "settled, never retry".
    stubFetch(() => new Response(null, { status: 301 }));

    const err = await failureOf(safeFetch('https://example.test/a', 'text/html'));
    expect(err.code).toBe('bad_status');
    expect(err.status).toBeUndefined();
  });

  it('relays the upstream status on a non-2xx', async () => {
    stubFetch(() => new Response('gone', { status: 410 }));

    const err = await failureOf(safeFetch('https://example.test/a', 'text/html'));
    expect(err.code).toBe('bad_status');
    expect(err.status).toBe(410);
  });

  it('reports a timeout distinctly from a connection failure', async () => {
    stubFetch(() => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    const timedOut = await failureOf(safeFetch('https://slow.test/', 'text/html'));
    expect(timedOut.code).toBe('timeout');

    stubFetch(() => {
      throw new TypeError('connection reset');
    });
    const failed = await failureOf(safeFetch('https://dead.test/', 'text/html'));
    expect(failed.code).toBe('fetch_failed');
  });

  it('rejects a private initial URL as blocked, without connecting', async () => {
    const mock = stubFetch(() => htmlOk());

    const err = await failureOf(safeFetch('http://127.0.0.1/admin', 'text/html'));
    expect(err.code).toBe('blocked');
    expect(mock).not.toHaveBeenCalled();
  });
});

// HTML truncates at the cap (the og tags are in <head>, so a partial read is
// still useful); the inline-image path throws instead (a partial image is not).
// The client gives POST /v1/extract and POST /v1/fetch-image deadlines sized from these
// caps (EXTRACT_TIMEOUT_MS and FETCH_IMAGE_TIMEOUT_MS, @stxapps/shared
// extract/endpoints.ts). Raise a cap here without raising those and a
// slow-but-healthy call is reported to the client as a timeout while the
// extractor is still working — no error anywhere else.
describe('the client’s deadlines', () => {
  const slowestFetch = (MAX_REDIRECTS + 1) * FETCH_TIMEOUT_MS;

  it('/v1/extract outlasts the slowest answer these caps allow: a page, then its inline image', () => {
    expect(EXTRACT_TIMEOUT_MS).toBeGreaterThan(2 * slowestFetch);
  });

  it('/v1/fetch-image outlasts the slowest redirect walk, with room left for the body', () => {
    // The image deadline covers the streamed body too, so merely clearing the walk
    // isn't enough — at least as long again is left for the bytes.
    expect(FETCH_IMAGE_TIMEOUT_MS).toBeGreaterThan(2 * slowestFetch);
  });
});

describe('readCappedBytes', () => {
  it('returns the whole body when it is within the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(readCappedBytes(new Response(bytes), 100)).resolves.toEqual(bytes);
  });

  it('TRUNCATES at the cap instead of throwing', async () => {
    const bytes = new Uint8Array(50).fill(7);
    const out = await readCappedBytes(new Response(bytes), 10);
    expect(out).toEqual(new Uint8Array(10).fill(7));
  });

  it('terminates on an ENDLESS body instead of draining it', async () => {
    // The cap is what makes a hostile/streaming page safe to read at all: this
    // only resolves because reading stops at the ceiling and cancels the rest.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8).fill(1));
      },
    });

    const out = await readCappedBytes(new Response(endless), 12);
    expect(out).toEqual(new Uint8Array(12).fill(1));
  });

  it('returns empty bytes for a body-less response', async () => {
    await expect(readCappedBytes(new Response(null), 100)).resolves.toEqual(new Uint8Array(0));
  });
});

describe('readAllWithLimit', () => {
  it('returns the full body when it is within the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await readAllWithLimit(new Response(bytes), 100);
    expect(out).toEqual(bytes);
  });

  it('throws too_large once the body exceeds the cap', async () => {
    const bytes = new Uint8Array(50);
    await expect(readAllWithLimit(new Response(bytes), 10)).rejects.toMatchObject({
      name: 'SafeFetchError',
      code: 'too_large',
    });
  });

  it('throws a SafeFetchError specifically', async () => {
    const bytes = new Uint8Array(50);
    await expect(readAllWithLimit(new Response(bytes), 10)).rejects.toBeInstanceOf(SafeFetchError);
  });
});

// The image proxy's ceiling. It can't buffer-then-check (that would defeat the
// streaming), so it aborts mid-flight — the client gets a broken stream, never a
// relayed 4 GB file.
describe('streamWithLimit', () => {
  const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

  it('passes bytes through unchanged while under the cap', async () => {
    const piped = streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4])).pipeThrough(
      streamWithLimit(10),
    );

    const out = new Uint8Array(await new Response(piped).arrayBuffer());
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('errors the stream once the total crosses the cap', async () => {
    const piped = streamOf(new Uint8Array(4), new Uint8Array(4)).pipeThrough(streamWithLimit(5));

    await expect(new Response(piped).arrayBuffer()).rejects.toMatchObject({
      name: 'SafeFetchError',
      code: 'too_large',
    });
  });

  it('counts across chunks, not per chunk', async () => {
    // Each chunk is well under the cap; only their sum crosses it.
    const chunks = Array.from({ length: 5 }, () => new Uint8Array(3));
    const piped = streamOf(...chunks).pipeThrough(streamWithLimit(10));

    await expect(new Response(piped).arrayBuffer()).rejects.toMatchObject({ code: 'too_large' });
  });
});
