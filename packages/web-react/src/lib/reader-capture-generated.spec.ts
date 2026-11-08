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
// out of its module graph, and the list is four lines.
const HASH_INPUTS = [
  'packages/web-react/src/lib/reader-doc-from-page.ts',
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
  document.body.innerHTML = `<article><h1>A post</h1><p>${prose}</p><p>${prose}</p></article>`;

  // eslint-disable-next-line no-new-func -- evaluating the shipped file the way Safari does
  const preprocessing = new Function(
    `${read(PREPROCESSING)}; return ExtensionPreprocessingJS;`,
  )() as {
    run: (args: { completionFunction: (result: unknown) => void }) => void;
  };
  const result = await new Promise<{
    title: string;
    url: string;
    readMode: { blocks: unknown[] } | null;
  }>((resolve) => preprocessing.run({ completionFunction: resolve as (r: unknown) => void }));

  expect(result.title).toBe('A post');
  expect(result.url).toBe(window.location.href);
  expect(result.readMode?.blocks.length).toBeGreaterThan(0);
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
  const result = await new Promise<{ title: string; readMode: unknown }>((resolve) =>
    preprocessing.run({ completionFunction: resolve as (r: unknown) => void }),
  );

  expect(result).toMatchObject({ title: 'Shop', readMode: null });
});
