import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type Link,
  LINKS_PREFIX,
  type List,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  ranksBetween,
  type Tag,
  TAGS_PREFIX,
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
