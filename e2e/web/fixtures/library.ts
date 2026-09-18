import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type Link, LINKS_PREFIX, MY_LIST_ID, pathFromId } from '@stxapps/shared';

import { buildBackupArchive } from '../../seed/archive';
import { unique } from './data';

// A PAGED library whose row order is known: `count` links in one list, newest
// first, every one at an unresolvable `.invalid` URL. The scale fixture for the
// cases whose subject is what happens past the first page or off the first
// screen — virtualization, recycling, infinite scroll, the scroll reset.
//
// Why not `seed/library.ts`: that generator is a realistic library, and its
// realism is the wrong property here. Its links scatter across lists, Archive
// and Trash by a PRNG, carry pins that float to the top, and live on real
// `example.*` hosts — so "the 60th row of My List" is not a value a spec can
// name. Here every link is in one list with a strictly decreasing `updatedAt`,
// so row `i` of the default date-modified sort IS `urls[i]`, and nothing on the
// page resolves over the network (docs/e2e.md, _what e2e may not assert_).
//
// It goes in the way every seeded library does: a real backup picked in
// Settings → Data → Import, through the app's own write edge
// (seed/steps.ts `importArchive`). There is no database to seed links into —
// they are end-to-end encrypted — so this is not a shortcut around a write.
//
// Writer, not oracle: `@stxapps/shared` supplies the entity shape and the path
// rule the importer reads, exactly as seed/archive.ts argues. Nothing here is an
// expectation; the URLs a spec asserts on are the ones it typed into this file.
//
// No Playwright import, so the native runner can build one for a device account.

export interface PagedLibrary {
  archivePath: string;
  // Newest first — the order the default sort renders.
  urls: string[];
}

export interface PagedLibraryOptions {
  count: number;
  // Where every link is filed. Defaults to My List, the landing view.
  listId?: string;
  // Readable run-scoped label, folded into each URL so a failure screenshot says
  // which fixture it is looking at.
  label?: string;
}

export async function writePagedLibrary(
  archivePath: string,
  options: PagedLibraryOptions,
): Promise<PagedLibrary> {
  const host = `${unique(options.label ?? 'e2e-paged')}.invalid`;
  const now = Date.now();
  const urls: string[] = [];
  const items: { path: string; data: object }[] = [];

  for (let i = 0; i < options.count; i++) {
    const n = String(i).padStart(3, '0');
    const url = `https://${host}/row-${n}`;
    // A minute apart, newest first, and all in the past so a link added by the
    // spec afterwards sorts above every one of them.
    const at = now - (i + 1) * 60_000;
    const link: Link = {
      url,
      listId: options.listId ?? MY_LIST_ID,
      tagIds: [],
      createdAt: at,
      updatedAt: at,
    };
    items.push({ path: pathFromId(`${host.replace(/\W/g, '-')}-${n}`, LINKS_PREFIX), data: link });
    urls.push(url);
  }

  const archive = buildBackupArchive({
    items,
    files: [],
    counts: {
      links: options.count,
      lists: 0,
      tags: 0,
      pins: 0,
      extractions: 0,
      files: 0,
    },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  return { archivePath, urls };
}
