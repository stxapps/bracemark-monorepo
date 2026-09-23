import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type Extraction,
  EXTRACTIONS_PREFIX,
  type Link,
  LINKS_PREFIX,
  type Pin,
  PINS_PREFIX,
  TRASH_ID,
} from '@stxapps/shared';

import { buildBackupArchive } from '../../seed/archive';
import { seedUser } from '../../seed/catalog';
import { buildLibrary } from '../../seed/library';
import { displayUrl } from './links';

// The SCALE fixture proper: the generated 1,000-link library (`seed/library.ts`,
// the `plus-full` shape — 24 nested lists, 40 tags, eight pins spread through the
// library, links in Archive and Trash) written as a real backup, for a fresh
// disposable account to import. It is the archive `npm run seed:fixtures` writes,
// not the seeded ACCOUNT: no spec signs into `seed_plus_full`
// (docs/e2e.md, _cases, suites and fixtures_).
//
// Why this one and not web/fixtures/library.ts's paged library: the claim is
// about paging a REALISTIC library, and the property that matters is the pins.
// The generator pins every 37th link, so most of them sit pages deep in the date
// order — exactly where the pinned overlay's "excluded from the rest"
// (docs/client-queries.md, _the pinned overlay_) either holds or shows the same
// link twice. A paged library has no pins at all.
//
// The expected order is derived here from the entities this file hands the
// importer — the fixture is the oracle for user data, as everywhere in e2e. Two
// read rules are re-spelled rather than imported, for the reason `displayUrl`
// is: Show All leaves out Trash and keeps Archive, and the default sort is date
// modified, newest first (links/_hooks/use-links.ts, shared `emptyQuery`).
//
// No test fixture, so the native runner can build one for a device account.

export interface ScaleLibrary {
  archivePath: string;
  // Show All's pinned overlay, in pin-rank order.
  pinned: string[];
  // Show All below the overlay: every other non-Trash link, newest first.
  rest: string[];
  // Pinned links whose own date puts them past the first page, each with the
  // two links that sit either side of it in the date order. With the overlay
  // working those two are ADJACENT rows; a pin that also stayed in the rest
  // would be the row between them.
  deepPins: DeepPin[];
  // What each shown row prints as its primary line, by url — its title, or the
  // bare address when it has none. The native flows find rows by it, and the
  // generated titles repeat every 24 links, so only a UNIQUE one is a selector.
  display: Map<string, string>;
}

export interface DeepPin {
  url: string;
  // Position the link would hold in the date order if it were not pinned.
  naturalIndex: number;
  before: string;
  after: string;
}

// PAGE_SIZE in both apps' use-links.ts. Re-spelled: a pin inside the first page
// cannot distinguish "excluded from the rest" from "never paged in".
const FIRST_PAGE = 50;

export async function writeScaleLibrary(archivePath: string): Promise<ScaleLibrary> {
  const library = buildLibrary(seedUser('plus-full'), { now: Date.now() });

  const links = new Map<string, Link>();
  const titles = new Map<string, string>();
  const pins: Pin[] = [];
  for (const item of library.items) {
    if (item.path.startsWith(LINKS_PREFIX)) links.set(idOf(item.path), item.data as Link);
    if (item.path.startsWith(PINS_PREFIX)) pins.push(item.data as Pin);
    if (item.path.startsWith(EXTRACTIONS_PREFIX)) {
      const extraction = item.data as Extraction;
      if (extraction.title) titles.set(idOf(item.path), extraction.title);
    }
  }

  const shown = [...links.entries()]
    .filter(([, link]) => link.listId !== TRASH_ID)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const pinnedIds = new Set(
    pins.filter((pin) => links.get(pin.id)?.listId !== TRASH_ID).map((pin) => pin.id),
  );
  const pinned = pins
    .filter((pin) => pinnedIds.has(pin.id))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((pin) => urlOf(links, pin.id));
  const natural = shown.map(([id, link]) => ({ id, url: link.url }));
  // The row's resolution, re-spelled: a user title, else the extracted one, else
  // the address (docs/client-queries.md, _pagination_, the per-row join).
  const display = new Map(
    shown.map(([id, link]) => [
      link.url,
      link.customTitle ?? titles.get(id) ?? displayUrl(link.url),
    ]),
  );
  const rest = natural.filter((entry) => !pinnedIds.has(entry.id)).map((entry) => entry.url);

  const deepPins: DeepPin[] = [];
  natural.forEach((entry, index) => {
    if (!pinnedIds.has(entry.id) || index < FIRST_PAGE) return;
    const before = natural[index - 1];
    const after = natural[index + 1];
    // Two pins side by side would make the neighbours pins themselves; the
    // generator spaces them 37 apart, so this only guards a future edit.
    if (!before || !after || pinnedIds.has(before.id) || pinnedIds.has(after.id)) return;
    deepPins.push({ url: entry.url, naturalIndex: index, before: before.url, after: after.url });
  });
  if (deepPins.length === 0) throw new Error('the scale library has no pin past the first page');

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, buildBackupArchive(library));
  return { archivePath, pinned, rest, deepPins, display };
}

function idOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
}

function urlOf(links: Map<string, Link>, id: string): string {
  const link = links.get(id);
  if (!link) throw new Error(`pin ${id} names no link in the scale library`);
  return link.url;
}
