import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import { capturePageCopy, captureReadMode, captureScreenshot, captureTitleImage } from './capture';

// The active-page capture tier. The interesting half of this file is code that never
// runs in the extension's own bundle: `scripting.executeScript`'s `func` is
// serialized into the PAGE's world, so it can't reach the bundle and can't be
// covered by asserting on a mocked return value — the thing worth testing IS what
// the collector reads out of a DOM.
//
// So the fake `executeScript` here does what the browser does: call the function
// with `args` and hand back `[{ result }]`. jsdom is the page. That makes these
// specs a real check on the collectors, and on the three decisions the background
// makes about what comes back:
//
//   - SELECTION happens here, not in the page (the injected func is a dumb
//     collector; `selectTitleImage` — shared with bracemark-extractor and
//     bracemark-expo — decides which tag wins, so a tier upgrade is an improvement
//     rather than a change);
//   - the SECOND injection re-checks `location.href` before fetching, because a tab
//     that navigated between the two calls would attribute another page's image to
//     this link — permanently, since `extension:fg` is `tierOf`'s ceiling;
//   - bytes that aren't a raster image are DROPPED, keeping the title. `res.ok` is
//     not that check: an og:image URL that 200s with a soft-404 HTML page yields
//     bytes the UI can never render.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const NOT_AN_IMAGE = new Uint8Array(
  Array.from('<!doctype html><title>404</title>', (c) => c.charCodeAt(0)),
);

let fake: FakeBrowser;
/** What the page's `fetch` answers, per URL. */
let responses: Map<string, { ok: boolean; bytes: Uint8Array; type: string }>;

/**
 * The real injection contract: run `func` with `args`, in this document, and return
 * the browser's `[{ result }]` envelope.
 */
function injectFor(after?: () => void) {
  return jest.fn(async ({ func, args }: { func: (...a: never[]) => unknown; args?: unknown[] }) => {
    const result = await func(...((args ?? []) as never[]));
    after?.();
    return [{ result }];
  });
}

function setPage(head: string, title = ''): void {
  document.head.innerHTML = head;
  document.title = title;
}

function serveImage(url: string, bytes: Uint8Array, type = 'image/png'): void {
  responses.set(url, { ok: true, bytes, type });
}

beforeEach(() => {
  fake = installFakeBrowser();
  fake.scripting.executeScript = injectFor();
  responses = new Map();
  window.history.replaceState({}, '', '/');
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.title = '';

  // The page's own `fetch` (the image download runs in the page, since the api host
  // is the extension's only host grant), plus `data:` decoding for the background's
  // side of the boundary.
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('data:')) {
      const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }
    const hit = responses.get(url);
    if (!hit) throw new TypeError('Failed to fetch');
    return {
      ok: hit.ok,
      blob: async () => new Blob([hit.bytes as BlobPart], { type: hit.type }),
    } as unknown as Response;
  }) as typeof fetch;
});

describe('captureTitleImage — what the collector reads', () => {
  it('prefers og:title over the document title', async () => {
    setPage('<meta property="og:title" content="The OG title">', 'The document title');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'The OG title' });
  });

  it('falls back to the document title when there is no og:title', async () => {
    setPage('', 'The document title');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'The document title' });
  });

  it('reads a tag declared with `name` as well as `property`', async () => {
    setPage('<meta name="og:title" content="Named">');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'Named' });
  });

  it('takes the FIRST non-empty value for a key, in document order', async () => {
    // Head order ≈ page intent. A per-key `querySelector` would impose a preference
    // the other two collectors don't have.
    setPage(
      '<meta property="og:title" content="First"><meta property="og:title" content="Second">',
    );

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'First' });
  });

  it('treats a blank tag as absent rather than as an empty title', async () => {
    // select.ts chains with `??`, so an empty string would WIN over the fallback
    // behind it and the page would end up with no title at all.
    setPage('<meta property="og:title" content="   ">', 'The document title');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'The document title' });
  });

  it('does not decode character references a second time', async () => {
    // `getAttribute` is a DOM read, so the entity is already resolved. Decoding here
    // — as the two markup-parsing collectors must — would turn a title that really
    // displays `&amp;` into `&`.
    setPage('<meta property="og:title" content="Tom &amp;amp; Jerry">');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'Tom &amp; Jerry' });
  });

  it('returns nothing at all for a page with no title of either kind', async () => {
    setPage('');

    await expect(captureTitleImage(1)).resolves.toEqual({});
  });
});

describe('captureTitleImage — which image wins', () => {
  it.each([
    ['og:image', '<meta property="og:image" content="http://localhost/og.png">'],
    ['og:image:url', '<meta property="og:image:url" content="http://localhost/og.png">'],
    [
      'og:image:secure_url',
      '<meta property="og:image:secure_url" content="http://localhost/og.png">',
    ],
    ['twitter:image', '<meta name="twitter:image" content="http://localhost/og.png">'],
    // The LEGACY SPELLING of twitter:image — a spelling, not a rank, which is why
    // select.ts has no field for it.
    ['twitter:image:src', '<meta name="twitter:image:src" content="http://localhost/og.png">'],
    ['link rel=image_src', '<link rel="image_src" href="http://localhost/og.png">'],
  ])('collects %s', async (_name, head) => {
    setPage(head, 'A page');
    serveImage('http://localhost/og.png', PNG);

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page', image: PNG });
  });

  it('prefers og:image over twitter:image when both are declared', async () => {
    setPage(
      '<meta name="twitter:image" content="http://localhost/twitter.png">' +
        '<meta property="og:image" content="http://localhost/og.png">',
      'A page',
    );
    serveImage('http://localhost/og.png', PNG);

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page', image: PNG });
  });

  it('resolves a relative image against the page URL', async () => {
    window.history.replaceState({}, '', '/articles/one');
    setPage('<meta property="og:image" content="../hero.png">', 'A page');
    serveImage('http://localhost/hero.png', PNG);

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page', image: PNG });
  });

  it('never hands a non-http image to the in-page fetch', async () => {
    // `data:`/`javascript:` hrefs are dropped by selectTitleImage before this point,
    // and every tier skips them alike.
    setPage('<meta property="og:image" content="data:image/png;base64,iVBORw0KGgo=">', 'A page');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
    expect(fake.scripting.executeScript).toHaveBeenCalledTimes(1);
  });
});

