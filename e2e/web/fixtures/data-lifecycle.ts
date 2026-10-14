import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, type Page } from '@playwright/test';

import {
  type Link,
  LINKS_PREFIX,
  type List,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  type Pin,
  PINS_PREFIX,
  ranksBetween,
  type Tag,
  TAGS_PREFIX,
  TRASH_ID,
} from '@stxapps/shared';

import { buildBackupArchive } from '../../seed/archive';
import { previewPng } from '../../seed/png';

export interface SmallDataArchive {
  archivePath: string;
  fileName: string;
  linkTitle: string;
  listName: string;
  tagName: string;
  url: string;
}

// A real, smallest-useful Bracemark backup for the file-surface journeys. It
// carries every result the case must observe: one link, one list, one tag, and
// one referenced image blob. As with seed/archive.ts, shared supplies only the
// writer contract; the specs spell their expectations from the values returned
// here rather than importing an app-side reader or formatter.
export async function writeSmallDataArchive(
  archivePath: string,
  namespace: string,
): Promise<SmallDataArchive> {
  const safe = namespace
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
  const now = Date.now();
  const listId = `${safe}-list`;
  const tagId = `${safe}-tag`;
  const linkId = `${safe}-link`;
  const imageId = `${safe}-image`;
  const [listRank, tagRank] = ranksBetween(null, null, 2);
  const listName = `${namespace} list`;
  const tagName = `${namespace} tag`;
  const linkTitle = `${namespace} imported link`;
  const url = `https://${safe}.invalid/imported`;

  const list: List = {
    id: listId,
    name: listName,
    parentId: null,
    rank: listRank,
    createdAt: now,
    updatedAt: now,
  };
  const tag: Tag = {
    id: tagId,
    name: tagName,
    parentId: null,
    rank: tagRank,
    createdAt: now,
    updatedAt: now,
  };
  const link: Link = {
    url,
    listId: MY_LIST_ID,
    tagIds: [tagId],
    customTitle: linkTitle,
    customImageId: imageId,
    createdAt: now,
    updatedAt: now,
  };

  const archive = buildBackupArchive({
    items: [
      { path: pathFromId(listId, LISTS_PREFIX), data: list },
      { path: pathFromId(tagId, TAGS_PREFIX), data: tag },
      { path: pathFromId(linkId, LINKS_PREFIX), data: link },
    ],
    files: [{ id: imageId, bytes: previewPng(5) }],
    counts: { links: 1, lists: 1, tags: 1, pins: 0, extractions: 0, files: 1 },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);

  return {
    archivePath,
    fileName: archivePath.split('/').at(-1) ?? 'data-lifecycle.zip',
    linkTitle,
    listName,
    tagName,
    url,
  };
}

// A representative Netscape bookmarks file large enough to cross the free
// account's link cap. The source format is intentionally written here instead
// of through the product serializer: this is an input specimen, not an oracle.
export async function writeOverCapBookmarks(
  path: string,
  namespace: string,
  count = 201,
): Promise<{ firstTitle: string; firstUrl: string }> {
  const safe = namespace
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
  const rows = Array.from({ length: count }, (_, index) => {
    const n = String(index).padStart(3, '0');
    return {
      title: `${namespace} bookmark ${n}`,
      url: `https://${safe}.invalid/bookmark-${n}`,
    };
  });
  const html = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    ...rows.map(({ title, url }) => `  <DT><A HREF="${url}">${title}</A>`),
    '</DL><p>',
    '',
  ].join('\n');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, 'utf8');
  return { firstTitle: rows[0].title, firstUrl: rows[0].url };
}

export interface RoundTripLibrary {
  archivePath: string;
  parentList: string;
  childList: string;
  tags: [string, string];
  // In the child list, both tags, a custom title, a note, a custom image, pinned.
  full: { url: string; title: string; note: string };
  // In My List with nothing else: the row every format carries.
  plain: { url: string };
  // In Trash: only the backup carries it (docs/data-lifecycle.md, _export_).
  trashed: { url: string; title: string };
}

