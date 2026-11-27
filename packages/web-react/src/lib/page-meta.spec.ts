/**
 * @jest-environment jsdom
 */
import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';

import {
  collectLivePageMeta,
  headMayBeStale,
  PAGE_REFETCH_MAX_CHARS,
  PAGE_REFETCH_TIMEOUT_MS,
} from './page-meta';

// The live-page collector's guard against a head left stale by an in-page move
// (page-meta.ts, _a stale head_). The specimen is YouTube's, measured 2026-11-22 on
// m.youtube.com: tap another video and `location.href` and `document.title` move on
// while og:title, og:image and og:url stay the first video's — and the navigation
// entry keeps the first video's address. jsdom is the page; the navigation entry and
// the page's own `fetch` are stubbed.

const FIRST = 'http://localhost/watch?v=first';
const NEXT = 'http://localhost/watch?v=next';

const FIRST_HEAD = `
  <meta property="og:url" content="${FIRST}">
  <meta property="og:title" content="The first video">
  <meta property="og:image" content="https://i.ytimg.com/vi/first/hq.jpg">`;

// What the server sends for NEXT today — a generic <title> and its og tags in the body,
// as m.youtube.com's are.
const NEXT_HTML = `<!doctype html><html><head><title>YouTube</title></head>
  <body><script>${'x'.repeat(1000)}</script>
  <meta property="og:url" content="${NEXT}">
  <meta property="og:title" content="The next video">
  <meta property="og:image" content="https://i.ytimg.com/vi/next/hq.jpg"></body></html>`;

interface FakeAnswer {
  ok?: boolean;
  url?: string;
  type?: string;
  html?: string;
}

function answer({
  ok = true,
  url = NEXT,
  type = 'text/html; charset=utf-8',
  html = NEXT_HTML,
}: FakeAnswer) {
  return {
    ok,
    url,
    body: null,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    text: async () => html,
  } as unknown as Response;
}

// jsdom keeps no navigation entry at all (no `getEntriesByType`), so one is put there.
function loadedAt(address: string | undefined): void {
  Object.defineProperty(window.performance, 'getEntriesByType', {
    configurable: true,
    value: (type: string) =>
      type === 'navigation' && address !== undefined ? [{ name: address }] : [],
  });
}

function showPage(address: string, head: string, title: string): void {
  window.history.replaceState(null, '', address);
  document.head.innerHTML = head;
  document.title = title;
}

// jsdom has neither; the re-read's capped reader decodes with the runtime's own.
global.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;

afterEach(() => {
  delete (window.performance as { getEntriesByType?: unknown }).getEntriesByType;
});

describe('headMayBeStale', () => {
  it('is false on the address the document was loaded at', () => {
    loadedAt(FIRST);
    showPage(FIRST, FIRST_HEAD, 'The first video - YouTube');
    expect(headMayBeStale(document, FIRST)).toBe(false);
  });

  it('is false for the same page spelled another way (http→https, a trailing slash, a fragment)', () => {
    loadedAt('http://localhost/watch?v=first#t=10');
    expect(headMayBeStale(document, 'https://localhost/watch/?v=first')).toBe(false);
  });

  it('is true after an in-page move the head did not follow', () => {
    loadedAt(FIRST);
    showPage(NEXT, FIRST_HEAD, 'The next video - YouTube');
    expect(headMayBeStale(document, NEXT)).toBe(true);
  });

  it("is false when the head's own og:url names the page shown — a site that rewrites its head", () => {
    loadedAt(FIRST);
    showPage(NEXT, `<meta property="og:url" content="${NEXT}">`, 'The next video');
    expect(headMayBeStale(document, NEXT)).toBe(false);
  });

  it('is false where the runtime keeps no navigation entry — nothing can be said', () => {
    loadedAt(undefined);
    showPage(NEXT, FIRST_HEAD, 'The next video - YouTube');
    expect(headMayBeStale(document, NEXT)).toBe(false);
  });
});

describe('collectLivePageMeta', () => {
  it('reads the head as it stands, and fetches nothing, when it is the loaded page', async () => {
    loadedAt(FIRST);
    showPage(FIRST, FIRST_HEAD, 'The first video - YouTube');
    const fetchPage = jest.fn();

    await expect(collectLivePageMeta(document, fetchPage)).resolves.toEqual({
      href: FIRST,
      collected: {
        ogTitle: 'The first video',
        ogImage: 'https://i.ytimg.com/vi/first/hq.jpg',
        docTitle: 'The first video - YouTube',
      },
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("after an in-page move, takes the tags from the page's own address fetched again", async () => {
    loadedAt(FIRST);
    showPage(NEXT, FIRST_HEAD, 'The next video - YouTube');
    const fetchPage = jest.fn(async () => answer({}));

    await expect(collectLivePageMeta(document, fetchPage)).resolves.toEqual({
      href: NEXT,
      collected: {
        ogTitle: 'The next video',
        ogImage: 'https://i.ytimg.com/vi/next/hq.jpg',
        // The page's own, kept current — not the server's generic "YouTube".
        docTitle: 'The next video - YouTube',
      },
    });
    expect(fetchPage).toHaveBeenCalledWith(
      NEXT,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it.each<[string, () => Promise<Response>]>([
    ['the fetch fails', async () => Promise.reject(new TypeError('offline'))],
    ['the answer is an error', async () => answer({ ok: false })],
    [
      'the answer is another page (a sign-in redirect)',
      async () => answer({ url: 'http://localhost/login' }),
    ],
    ['the answer is not HTML', async () => answer({ type: 'application/json' })],
  ])('drops the stale tags, keeping document.title and no image, when %s', async (_, respond) => {
    loadedAt(FIRST);
    showPage(NEXT, FIRST_HEAD, 'The next video - YouTube');

    await expect(collectLivePageMeta(document, jest.fn(respond))).resolves.toEqual({
      href: NEXT,
      collected: { docTitle: 'The next video - YouTube' },
    });
  });

  // The re-read's two bounds (page-meta.ts, refetchHead): it reads no further than
  // PAGE_REFETCH_MAX_CHARS of a streamed body and cancels the rest, and it gives up after
  // PAGE_REFETCH_TIMEOUT_MS. A server can't make the page hold either.
  it('stops reading a streamed answer at the cap and cancels the rest', async () => {
    loadedAt(FIRST);
    showPage(NEXT, FIRST_HEAD, 'The next video - YouTube');
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(
          pulls === 1 ? new TextEncoder().encode(NEXT_HTML.replace('</html>', '')) : chunk,
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = { ...answer({}), body } as unknown as Response;

    const result = await collectLivePageMeta(
      document,
      jest.fn(async () => res),
    );
    expect(result.collected.ogTitle).toBe('The next video');
    expect(cancelled).toBe(true);
    // The cap's worth of chunks and the one that crosses it; a source that never ends.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(PAGE_REFETCH_MAX_CHARS / chunk.length) + 2);
  });

  it('gives up on an answer that never comes, and drops the stale tags', async () => {
    jest.useFakeTimers();
    try {
      loadedAt(FIRST);
      showPage(NEXT, FIRST_HEAD, 'The next video - YouTube');
      const fetchPage = jest.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const settled = collectLivePageMeta(document, fetchPage);
      await jest.advanceTimersByTimeAsync(PAGE_REFETCH_TIMEOUT_MS - 1);
      let done = false;
      void settled.then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toEqual({
        href: NEXT,
        collected: { docTitle: 'The next video - YouTube' },
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
