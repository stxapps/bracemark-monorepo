import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  type Extraction,
  EXTRACTIONS_PREFIX,
  type Link,
  LINKS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  type ReaderDoc,
} from '@stxapps/shared';

import { buildBackupArchive } from '../../seed/archive';
import { previewPng } from '../../seed/png';

// A backup holding kept copies, for the reader cases (READER-WEB-001,
// READER-NATIVE-001) and bulk Delete copies (BULK-COPIES-001). Only the browser
// extension takes a screenshot, and a spec cannot drive a real page into one
// (docs/e2e.md, _what e2e may not assert_), so the copies arrive the way a
// restored backup brings them: an extraction naming `readModeId` / `screenshotId`,
// and the `files/` blobs it names. The import writes them through the normal edge,
// so the reader meets copies a real account holds.
//
// Two links, the two shapes whose tabs differ (docs/reader.md, _the tabs_):
//   - `both` — a read-mode copy and a screenshot: two tabs, opening on Read mode;
//   - `shotOnly` — a screenshot alone: on a plan with `keptCopies`, the same two
//     tabs, opening on Screenshot, with the way to take read mode in the other.
//
// Writer, not oracle (./visual-library.ts): shared supplies the entity and
// document shapes the importer reads; every value a spec waits for is returned
// below and spelled here.

// The read-mode copy's bytes: a `ReaderDoc` as UTF-8 JSON, gzipped — the plaintext
// of the blob `readModeId` names (link-extraction-keep.md, _the read-mode copy is
// blocks_). Gzip is the format, not an API, so node's zlib writes what the apps'
// gunzip reads.
function readModeBytes(doc: ReaderDoc): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
}

// A screenshot at a laptop capture's shape (about 1.75:1 — docs/reader.md, _the
// screenshot_), so the reader's box takes a ratio that is not its 16:10 placeholder.
// A PNG where the extension writes a JPEG: both apps draw the bytes by sniffing them,
// as they draw the seed's PNG previews.
const SHOT = { width: 700, height: 400 };

export interface KeptCopiesLibrary {
  archivePath: string;
  // The link with both copies: its row's title, its article's heading and one
  // sentence of its body.
  bothTitle: string;
  bothUrl: string;
  heading: string;
  sentence: string;
  // The link with a screenshot alone.
  shotOnlyTitle: string;
  shotOnlyUrl: string;
  // The screenshot's own shape, width over height.
  shotRatio: number;
}

export async function writeKeptCopiesLibrary(
  archivePath: string,
  namespace: string,
): Promise<KeptCopiesLibrary> {
  const safe = namespace
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
  const now = Date.now();
  const bothId = `${safe}-both`;
  const shotOnlyId = `${safe}-shot-only`;
  const bothTitle = `${namespace} kept article`;
  const shotOnlyTitle = `${namespace} kept screenshot`;
  const bothUrl = `https://${safe}.invalid/article`;
  const shotOnlyUrl = `https://${safe}.invalid/storefront`;
  const heading = 'Why the copy is kept';
  const sentence = `The page as it was on the day ${namespace} was saved.`;

  const doc: ReaderDoc = {
    version: 1,
    title: bothTitle,
    siteName: `${safe}.invalid`,
    sourceUrl: bothUrl,
    capturedAt: now - 60_000,
    blocks: [
      { id: 'b0', kind: 'heading', level: 2, runs: [{ text: heading }] },
      { id: 'b1', kind: 'paragraph', runs: [{ text: sentence }] },
      {
        id: 'b2',
        kind: 'paragraph',
        runs: [{ text: 'A second paragraph, so the article is more than one line.' }],
      },
    ],
  };

  const items: { path: string; data: object }[] = [];
  const files: { id: string; bytes: Uint8Array }[] = [];

  const specs = [
    { id: bothId, url: bothUrl, title: bothTitle, readMode: true, at: now - 2 * 60_000 },
    {
      id: shotOnlyId,
      url: shotOnlyUrl,
      title: shotOnlyTitle,
      readMode: false,
      at: now - 3 * 60_000,
    },
  ];
  for (const [index, spec] of specs.entries()) {
    const link: Link = {
      url: spec.url,
      listId: MY_LIST_ID,
      tagIds: [],
      createdAt: spec.at,
      updatedAt: spec.at,
    };
    items.push({ path: pathFromId(spec.id, LINKS_PREFIX), data: link });

    const readModeId = spec.readMode ? `${spec.id}-read-mode` : undefined;
    const screenshotId = `${spec.id}-screenshot`;
    if (readModeId) files.push({ id: readModeId, bytes: readModeBytes(doc) });
    files.push({ id: screenshotId, bytes: previewPng(13 + index * 17, SHOT) });

    const done = {
      status: 'done' as const,
      extractedBy: 'extension:fg',
      extractedAt: spec.at,
      attempts: 1,
    };
    const extraction: Extraction = {
      id: spec.id,
      title: spec.title,
      ...(readModeId ? { readModeId } : {}),
      screenshotId,
      facets: {
        titleImage: done,
        ...(readModeId ? { readMode: done } : {}),
        screenshot: done,
      },
      createdAt: spec.at,
      updatedAt: spec.at,
    };
    items.push({ path: pathFromId(spec.id, EXTRACTIONS_PREFIX), data: extraction });
  }

  const archive = buildBackupArchive({
    items,
    files,
    counts: {
      links: specs.length,
      lists: 0,
      tags: 0,
      pins: 0,
      extractions: specs.length,
      files: files.length,
    },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);

  return {
    archivePath,
    bothTitle,
    bothUrl,
    heading,
    sentence,
    shotOnlyTitle,
    shotOnlyUrl,
    shotRatio: SHOT.width / SHOT.height,
  };
}
