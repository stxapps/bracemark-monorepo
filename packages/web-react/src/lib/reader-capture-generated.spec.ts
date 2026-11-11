/**
 * @jest-environment jsdom
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ModuleKind, transpileModule } from 'typescript';

import type { PageCaptureRequest } from '@stxapps/shared';

// The two GENERATED capture scripts expo ships — the iOS share extension's Safari
// preprocessing file (a bundle of this package's reader-doc-from-page.ts) and the
// capture screen's WebView injection (a bundle of webview-capture.ts and what it
// imports) — are built by tools/scripts/generate-reader-capture.ts and checked in. This spec is what stands between them and staleness, and it lives
// HERE, beside the converter, so editing the converter fails in the package being
// edited (the contract-vectors arrangement). Regenerate with:
//
//   npx tsx tools/scripts/generate-reader-capture.ts

const ROOT = join(__dirname, '..', '..', '..', '..');
const PREPROCESSING = 'apps/bracemark-expo/share-extension/preprocessing.js';
const CAPTURE_MODULE = 'apps/bracemark-expo/src/features/capture/page-capture-script.generated.ts';

// READER_CAPTURE_HASH_INPUTS in the generator, and the same hash. Listed again rather
// than imported: a package spec reaching into tools/ is the coupling this repo keeps
// out of its module graph, and the list is a few lines.
const HASH_INPUTS = [
  'packages/web-react/src/lib/reader-doc-from-page.ts',
  'packages/web-react/src/lib/webview-capture.ts',
  'packages/web-react/src/lib/page-meta.ts',
  'packages/web-react/src/lib/reader-images.ts',
  'packages/web-react/src/lib/reader-image.ts',
  'packages/web-react/src/lib/resize-image.ts',
  'packages/shared/src/reader/reader-doc-from-dom.ts',
  'packages/shared/src/reader/reader-doc.ts',
  'packages/shared/src/reader/reader-doc-core.ts',
  'packages/shared/src/reader/reader-images.ts',
  'packages/shared/src/reader/page-capture.ts',
  'packages/shared/src/image/sniff.ts',
  'packages/shared/src/image/preview.ts',
  'node_modules/@mozilla/readability/package.json',
  'tools/scripts/generate-reader-capture.ts',
];

function sourceHash(): string {
  const hash = createHash('sha256');
  for (const input of HASH_INPUTS) {
    hash.update(input);
    hash.update(readFileSync(join(ROOT, input)));
  }
  return hash.digest('hex').slice(0, 16);
}

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const stampOf = (text: string) => /source-hash: ([0-9a-f]{16})/.exec(text)?.[1];

test.each([PREPROCESSING, CAPTURE_MODULE])('%s was generated from the current sources', (path) => {
  expect(stampOf(read(path))).toBe(sourceHash());
});

// What Safari does with the file: evaluate it in the shared page, look up the global
// `ExtensionPreprocessingJS`, call run() and take what reaches completionFunction.
// jsdom is the page.
test('the Safari preprocessing file hands the sheet the title, the URL and the copy', async () => {
  const prose =
    'A copy of the words is the part that lasts, long after the page has moved. '.repeat(8);
  document.title = 'A post';
  document.body.innerHTML =
    `<article><h1>A post</h1><p>${prose}</p>` +
    `<figure><img src="https://cdn.example/chart.png" alt="A chart"></figure><p>${prose}</p></article>`;

  // eslint-disable-next-line no-new-func -- evaluating the shipped file the way Safari does
  const preprocessing = new Function(
    `${read(PREPROCESSING)}; return ExtensionPreprocessingJS;`,
  )() as {
    run: (args: { completionFunction: (result: unknown) => void }) => void;
  };
  const result = await new Promise<{ title: string; url: string; readMode?: unknown }>((resolve) =>
    preprocessing.run({ completionFunction: resolve as (r: unknown) => void }),
  );

  expect(result.title).toBe('A post');
  expect(result.url).toBe(window.location.href);
  // ⚠ The copy is JSON TEXT, not the doc. Safari's result becomes the React root's
  // initial props in the iOS share extension, where an article as an object graph is
  // memory that process does not have (docs/share-sheet.md, _what the sheet does and
  // doesn't do_); the app parses it at the drain.
  expect(typeof result.readMode).toBe('string');
  // The text is the CAPTURE: the document, and beside it the address of each figure
  // it gave a key to. The app fetches those natively and never stores them; the
  // document itself names a key and nothing else.
  const { doc, images } = JSON.parse(result.readMode as string) as {
    doc: { version: number; blocks: { kind: string; image?: string }[] };
    images: { key: string; url: string }[];
  };
  expect(doc.version).toBe(1);
  expect(doc.blocks.length).toBeGreaterThan(0);
  expect(images).toEqual([{ key: 'i0', url: 'https://cdn.example/chart.png' }]);
  expect(doc.blocks.find((b) => b.kind === 'figure')?.image).toBe('i0');
  expect(JSON.stringify(doc)).not.toContain('cdn.example');
});

test('a page that is not an article hands over no copy — and still the title', async () => {
  document.title = 'Shop';
  document.body.innerHTML = '<nav><a href="/a">A</a></nav><button>Buy</button>';

  // eslint-disable-next-line no-new-func -- as above
  const preprocessing = new Function(
    `${read(PREPROCESSING)}; return ExtensionPreprocessingJS;`,
  )() as {
    run: (args: { completionFunction: (result: unknown) => void }) => void;
  };
  const result = await new Promise<{ title: string; readMode?: unknown }>((resolve) =>
    preprocessing.run({ completionFunction: resolve as (r: unknown) => void }),
  );

  expect(result.title).toBe('Shop');
  // Absent, not null — see the next test.
  expect(result).not.toHaveProperty('readMode');
  expect(nullsIn(result)).toEqual([]);
});

// ⚠ Safari hands the result to the share extension as a PROPERTY LIST, which has no
// null: a JS null becomes NSNull, the extension cannot load the representation at all,
// and the sheet opens on "No link in this share" — for every page the result carries a
// null for, silently (docs/link-extraction-keep.md, the iOS preprocessing entry). This
// shipped once, as `readMode: null` on every page that is not an article.
function nullsIn(value: unknown, path = '$'): string[] {
  if (value === null) return [path];
  if (typeof value !== 'object' || value === undefined) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    nullsIn(child, `${path}.${key}`),
  );
}

test('the Safari preprocessing file hands over strings and nothing else — no null, no object', async () => {
  const prose =
    'A copy of the words is the part that lasts, long after the page has moved. '.repeat(8);
  document.title = 'A post';
  // A byline-less, date-less article: what Readability reports as null metadata.
  document.body.innerHTML = `<article><h1>A post</h1><p>${prose}</p><p>${prose}</p></article>`;
  // What a page can do to the objects a script in it builds: an enumerable property
  // on Object.prototype shows up in every `for…in`. Nothing in the file may walk an
  // object and copy this — a function is no more a property-list value than a null.
  // eslint-disable-next-line no-extend-native -- standing in for a page that did
  Object.defineProperty(Object.prototype, 'pagePolyfill', {
    value: () => undefined,
    enumerable: true,
    configurable: true,
  });

  // eslint-disable-next-line no-new-func -- evaluating the shipped file the way Safari does
  const preprocessing = new Function(
    `${read(PREPROCESSING)}; return ExtensionPreprocessingJS;`,
  )() as {
    run: (args: { completionFunction: (result: unknown) => void }) => void;
  };
  let result: unknown;
  try {
    result = await new Promise<unknown>((resolve) =>
      preprocessing.run({ completionFunction: resolve }),
    );
  } finally {
    delete (Object.prototype as Record<string, unknown>).pagePolyfill;
  }

  expect(nullsIn(result)).toEqual([]);
  expect(Object.keys(result as object).sort()).toEqual(['readMode', 'title', 'url']);
  for (const value of Object.values(result as object)) expect(typeof value).toBe('string');
});

// --- the capture screen's injection ------------------------------------------------
//
// What expo's capture screen does with the module: call `pageCaptureScript(request)`
// and inject the string into the page. Here the module is loaded as it ships (types
// stripped, nothing else) and its script evaluated in jsdom, with a stand-in for the
// WebView's bridge — so these exercise the shipped bundle and its tail, not this
// package's sources.

function loadPageCaptureScript(): (request: PageCaptureRequest) => string {
  // TypeScript's own transpiler (esbuild refuses to run under jsdom's Buffer).
  const code = transpileModule(read(CAPTURE_MODULE), {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as { pageCaptureScript?: (r: PageCaptureRequest) => string } };
  // eslint-disable-next-line no-new-func -- loading the shipped module the way Metro would
  new Function('module', 'exports', code)(module, module.exports);
  if (!module.exports.pageCaptureScript) throw new Error('no pageCaptureScript export');
  return module.exports.pageCaptureScript;
}

// Inject one request and collect what the page posts, until `until` says it has
// answered (the read-mode and meta requests answer once; image requests end with done).
async function inject(
  request: PageCaptureRequest,
  until: (message: { type: string }) => boolean,
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  await new Promise<void>((resolve) => {
    (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
      postMessage: (data: string) => {
        const message = JSON.parse(data) as { type: string };
        messages.push(message);
        if (until(message)) resolve();
      },
    };
    // eslint-disable-next-line no-new-func -- evaluating the injection the way the WebView does
    new Function(loadPageCaptureScript()(request))();
  });
  return messages;
}

describe("the capture screen's injection", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    window.history.replaceState({}, '', '/');
  });

  test("read mode answers with the request's nonce, the page's address and the capture", async () => {
    const prose =
      'A copy of the words is the part that lasts, long after the page has moved. '.repeat(8);
    document.title = 'A post';
    document.body.innerHTML =
      `<article><h1>A post</h1><p>${prose}</p>` +
      `<figure><img src="https://cdn.example/chart.png" alt="A chart"></figure><p>${prose}</p></article>`;

    const [answer] = await inject({ kind: 'readMode', nonce: 'n1' }, () => true);

    expect(answer).toMatchObject({
      type: 'bracemark-read-mode',
      nonce: 'n1',
      href: window.location.href,
    });
    const capture = answer.doc as { doc: { version: number }; images: unknown[] };
    expect(capture.doc.version).toBe(1);
    expect(capture.images).toEqual([{ key: 'i0', url: 'https://cdn.example/chart.png' }]);
  });

  test("meta answers with the page's candidates and decides nothing", async () => {
    document.head.innerHTML =
      '<meta property="og:title" content="The OG title"><meta property="og:image" content="/og.png">';
    document.title = 'The document title';

    const [answer] = await inject({ kind: 'meta', nonce: 'n2' }, () => true);

    // Both titles, and the image as the page wrote it: selection and resolution are
    // the app's (`selectTitleImage`), as on every other tier.
    expect(answer).toEqual({
      type: 'bracemark-page-meta',
      nonce: 'n2',
      href: window.location.href,
      collected: { ogTitle: 'The OG title', ogImage: '/og.png', docTitle: 'The document title' },
    });
  });

  test('a preview image is fetched from the page and posted, then done', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetchMock = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(0),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const messages = await inject(
      {
        kind: 'previewImage',
        nonce: 'n3',
        capturedFrom: window.location.href,
        url: 'https://cdn.example/og.png',
        deadlineMs: 5_000,
      },
      (m) => m.type === 'bracemark-page-images-done',
    );

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/og.png', expect.anything());
    // jsdom has no decoder, so the bytes pass through the preview cap unchanged — the
    // app sniffs and measures them on its side either way.
    expect(messages).toEqual([
      {
        type: 'bracemark-page-image',
        nonce: 'n3',
        key: 'preview',
        base64: Buffer.from(bytes).toString('base64'),
      },
      { type: 'bracemark-page-images-done', nonce: 'n3' },
    ]);
  });

  // ⚠ The page re-checks its address before every fetch: one made after the user
  // navigated would file another page's picture under this link — on the capture
  // screen, at `expo:fg`, the tier nothing outranks.
  test('a page that is no longer the captured one fetches nothing, and still says done', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const capturedFrom = window.location.href;
    window.history.replaceState({}, '', '/somewhere-else');

    const messages = await inject(
      {
        kind: 'readerImages',
        nonce: 'n4',
        capturedFrom,
        sources: [{ key: 'i0', url: 'https://cdn.example/a.jpg' }],
        deadlineMs: 5_000,
      },
      (m) => m.type === 'bracemark-page-images-done',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages).toEqual([{ type: 'bracemark-page-images-done', nonce: 'n4' }]);
  });

  test('on the captured page, article images are fetched from the page', async () => {
    // The positive control for the test above.
    const fetchMock = jest.fn(async () => ({ ok: false }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await inject(
      {
        kind: 'readerImages',
        nonce: 'n5',
        capturedFrom: window.location.href,
        sources: [{ key: 'i0', url: 'https://cdn.example/a.jpg' }],
        deadlineMs: 5_000,
      },
      (m) => m.type === 'bracemark-page-images-done',
    );

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/a.jpg', expect.anything());
  });
});