describe('captureTitleImage — when the image is not usable', () => {
  it('keeps the title when the image request fails', async () => {
    setPage('<meta property="og:image" content="http://localhost/og.png">', 'A page');
    responses.set('http://localhost/og.png', { ok: false, bytes: PNG, type: 'image/png' });

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
  });

  it('keeps the title when the image host refuses the page’s fetch', async () => {
    // A CORS-hostile image origin. Nothing is served for this URL, so the in-page
    // fetch throws — skip the image, keep the title.
    setPage('<meta property="og:image" content="http://localhost/og.png">', 'A page');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
  });

  it('drops an image past the 8 MiB ceiling BEFORE it is inflated across the boundary', async () => {
    setPage('<meta property="og:image" content="http://localhost/huge.png">', 'A page');
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    huge.set(PNG);
    serveImage('http://localhost/huge.png', huge);

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
  });

  it('drops an empty response', async () => {
    setPage('<meta property="og:image" content="http://localhost/og.png">', 'A page');
    serveImage('http://localhost/og.png', new Uint8Array(0));

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
  });

  it('drops bytes that are not a raster image, however cleanly they were served', async () => {
    // The soft-404 case: 200 OK, real bytes, and nothing the UI could ever render.
    // Storing it as `done` would be permanent — `extension:fg` is the top tier.
    setPage('<meta property="og:image" content="http://localhost/og.png">', 'A page');
    serveImage('http://localhost/og.png', NOT_AN_IMAGE, 'text/html');

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
  });

  it('abandons the image when the tab navigated between the two injections', async () => {
    // Every capture is seconds of async during which the page can navigate.
    // Fetching then would attribute ANOTHER page's image to this link.
    setPage('<meta property="og:image" content="http://localhost/og.png">', 'A page');
    serveImage('http://localhost/og.png', PNG);
    fake.scripting.executeScript = injectFor(() => {
      window.history.replaceState({}, '', '/somewhere-else');
    });

    await expect(captureTitleImage(1)).resolves.toEqual({ title: 'A page' });
  });

  it('gives up quietly when the injection returns nothing at all', async () => {
    // A tab that closed, or a page the injection could not run in.
    fake.scripting.executeScript = jest.fn(async () => [{ result: undefined }]);

    await expect(captureTitleImage(1)).resolves.toEqual({});
  });
});

describe('captureReadMode', () => {
  const html = () => new TextDecoder().decode(captured);
  let captured: Uint8Array;

  const capture = async () => {
    captured = await captureReadMode(1);
    return html();
  };

  it('takes the article when there is one', async () => {
    document.body.innerHTML = '<main><p>main copy</p></main><article><p>article copy</p></article>';

    await expect(capture()).resolves.toContain('article copy');
    expect(html()).not.toContain('main copy');
  });

  it('falls back to main, then to the whole body', async () => {
    document.body.innerHTML = '<div><p>outer</p></div><main><p>main copy</p></main>';
    await expect(capture()).resolves.toBe('<p>main copy</p>');

    document.body.innerHTML = '<div><p>outer</p></div>';
    await expect(capture()).resolves.toBe('<div><p>outer</p></div>');
  });

  it('strips the non-content elements', async () => {
    document.body.innerHTML =
      '<article><script>evil()</script><style>p{}</style><noscript>n</noscript>' +
      '<iframe src="x"></iframe><svg></svg><p>kept</p></article>';

    await expect(capture()).resolves.toBe('<p>kept</p>');
  });

  it('reads a CLONE, leaving the live page untouched', async () => {
    // The injected func runs in the page the user is looking at; stripping the real
    // DOM would visibly break it.
    document.body.innerHTML = '<article><script>evil()</script><p>kept</p></article>';

    await capture();

    expect(document.querySelectorAll('script')).toHaveLength(1);
  });
});

describe('capturePageCopy', () => {
  it('serializes the live document as bytes', async () => {
    document.body.innerHTML = '<p id="here">copy me</p>';

    const bytes = await capturePageCopy(1);

    const html = new TextDecoder().decode(bytes);
    expect(html).toContain('<p id="here">copy me</p>');
    // Whole document, not just the body — unlike read mode, nothing is stripped.
    expect(html).toContain('<html');
  });
});

describe('captureScreenshot', () => {
  it('decodes the PNG data URL the browser hands back', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
    fake.tabs.captureVisibleTab.mockResolvedValue(dataUrl);

    await expect(captureScreenshot(7)).resolves.toEqual(PNG);
    // A WINDOW id, not a tab id — captureVisibleTab photographs whatever is
    // frontmost in that window.
    expect(fake.tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: 'png' });
  });
});
