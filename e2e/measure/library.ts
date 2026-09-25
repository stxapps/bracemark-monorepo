import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type Extraction, EXTRACTIONS_PREFIX } from '@stxapps/shared';

import { buildBackupArchive } from '../seed/archive';
import { seedUser } from '../seed/catalog';
import { buildLibrary } from '../seed/library';

// The two inputs the data-path measurement feeds the app, at a size the caller
// picks. Paid plans have no link cap (`maxLinks: null`, shared iap/plans.ts), so
// no size is "the worst case" — the run takes a list of them and reports each.

// A browser-style bookmarks export: nested <H3> folders, ADD_DATE, TAGS on most
// links and a <DD> note on some — the constructs the Netscape scanner and the
// interop projection (find-or-create lists and tags) actually work through.
// Written by hand rather than through the product serializer, like
// web/fixtures/data-lifecycle.ts's: it is an input specimen, and another
// producer's file is what a user imports.
//
// Every address is `.invalid`, so nothing an import triggers can reach a real
// host (web/fixtures/data.ts, `unresolvableUrl`).
export async function writeBookmarksHtml(path: string, count: number): Promise<void> {
  const TOP = 12;
  const SUB = 3;
  const TAGS = Array.from({ length: 40 }, (_, i) => `tag-${String(i).padStart(2, '0')}`);
  const now = Math.floor(Date.now() / 1000);

  // Bucket b holds the links for folder (top, sub), sub −1 being the top
  // folder's own links; link i goes to bucket i % buckets, so every folder fills.
  const buckets = TOP * (SUB + 1);
  const rows: string[][] = Array.from({ length: buckets }, () => []);
  for (let i = 0; i < count; i++) {
    const tags = i % 5 < 3 ? ` TAGS="${TAGS[i % TAGS.length]},${TAGS[(i * 7) % TAGS.length]}"` : '';
    const link = `<DT><A HREF="https://site-${i % 200}.invalid/page/${i}" ADD_DATE="${now - i * 600}"${tags}>Measured bookmark ${i}</A>`;
    rows[i % buckets].push(i % 5 === 2 ? `${link}\n<DD>A note about bookmark ${i}.` : link);
  }

  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (let top = 0; top < TOP; top++) {
    lines.push(`<DT><H3 ADD_DATE="${now}">Folder ${top}</H3>`, '<DL><p>');
    for (let sub = 0; sub < SUB; sub++) {
      lines.push(`<DT><H3 ADD_DATE="${now}">Folder ${top}.${sub}</H3>`, '<DL><p>');
      lines.push(...rows[top * (SUB + 1) + sub + 1]);
      lines.push('</DL><p>');
    }
    lines.push(...rows[top * (SUB + 1)]);
    lines.push('</DL><p>');
  }
  lines.push('</DL><p>', '');

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join('\n'), 'utf8');
}

// A Bracemark backup shaped like a real Plus library: seed/library.ts's
// generator at the `plus-full` shape (nested lists, tags, pins, Archive and
// Trash, an extraction per link), scaled to `count` links.
//
// WITHOUT the preview images. They are files the restore writes one at a time
// and the sync then uploads — bandwidth and IndexedDB, not main-thread work, and
// at 10,000 links they would turn the run into a half-hour wait for local R2.
// Every extraction's `imageId` goes with them, so no link references a file the
// archive does not carry.
export async function writeBackupLibrary(path: string, count: number): Promise<void> {
  const library = buildLibrary({ ...seedUser('plus-full'), links: count }, { now: Date.now() });
  const items = library.items.map((item) => {
    if (!item.path.startsWith(EXTRACTIONS_PREFIX)) return item;
    const extraction: Extraction = { ...(item.data as Extraction) };
    delete extraction.imageId;
    return { path: item.path, data: extraction };
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    buildBackupArchive({ items, files: [], counts: { ...library.counts, files: 0 } }),
  );
}
