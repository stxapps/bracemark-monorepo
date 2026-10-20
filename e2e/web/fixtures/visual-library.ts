import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type Extraction,
  EXTRACTIONS_PREFIX,
  type Link,
  LINKS_PREFIX,
  type List,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  type Pin,
  PINS_PREFIX,
  ranksBetween,
  SETTINGS_GENERAL_PATH,
  type SettingsGeneral,
  type Tag,
  TAGS_PREFIX,
} from '@stxapps/shared';

import { buildBackupArchive } from '../../seed/archive';
import { previewPng } from '../../seed/png';

// The library every visual checkpoint photographs (docs/e2e.md, _visual
// checkpoints_). It is the one fixture in e2e/ whose values are NOT namespaced
// with `unique()`, and that is the point of it: a screenshot compared against
// yesterday's has to show the same words, so every title, host, list, tag,
// note, preview image and timestamp below is a constant. Each visual case still
// imports it into a fresh disposable account, so fixed values never collide.
//
// Everything a row can show is spelled out rather than extracted: `.invalid`
// hosts, `done` extractions carrying the title and a generated preview, so no
// row waits on the network and the "links without a preview" prompt has
// nothing to count. The timestamps hang off a fixed anchor, so the order is
// stable forever; the relative date web prints beside a row still drifts with
// the wall clock, which is why checkpoints mask it rather than freeze time.
//
// Writer, not oracle — the same bargain as ./library.ts: shared supplies the
// entity shapes and paths the importer reads; the values a flow or spec waits
// for are the ones exported below.

