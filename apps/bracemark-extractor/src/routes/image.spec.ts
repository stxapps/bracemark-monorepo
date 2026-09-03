import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from '../app';
import { MAX_IMAGE_BYTES } from '../lib/safe-fetch';

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
  it('maps a timeout to 504, distinctly from a fetch failure', async () => {
    stubFetch(() => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });

    const res = await getImage('https://slow.example.com/i.png');
    expect(res.status).toBe(504);
    await expect(res.json()).resolves.toEqual({ error: 'timeout' });
  });

  it('maps a connection failure to 502', async () => {
    stubFetch(() => {
      throw new TypeError('connection reset');
    });

    const res = await getImage('https://dead.example.com/i.png');
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: 'fetch_failed' });
  });

  it('follows a redirect but blocks one that lands in private space', async () => {
    stubFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    );

    const res = await getImage('https://cdn.example.com/i.png');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'blocked' });
  });

  it('forwards NOTHING from the upstream but the content type', async () => {
    // A proxy that relayed upstream headers would hand the caller another site's
    // Set-Cookie and leak whatever else that site chose to say.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    stubFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/png; charset=binary',
            'set-cookie': 'session=secret; Path=/',
            'x-powered-by': 'tracker/1.0',
            'access-control-allow-origin': 'https://evil.test',
          },
        }),
    );

    const res = await getImage('https://cdn.example.com/i.png');
    expect(res.status).toBe(200);
    // The content-type is forwarded WITHOUT its parameters.
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    // Our own CORS layer answers for the origin — never the upstream's header.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.test');
    // The bytes are unsniffable as anything but what we labelled them.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('aborts the stream when an UNDECLARED body runs past the ceiling', async () => {
    // Content-Length is the cheap early reject; this is the real one, for a body
    // that declares no length (or lies). The caller gets a broken stream — what it
    // must never get is the whole oversized file.
    const megabyte = new Uint8Array(1_000_000);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += megabyte.byteLength;
        controller.enqueue(megabyte);
      },
    });
    stubFetch(
      () => new Response(endless, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );

    const res = await getImage('https://cdn.example.com/undeclared.jpg');
    // The status is already sent by the time the ceiling is crossed, so the abort
    // can only show up as a failed body read.
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    expect(sent).toBeLessThanOrEqual(MAX_IMAGE_BYTES + megabyte.byteLength);
  });
});
