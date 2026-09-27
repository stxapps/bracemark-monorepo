/** @jest-environment node */
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js/index-native.js';

import {
  BOOKMARK_CONVERTER_MAX_BYTES,
  type BookmarkOutputFormat,
  BRACEMARK_BACKUP_FORMAT,
  BRACEMARK_BACKUP_VERSION,
  convertBookmarkFiles,
} from '@stxapps/shared';
import {
  BACKUP_FIXTURE_ARCHIVES,
  readBackupFixture,
  readBackupFixtureContents,
} from '@stxapps/shared/testing';

import type { ConversionMessage, ConversionRequest } from './bookmark-converter.worker';

const ctx = globalThis as unknown as {
  onmessage: ((event: { data: ConversionRequest }) => void) | null;
  postMessage: (message: unknown) => void;
};
const roundTrip = (
  file: File,
  output: BookmarkOutputFormat = 'html',
): Promise<ConversionMessage> => {
  const posted = new Promise<ConversionMessage>((resolve) => {
    ctx.postMessage = (message) => resolve(message as ConversionMessage);
  });
  ctx.onmessage?.({ data: { file, output } });
  return posted;
};
async function zip(entries: Record<string, string>) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, text] of Object.entries(entries)) await writer.add(name, new TextReader(text));
  return new File([await writer.close()], 'export.zip');
}
beforeAll(async () => {
  await import('./bookmark-converter.worker');
});

it.each(['html', 'csv', 'text'] as const)(
  'passes %s output through the worker and structured clone',
  async (output) => {
    const text = 'url,title\nhttps://example.com/a,First';
    const result = await roundTrip(new File([text], 'bookmarks.csv'), output);
    expect(result).toEqual({
      ok: true,
      conversion: convertBookmarkFiles([{ name: 'bookmarks.csv', text }], output),
    });
    expect(structuredClone(result)).toEqual(result);
  },
);
it('reports a refused file with an actionable reason', async () => {
  expect(await roundTrip(new File(['{"url":"https://example.com"}'], 'wrong.json'))).toMatchObject({
    ok: false,
    message: expect.stringContaining('not supported'),
  });
});
it('refuses oversized files before reading them', async () => {
  const file = new File([new Uint8Array(BOOKMARK_CONVERTER_MAX_BYTES + 1)], 'huge.csv');
  const read = jest.spyOn(file, 'text');
  expect(await roundTrip(file)).toMatchObject({
    ok: false,
    message: expect.stringContaining('too large'),
  });
  expect(read).not.toHaveBeenCalled();
});
it('reads Pocket ZIP parts, preserves repeated links, and skips non-bookmark entries', async () => {
  const file = await zip({
    'part_0.csv':
      'title,url,time_added,tags,status\nFirst,https://example.com,1700000000,one,archive',
    'part_1.csv': 'url,title\nhttps://example.com,Again',
    'image.png': 'not an image',
  });
  const result = await roundTrip(file, 'csv');
  expect(result).toMatchObject({
    ok: true,
    conversion: {
      receipt: { linkCount: 2, duplicateCount: 1, sourceLabel: expect.stringContaining('ZIP') },
    },
  });
});
it.each(BACKUP_FIXTURE_ARCHIVES)(
  'converts %s, the backup either app writes, leaving Trash out',
  async (name) => {
    const file = new File([readBackupFixture(name)], 'Bracemark backup.zip');
    expect(await roundTrip(file)).toMatchObject({
      ok: true,
      conversion: {
        receipt: { sourceLabel: 'Bracemark backup', linkCount: 1, trashCount: 1 },
      },
    });
  },
);
// A backup's `files/` blobs are most of its bytes. One past the portable limit
// converts only if the worker never reads it and never counts it.
it('leaves a backup’s files unread and outside the portable size limit', async () => {
  const { entities } = readBackupFixtureContents();
  const manifest = (version: number) =>
    JSON.stringify({ format: BRACEMARK_BACKUP_FORMAT, version, exportedAt: 0 });
  const items = entities.map((entity) => JSON.stringify(entity)).join('\n');
  expect(
    await roundTrip(
      await zip({
        'manifest.json': manifest(BRACEMARK_BACKUP_VERSION),
        'items.jsonl': items,
        'files/big': 'a'.repeat(BOOKMARK_CONVERTER_MAX_BYTES + 1),
      }),
    ),
  ).toMatchObject({ ok: true, conversion: { receipt: { linkCount: 1 } } });
  expect(
    await roundTrip(
      await zip({ 'manifest.json': manifest(BRACEMARK_BACKUP_VERSION + 1), 'items.jsonl': items }),
    ),
  ).toMatchObject({ ok: false, message: expect.stringContaining('than this converter reads') });
});
it('rejects oversized ZIP expansion', async () => {
  expect(
    await roundTrip(await zip({ 'large.txt': 'a'.repeat(BOOKMARK_CONVERTER_MAX_BYTES + 1) })),
  ).toMatchObject({ ok: false, message: expect.stringContaining('expands beyond') });
});
it('rejects malformed ZIPs and unsupported archives', async () => {
  expect(await roundTrip(new File(['not a zip'], 'broken.zip'))).toMatchObject({ ok: false });
  expect(await roundTrip(await zip({ 'image.png': 'bytes' }))).toMatchObject({
    ok: false,
    message: expect.stringContaining('no supported'),
  });
});
