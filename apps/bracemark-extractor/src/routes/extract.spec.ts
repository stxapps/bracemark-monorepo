import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtractResponse } from '@stxapps/shared';

import { app } from '../app';

// The handler's outbound `fetch` (in lib/safe-fetch) is the global fetch, which we
// stub per-test. `app.request()` itself doesn't go through global fetch (Hono calls
// app.fetch directly), so the stub only intercepts the extractor's upstream calls.
function stubFetch(impl: (url: string) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function postExtract(
  urls: string[],
  body: { inlineImage?: boolean } = {},
): Promise<{ status: number; body: ExtractResponse }> {
  const res = await app.request('/v1/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls, ...body }),
  });
  return { status: res.status, body: (await res.json()) as ExtractResponse };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /v1/extract', () => {
  it('extracts og:title and og:image from HTML, preferring og over <title>', async () => {
    stubFetch(
      () =>
        new Response(
          '<html><head><title>Doc title</title>' +
            '<meta property="og:title" content="OG Title">' +
            '<meta property="og:image" content="https://cdn.example.com/i.jpg">' +
            '</head><body>hi</body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    );

    const { status, body } = await postExtract(['https://example.com/page']);
    expect(status).toBe(200);
    expect(body.results).toEqual([
      {
        url: 'https://example.com/page',
        ok: true,
        title: 'OG Title',
        imageUrl: 'https://cdn.example.com/i.jpg',
      },
    ]);
  });

  it('resolves a relative og:image against the page URL', async () => {
    stubFetch(
      () =>
        new Response(
          '<html><head><meta property="og:image" content="/img/lead.png"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    );

    const { body } = await postExtract(['https://example.com/articles/1']);
    expect(body.results[0].imageUrl).toBe('https://example.com/img/lead.png');
  });

  it('blocks a private-IP URL WITHOUT fetching it', async () => {
    const mock = stubFetch(() => new Response('nope'));

    const { body } = await postExtract(['http://169.254.169.254/latest/']);
    expect(body.results[0]).toEqual({
      url: 'http://169.254.169.254/latest/',
      ok: false,
      error: 'blocked',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('degrades a non-HTML target to a host-fallback title', async () => {
    stubFetch(
      () =>
        new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );

    const { body } = await postExtract(['https://www.example.com/file.pdf']);
    expect(body.results[0]).toEqual({
      url: 'https://www.example.com/file.pdf',
      ok: true,
      title: 'example.com',
    });
  });

  it('records a per-URL bad_status without sinking the batch', async () => {
    stubFetch((url) =>
      url.includes('good')
        ? new Response('<title>Good</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : new Response('nope', { status: 404 }),
    );

    const { body } = await postExtract(['https://good.example.com/', 'https://bad.example.com/']);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].title).toBe('Good');
    // `status` relays the UPSTREAM code, which is what lets the client settle this 404
    // `permanent` instead of retrying it forever (shared `verdictForExtractError`).
    expect(body.results[1]).toEqual({
      url: 'https://bad.example.com/',
      ok: false,
      error: 'bad_status',
      status: 404,
    });
  });

  it('relays a transient upstream status distinctly from a permanent one', async () => {
    stubFetch(() => new Response('busy', { status: 503 }));

    const { body } = await postExtract(['https://busy.example.com/']);
    expect(body.results[0]).toEqual({
      url: 'https://busy.example.com/',
      ok: false,
      error: 'bad_status',
      status: 503,
    });
  });

  it('omits status for errors that carry no upstream code', async () => {
    stubFetch(() => {
      throw new TypeError('connection reset');
    });

    const { body } = await postExtract(['https://dead.example.com/']);
    expect(body.results[0]).toEqual({
      url: 'https://dead.example.com/',
      ok: false,
      error: 'fetch_failed',
    });
  });

  it('400s when urls is empty (contract floor)', async () => {
    const res = await app.request('/v1/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [] }),
    });
    expect(res.status).toBe(400);
  });

  // --- inline image (opt-in, single-URL) -----------------------------------

  // Page HTML carrying an og:image, plus the image bytes when the og:image URL is
  // fetched. Branches on the requested URL so one stub serves both fetches.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
  function stubPageWithImage(imageStatus = 200): ReturnType<typeof vi.fn> {
    return stubFetch((url) => {
      if (url.includes('cdn.example.com')) {
        return new Response(imageStatus === 200 ? PNG : 'nope', {
          status: imageStatus,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(
        '<html><head><meta property="og:image" content="https://cdn.example.com/i.png"></head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
  }

  it('inlines the og:image bytes on a single-URL inlineImage request', async () => {
    stubPageWithImage();

    const { body } = await postExtract(['https://example.com/post'], { inlineImage: true });
    const result = body.results[0];
    expect(result.ok).toBe(true);
    // imageUrl is still populated alongside the inlined bytes (the fallback).
    expect(result.imageUrl).toBe('https://cdn.example.com/i.png');
    // imageBase64 round-trips back to the original image bytes.
    const decoded = Uint8Array.from(atob(result.imageBase64 ?? ''), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(PNG);
  });

  it('does NOT inline for a multi-URL request even when inlineImage is set', async () => {
    const mock = stubPageWithImage();

    const { body } = await postExtract(['https://example.com/a', 'https://example.com/b'], {
      inlineImage: true,
    });
    for (const result of body.results) {
      expect(result.imageUrl).toBe('https://cdn.example.com/i.png');
      expect(result.imageBase64).toBeUndefined();
    }
    // Only the two page fetches happened — the image was never fetched for inlining.
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('omits inline bytes but keeps imageUrl when the image fetch fails', async () => {
    stubPageWithImage(404); // og:image URL 404s

    const { body } = await postExtract(['https://example.com/post'], { inlineImage: true });
    const result = body.results[0];
    expect(result.ok).toBe(true);
    expect(result.imageUrl).toBe('https://cdn.example.com/i.png');
    expect(result.imageBase64).toBeUndefined();
  });

  it('does not inline when no inlineImage flag is sent', async () => {
    stubPageWithImage();

    const { body } = await postExtract(['https://example.com/post']);
    expect(body.results[0].imageUrl).toBe('https://cdn.example.com/i.png');
    expect(body.results[0].imageBase64).toBeUndefined();
  });
});
