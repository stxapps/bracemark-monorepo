import {
  type Link,
  LINKS_PREFIX,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  SETTINGS_GENERAL_PATH,
  type SettingsGeneral,
  TAGS_PREFIX,
} from '@stxapps/shared';

import {
  type BuildOptions,
  buildTree,
  pad,
  rootListCeiling,
  type SeedLibrary,
  type TreeSpec,
} from './library';

// `plus-large` — a library sized by COUNT, where `plus-worst` (./worst.ts) is
// sized by shape. 300 lists and 300 tags: what a large browser-bookmarks import
// makes of a few hundred folders, and nothing the editors bound — the limits
// bound depth, not count (docs/data-limits.md, _counts: none per kind_).
//
// It exists because count alone was enough to end the iOS share extension: at
// this size the share sheet's list picker, with every row mounted, took the
// process to its 120 MB cap (docs/share-sheet.md, _300 lists and 300 tags, and a
// copy at the cap_). So it is the account every surface that draws the list or
// tag tree is measured on for size — SHARE-IOS-MEMORY-RELEASE-001 in
// e2e/mobile/RELEASE.md first, and the render leg's tree legs beside `plus-worst`.
//
// The shape is a bookmark import's, not a stress test's: 50 folders of five,
// one level deep, and flat tags (tags are flat on every account — library.ts,
// TAG_NAMES). The NAMES keep plus-worst's mix of scripts in rotation — Latin,
// a long Latin name, Japanese, Arabic, an emoji, a German compound — so a
// surface that pays for fallback fonts and text layout pays for them here too,
// at scale. Every name is unique in its tree, so a selector can find any row by
// name. A modest library of links rides along — enough to file something under
// a sample of the lists and tags, and few enough to seed in a minute: no
// preview images, no extractions.

export const LARGE_COUNTS = { links: 120, lists: 300, tags: 300, pins: 0 };

const STEMS = [
  'Bookmarks',
  'Client work — Northwind Industries Holdings quarterly planning archive',
  'あとで読む・技術記事',
  'قراءات لاحقة',
  '🦊 Side projects',
  'Recipes',
  'Steuererklärungsunterlagen',
  'Reading',
];

function nameAt(i: number): string {
  return `${STEMS[i % STEMS.length]} ${pad(i, 3)}`;
}

const FOLDER_SIZE = 5;

function listSpec(): TreeSpec[] {
  const roots: TreeSpec[] = [];
  for (let n = 0; n < LARGE_COUNTS.lists;) {
    const children: TreeSpec[] = [];
    const root: TreeSpec = { name: nameAt(n++), children };
    for (let c = 1; c < FOLDER_SIZE && n < LARGE_COUNTS.lists; c++) {
      children.push({ name: nameAt(n++) });
    }
    roots.push(root);
  }
  return roots;
}

export function buildLargeLibrary(options: BuildOptions): SeedLibrary {
  const { now } = options;
  const lists = buildTree(
    listSpec(),
    'large-list',
    LARGE_COUNTS.lists,
    true,
    now,
    rootListCeiling(),
  );
  const tags = buildTree(
    Array.from({ length: LARGE_COUNTS.tags }, (_, i) => ({ name: `${nameAt(i)} tag` })),
    'large-tag',
    LARGE_COUNTS.tags,
    false,
    now,
    null,
  );

  const items: { path: string; data: object }[] = [
    ...lists.map((list) => ({ path: pathFromId(list.id, LISTS_PREFIX), data: list })),
    ...tags.map((tag) => ({ path: pathFromId(tag.id, TAGS_PREFIX), data: tag })),
  ];

  // Spread across the library — every `step`th list and tag — so the rows that
  // hold links are not all at the top, and a few in My List.
  const STEP_MS = 3 * 60 * 60 * 1000;
  for (let i = 0; i < LARGE_COUNTS.links; i++) {
    const createdAt = Math.round(now - i * STEP_MS);
    const link: Link = {
      url: `https://example.com/large/${pad(i, 3)}`,
      listId: i % 10 === 0 ? MY_LIST_ID : lists[(i * 7) % lists.length].id,
      tagIds: i % 4 === 0 ? [] : [tags[(i * 11) % tags.length].id],
      createdAt,
      updatedAt: createdAt,
    };
    items.push({ path: pathFromId(`large-link-${pad(i, 3)}`, LINKS_PREFIX), data: link });
  }

  // As every seeded library: a device that opens it never fetches its hosts.
  const settings: SettingsGeneral = {
    deviceExtractionMode: 'off',
    createdAt: now,
    updatedAt: now,
  };
  items.push({ path: SETTINGS_GENERAL_PATH, data: settings });

  return {
    items,
    files: [],
    counts: {
      links: LARGE_COUNTS.links,
      lists: lists.length,
      tags: tags.length,
      pins: 0,
      extractions: 0,
      files: 0,
    },
  };
}
