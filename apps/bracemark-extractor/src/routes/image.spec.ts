import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from '../app';

function stubFetch(impl: (url: string) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function getImage(url: string): Promise<Response> {
  return app.request(`/v1/image?url=${encodeURIComponent(url)}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/image', () => {
  it('streams image bytes through with the upstream content-type', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    stubFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
        }),
    );

    const res = await getImage('https://cdn.example.com/i.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('rejects a non-image content-type with 415', async () => {
    stubFetch(
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const res = await getImage('https://example.com/not-an-image');
    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toEqual({ error: 'unsupported_type' });
  });

  it('rejects an oversized declared body with 413', async () => {
    stubFetch(
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '20000000' },
        }),
    );

    const res = await getImage('https://cdn.example.com/huge.jpg');
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: 'too_large' });
  });

  it('blocks a private-IP URL with 403 and never fetches it', async () => {
    const mock = stubFetch(() => new Response('nope'));

    const res = await getImage('http://10.0.0.1/secret.png');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'blocked' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('maps an upstream 404 to 502', async () => {
    stubFetch(() => new Response('nope', { status: 404 }));

    const res = await getImage('https://cdn.example.com/missing.png');
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: 'bad_status' });
  });

  it('400s on a non-http(s) url at the contract', async () => {
    const res = await getImage('ftp://example.com/i.png');
    expect(res.status).toBe(400);
  });

  it('has no server-side cache — every request fetches upstream', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    const mock = stubFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'image/webp', 'content-length': String(bytes.length) },
        }),
    );
    const url = 'https://cdn.example.com/repeat.webp';

    const first = await getImage(url);
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes);

    const second = await getImage(url);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);

    // No edge cache: the identical second request hits upstream again.
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
