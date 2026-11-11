/**
 * @jest-environment jsdom
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The two GENERATED capture scripts expo ships — the iOS share extension's Safari
// preprocessing file and the WebView injection string — are bundles of this
// package's reader-doc-from-page.ts, built by tools/scripts/generate-reader-capture.ts
// and checked in. This spec is what stands between them and staleness, and it lives
// HERE, beside the converter, so editing the converter fails in the package being
// edited (the contract-vectors arrangement). Regenerate with:
//
//   npx tsx tools/scripts/generate-reader-capture.ts

const ROOT = join(__dirname, '..', '..', '..', '..');
const PREPROCESSING = 'apps/bracemark-expo/share-extension/preprocessing.js';
const CAPTURE_MODULE =
  'apps/bracemark-expo/src/features/capture/reader-capture-script.generated.ts';

// READER_CAPTURE_HASH_INPUTS in the generator, and the same hash. Listed again rather
// than imported: a package spec reaching into tools/ is the coupling this repo keeps
// out of its module graph, and the list is a few lines.
const HASH_INPUTS = [
  'packages/web-react/src/lib/reader-doc-from-page.ts',
  'packages/shared/src/reader/reader-doc-from-dom.ts',
  'packages/shared/src/reader/reader-doc.ts',
  'packages/shared/src/reader/reader-doc-core.ts',
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
