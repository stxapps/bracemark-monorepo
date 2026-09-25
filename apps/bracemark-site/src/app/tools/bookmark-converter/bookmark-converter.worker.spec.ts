/**
 * @jest-environment node
 *
 * The converter's worker — the glue between the page and
 * convertRaindropCsvToBookmarksHtml, whose own behaviour is pinned in
 * @stxapps/shared tools/bookmark-converter.spec.ts. What only this file can pin
 * is the half that crosses `postMessage`, where nothing is type-checked:
 *   - the message SHAPE bookmark-converter.tsx reads (`ok`, `conversion`,
 *     `message`). A renamed field is neither a type nor a lint error; the page
 *     just resolves `undefined` or shows no reason.
 *   - a converter refusal settles as `{ ok: false }` carrying the converter's
 *     own sentence. An exception escaping the handler would leave the page on
 *     "Checking…" until its 60-second timeout, then show the wrong reason.
 *   - the result survives structured clone. A real worker clones it on the way
 *     out; one uncloneable field (a function, a class instance) turns every
 *     successful conversion into a DataCloneError.
 */
import { BOOKMARK_CONVERTER_MAX_BYTES, convertRaindropCsvToBookmarksHtml } from '@stxapps/shared';

import type { ConversionMessage } from './bookmark-converter.worker';

const HEADER = 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite';

// The worker addresses its globals through `globalThis`, which is what lets it
// load under node.
const ctx = globalThis as unknown as {
  onmessage: ((event: { data: File }) => void) | null;
  postMessage: (message: unknown) => void;
};

// Post one file in and wait for the one message that comes back out.
const roundTrip = (file: File): Promise<ConversionMessage> => {
  const posted = new Promise<ConversionMessage>((resolve) => {
    ctx.postMessage = (message) => resolve(message as ConversionMessage);
  });
  ctx.onmessage?.({ data: file });
  return posted;
};

const csvFile = (text: string) => new File([text], 'raindrop.csv', { type: 'text/csv' });

beforeAll(async () => {
  // Importing the module IS the registration — it assigns ctx.onmessage at load.
  await import('./bookmark-converter.worker');
});

it('registers a message handler on load (a worker that never answers is invisible)', () => {
  expect(ctx.onmessage).toEqual(expect.any(Function));
});

it('answers a Raindrop.io export with the conversion itself, intact through a clone', async () => {
  const text = [
    HEADER,
    '1,First,,,https://example.com/a,Work,one,2024-01-01T00:00:00.000Z,,,false',
    '2,Second,,,https://example.com/b,,,2024-01-01T00:00:00.000Z,,,false',
  ].join('\n');

  const result = await roundTrip(csvFile(text));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.conversion).toEqual(convertRaindropCsvToBookmarksHtml(text));
  expect(structuredClone(result)).toEqual(result);
});

it("reports a refused file as { ok: false } with the converter's own reason", async () => {
  const text = 'url,title\nhttps://example.com/a,First';

  const result = await roundTrip(csvFile(text));

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The page shows this string as-is, so it has to be the sentence the
  // converter wrote for this case, not a generic fallback.
  expect(() => convertRaindropCsvToBookmarksHtml(text)).toThrow(result.message);
});

it('refuses an oversized file without reading it into memory', async () => {
  const file = new File([new Uint8Array(BOOKMARK_CONVERTER_MAX_BYTES + 1)], 'huge.csv');
  const read = jest.spyOn(file, 'text');

  const result = await roundTrip(file);

  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('too large') });
  expect(read).not.toHaveBeenCalled();
});