// The library the export round trips start from, written as a backup the source
// account imports. One link carries every field some format promises to keep —
// a nested list, two tags, a custom title, a note, an image, a pin — so each
// format's contract is a set of assertions on that one row; one sits in My List
// with nothing else; one is in Trash, which the interop formats leave out. Its
// origin is irrelevant to the claim: what is under test is what an export of
// this library brings back.
export async function writeRoundTripLibrary(
  archivePath: string,
  namespace: string,
): Promise<RoundTripLibrary> {
  const safe = namespace
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
  const now = Date.now();
  const ids = {
    parent: `${safe}-parent`,
    child: `${safe}-child`,
    tagA: `${safe}-tag-a`,
    tagB: `${safe}-tag-b`,
    full: `${safe}-full`,
    plain: `${safe}-plain`,
    trashed: `${safe}-trashed`,
    image: `${safe}-image`,
  };
  const [parentRank, childRank] = ranksBetween(null, null, 2);
  const [tagARank, tagBRank] = ranksBetween(null, null, 2);
  const [pinRank] = ranksBetween(null, null, 1);
  const library: Omit<RoundTripLibrary, 'archivePath'> = {
    parentList: `${namespace} parent`,
    childList: `${namespace} child`,
    tags: [`${namespace} tag a`, `${namespace} tag b`],
    full: {
      url: `https://${safe}.invalid/full`,
      title: `${namespace} full title`,
      note: `${namespace} note`,
    },
    plain: { url: `https://${safe}.invalid/plain` },
    trashed: { url: `https://${safe}.invalid/trashed`, title: `${namespace} trashed title` },
  };

  const list = (id: string, name: string, parentId: string | null, rank: string): List => ({
    id,
    name,
    parentId,
    rank,
    createdAt: now,
    updatedAt: now,
  });
  const tag = (id: string, name: string, rank: string): Tag => ({
    id,
    name,
    parentId: null,
    rank,
    createdAt: now,
    updatedAt: now,
  });
  // Distinct dates, newest first in the order the views list them.
  const full: Link = {
    url: library.full.url,
    listId: ids.child,
    tagIds: [ids.tagA, ids.tagB],
    customTitle: library.full.title,
    customImageId: ids.image,
    note: library.full.note,
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  };
  const plain: Link = {
    url: library.plain.url,
    listId: MY_LIST_ID,
    tagIds: [],
    createdAt: now - 2_000,
    updatedAt: now - 2_000,
  };
  const trashed: Link = {
    url: library.trashed.url,
    listId: TRASH_ID,
    tagIds: [],
    customTitle: library.trashed.title,
    createdAt: now - 3_000,
    updatedAt: now - 3_000,
  };
  // A pin is keyed by its link's id, path and body alike.
  const pin: Pin = { id: ids.full, rank: pinRank, createdAt: now, updatedAt: now };

  const archive = buildBackupArchive({
    items: [
      {
        path: pathFromId(ids.parent, LISTS_PREFIX),
        data: list(ids.parent, library.parentList, null, parentRank),
      },
      {
        path: pathFromId(ids.child, LISTS_PREFIX),
        data: list(ids.child, library.childList, ids.parent, childRank),
      },
      { path: pathFromId(ids.tagA, TAGS_PREFIX), data: tag(ids.tagA, library.tags[0], tagARank) },
      { path: pathFromId(ids.tagB, TAGS_PREFIX), data: tag(ids.tagB, library.tags[1], tagBRank) },
      { path: pathFromId(ids.full, LINKS_PREFIX), data: full },
      { path: pathFromId(ids.plain, LINKS_PREFIX), data: plain },
      { path: pathFromId(ids.trashed, LINKS_PREFIX), data: trashed },
      { path: pathFromId(ids.full, PINS_PREFIX), data: pin },
    ],
    files: [{ id: ids.image, bytes: previewPng(7) }],
    counts: { links: 3, lists: 2, tags: 2, pins: 1, extractions: 0, files: 1 },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  return { archivePath, ...library };
}

// Import a file through Settings → Data and return the receipt's text. The file
// input is driven directly, as everywhere here: a real OS picker cannot be.
export async function importFile(page: Page, path: string): Promise<string> {
  await page.goto('/settings/data');
  await page.getByRole('button', { name: /^Import data/ }).click();
  await page.locator('input[type=file]').setInputFiles(path);
  const receipt = page.getByText(/^Imported \d+ link/);
  const failure = page.getByText(/^Import failed:/);
  await expect(receipt.or(failure)).toBeVisible({ timeout: 60_000 });
  if (await failure.isVisible()) throw new Error(await failure.innerText());
  return (await receipt.innerText()).trim();
}