const ANCHOR = Date.UTC(2026, 0, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

interface VisualLinkSpec {
  slug: string;
  url: string;
  title?: string;
  customTitle?: string;
  // Where it is filed; My List (the landing view) when absent.
  list?: keyof typeof LISTS;
  tags: (keyof typeof TAGS)[];
  note?: string;
  image?: number;
  pinned?: boolean;
  // A failed-for-good extraction: the row falls back to its host and a monogram.
  permanent?: boolean;
}

const LISTS = {
  reading: 'Reading',
  kitchen: 'Kitchen',
  travel: 'Travel',
  private: 'Private',
} as const;

const TAGS = {
  longform: 'longform',
  weekend: 'weekend',
  toTry: 'to-try',
} as const;

// Newest first: row i of the default date-modified sort, the pin floated above.
// Most live in My List, the view a signed-in person lands on; one each in two
// user lists, so the sidebar's lists and a locked list have something behind them.
const LINKS: VisualLinkSpec[] = [
  {
    slug: 'reading-slowly',
    url: 'https://field-notes.invalid/reading-slowly',
    title: 'A field guide to reading slowly',
    tags: ['longform'],
    note: 'Chapter three first.',
    image: 3,
    pinned: true,
  },
  {
    slug: 'sourdough',
    url: 'https://kitchen-log.invalid/sourdough',
    title: 'Sourdough for beginners',
    tags: ['weekend', 'toTry'],
    image: 11,
  },
  {
    slug: 'night-trains',
    url: 'https://slow-travel.invalid/night-trains',
    title: 'Night trains across the Alps',
    tags: ['longform'],
    note: 'Book the couchette early.',
    image: 19,
  },
  {
    slug: 'beans',
    url: 'https://kitchen-log.invalid/beans-and-greens',
    title: 'Braised beans with greens',
    list: 'kitchen',
    tags: ['toTry'],
  },
  {
    slug: 'rent',
    url: 'https://household.invalid/rent-receipts',
    customTitle: 'Rent receipts for the year',
    list: 'private',
    tags: [],
  },
  {
    slug: 'plain-page',
    url: 'https://plain-page.invalid/notes/2026',
    tags: [],
    permanent: true,
  },
  {
    slug: 'harbour',
    url: 'https://slow-travel.invalid/harbour-walk',
    title: 'Walking the old harbour',
    tags: ['weekend'],
    image: 27,
  },
  {
    slug: 'timetables',
    url: 'https://field-notes.invalid/timetables',
    title: 'How to read a train timetable',
    tags: [],
    image: 35,
  },
  // An Arabic title with a Latin name and a number inside it — the row that
  // photographs `dir="auto"` (docs/accessibility.md, _user text takes its own
  // direction_). Laid out LTR, its opening words land at the far left, the END
  // for its reader, and nothing but a picture shows it. Oldest, so it sits
  // below every row a case reads and moves none of them.
  {
    slug: 'rtl',
    url: 'https://field-notes.invalid/ar/night-trains',
    title: 'دليل القطارات الليلية عبر Alps في 7 أيام',
    tags: [],
    image: 43,
  },
];

export interface VisualLibrary {
  archivePath: string;
  // The title of the newest unpinned row — present once the library has landed.
  landedTitle: string;
  // A word two titles share, for the search checkpoint, and one of them.
  searchWord: string;
  searchHit: string;
  // Two rows the bulk-mode checkpoint selects, by title.
  selectTitles: [string, string];
  // The list the lock case locks — its name, and the opaque id a `?list=` URL
  // carries (docs/search.md: never a name). One link lives in it.
  privateList: string;
  privateListId: string;
  // A URL no fixture link uses, typed into the add surface.
  draftUrl: string;
}

export async function writeVisualLibrary(archivePath: string): Promise<VisualLibrary> {
  const items: { path: string; data: object }[] = [];
  const files: { id: string; bytes: Uint8Array }[] = [];

  const listKeys = Object.keys(LISTS) as (keyof typeof LISTS)[];
  const listRanks = ranksBetween(null, null, listKeys.length);
  for (const [index, key] of listKeys.entries()) {
    const list: List = {
      id: `visual-list-${key}`,
      name: LISTS[key],
      parentId: null,
      rank: listRanks[index],
      createdAt: ANCHOR - 30 * DAY,
      updatedAt: ANCHOR - 30 * DAY,
    };
    items.push({ path: pathFromId(list.id, LISTS_PREFIX), data: list });
  }

  const tagKeys = Object.keys(TAGS) as (keyof typeof TAGS)[];
  const tagRanks = ranksBetween(null, null, tagKeys.length);
  for (const [index, key] of tagKeys.entries()) {
    const tag: Tag = {
      id: `visual-tag-${key}`,
      name: TAGS[key],
      parentId: null,
      rank: tagRanks[index],
      createdAt: ANCHOR - 30 * DAY,
      updatedAt: ANCHOR - 30 * DAY,
    };
    items.push({ path: pathFromId(tag.id, TAGS_PREFIX), data: tag });
  }

  const pins = LINKS.filter((spec) => spec.pinned);
  const pinRanks = ranksBetween(null, null, Math.max(pins.length, 1));
  for (const [index, spec] of LINKS.entries()) {
    const id = `visual-link-${spec.slug}`;
    const at = ANCHOR - (index + 1) * DAY;
    const link: Link = {
      url: spec.url,
      listId: spec.list ? `visual-list-${spec.list}` : MY_LIST_ID,
      tagIds: spec.tags.map((tag) => `visual-tag-${tag}`),
      createdAt: at,
      updatedAt: at,
      ...(spec.customTitle ? { customTitle: spec.customTitle } : {}),
      ...(spec.note ? { note: spec.note } : {}),
    };
    items.push({ path: pathFromId(id, LINKS_PREFIX), data: link });

    const imageId = spec.image === undefined ? undefined : `visual-image-${spec.slug}`;
    if (imageId) files.push({ id: imageId, bytes: previewPng(spec.image as number) });
    const extraction: Extraction = {
      id,
      ...(spec.title ? { title: spec.title } : {}),
      ...(imageId ? { imageId } : {}),
      facets: {
        titleImage: {
          status: spec.permanent ? 'permanent' : 'done',
          extractedBy: 'extension:fg',
          extractedAt: at,
          attempts: 1,
        },
      },
      createdAt: at,
      updatedAt: at,
    };
    items.push({ path: pathFromId(id, EXTRACTIONS_PREFIX), data: extraction });

    if (spec.pinned) {
      const pin: Pin = { id, rank: pinRanks[pins.indexOf(spec)], createdAt: at, updatedAt: at };
      items.push({ path: pathFromId(id, PINS_PREFIX), data: pin });
    }
  }

  // No device fetches anything for these links, whatever mode a run leaves on.
  const settings: SettingsGeneral = {
    deviceExtractionMode: 'off',
    createdAt: ANCHOR,
    updatedAt: ANCHOR,
  };
  items.push({ path: SETTINGS_GENERAL_PATH, data: settings });

  const archive = buildBackupArchive({
    items,
    files,
    counts: {
      links: LINKS.length,
      lists: listKeys.length,
      tags: tagKeys.length,
      pins: pins.length,
      extractions: LINKS.length,
      files: files.length,
    },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);

  return {
    archivePath,
    landedTitle: 'Sourdough for beginners',
    searchWord: 'train',
    searchHit: 'Night trains across the Alps',
    selectTitles: ['Sourdough for beginners', 'Walking the old harbour'],
    privateList: LISTS.private,
    privateListId: 'visual-list-private',
    draftUrl: 'https://draft-link.invalid/saved-for-later',
  };
}
