import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Link } from '../sync/entities';
import { LINKS_PREFIX } from '../sync/paths';
import { ARCHIVE_ID, MY_LIST_ID, SYSTEM_LIST_DEFAULTS } from '../sync/system-lists';
import { canonicalUrlKey } from '../url/url';
import { detectTextImportFormat } from './detect';
import { parseImportText } from './parse';
import { projectImportedLinks } from './project';

// A REAL LinkWarden backup.json, anonymized, run through the real dispatch.
//
// `linkwarden.spec.ts` beside this file covers the parser's rules one at a time
// with hand-written backups, and that is the right shape for rules. What it could
// not cover is what those fixtures were BUILT FROM: the export controller plus two
// second-hand readings of it. Its header said so for as long as that was true —
// every case in it agreed with our parser by construction, because the same
// person wrote both. This file is the other half, the same pairing
// `brace-export.spec.ts` makes one format over: one whole export, end to end
// through `parseImportText` (detection included — a misroute is the failure mode
// that hurts here), asserted on RELATIONS rather than values.
//
// PROVENANCE. One real account on a hosted LinkWarden instance, exported
// 2026-09-13 and kept whole — 11 collections, 25 links, 3 pins, 4 tags — because
// at 25 rows there is nothing to gain by trimming. The library reached LinkWarden
// by import (from Raindrop), which is not a quirk of this account but the
// commonest way anyone arrives at a bookmark manager, and it is the reason
// `importDate` below is the whole of the date story.
//
// WHAT WAS CHANGED, and the rule behind it: every URL, every page title and every
// scraped `metaDescription` is substituted, plus the account's `uuid`, `name`,
// `username` and `email` — a public repo is not the place for either. Everything
// else is VERBATIM: key order (the user's scalar columns still come first, which
// is what detection has to survive), every id and `parentId`, every timestamp,
// the remaining user scalars, the collection and tag names, the `rssSubscriptions:
// []`, the pinned rows' archive paths and their whitespace-heavy `textContent`.
//
// The substitutions are NOT sanitizing ones, which is the part that matters:
// where the original carried a property, its replacement carries the same one —
// the `&amp;` in a title and the bare `&` in that same row's metaDescription, the
// unbalanced U+202D, the Thai script, the embedded `"`, the stray ` ,`, the empty
// query values in `?ie=UTF8&qid=&sr=`, a `www.` host and its bare twin, the exact
// duplicate rows. An anonymization that quietly normalized those would leave a
// file that agrees with our parser by construction — the exact property this
// pairing exists to escape.
//
// It is prettier-formatted like `brace-export.json`, not `.prettierignore`d like
// the netscape and raindrop specimens: there the whitespace IS the subject (tag
// soup), here it isn't. A producer writes this file on one line; nothing in the
// parser or the probe depends on that, and key order — which prettier keeps — is
// what does.
const EXPORT = readFileSync(join(__dirname, '__fixtures__', 'linkwarden-export.json'), 'utf8');

const bundle = parseImportText(EXPORT, 'backup.json');

// The file's own rows, so trimming the fixture can't invalidate an assertion.
interface RawLink {
  id: number;
  name: string;
  url: string;
  description: string;
  importDate: string | null;
  createdAt: string;
  metaDescription: string | null;
}
interface RawCollection {
  id: number;
  name: string;
  parentId: number | null;
  links: RawLink[];
}
const raw = JSON.parse(EXPORT) as {
  collections: RawCollection[];
  pinnedLinks: { id: number }[];
};
const rawLinks = raw.collections.flatMap((collection) => collection.links);

describe('a real LinkWarden backup', () => {
  // THE silent failure this format's parser exists to prevent: the user's scalar
  // columns come first, so `collections` sits ~700 bytes in, and before the
  // anchor+scan probe the file was TEXT — the URL miner ate the raw JSON and
  // produced a flat pile with every collection, tag, note, date and pin gone, and
  // no error. The count is the tell: text mining finds every URL-shaped string in
  // the file, not the ones it declares as links.
  it('is routed by structure, not mined as text', () => {
    expect(detectTextImportFormat(EXPORT, 'backup.json')).toBe('linkwarden');

    const declared = new Set(rawLinks.map((link) => link.url));
    expect(bundle.links).toHaveLength(rawLinks.length);
    for (const link of bundle.links) expect(declared.has(link.url)).toBe(true);
  });

  // `parentId` is the only membership the file guarantees, and it nests four deep
  // here. Two things ride on the deepest chain: it is longer than any hand-written
  // fixture, and two of its segments contain `/` — which a chain joined into a
  // string would split into phantom folders (the bug Raindrop's CSV really had).
  it('files a link under its whole collection chain, with a slash inside one segment', () => {
    const paths = bundle.links.map((link) => link.folderPath);
    expect(paths).toContainEqual(['Marketing', 'SEO / AEO', 'Search Engines', 'Google']);
    expect(paths).toContainEqual(['Marketing', 'AEO/GEO']);
    expect(paths).toContainEqual(['books', 'draw & paint']);
    // No segment is ever an id, and none was split on its slash.
    for (const segment of paths.flat()) expect(segment).not.toMatch(/^\d+$/);
  });

  // The date finding, and the reason it needed a real file. Every `createdAt` in
  // this export is the minute its IMPORT BATCH ran — 25 rows carry two distinct
  // values — while `importDate` holds when each link was actually saved. Reading
  // `createdAt` would date a stranger's whole library to the afternoon they
  // switched apps, with nothing on screen to suggest it.
  it('dates a link from importDate, not from the row it was minted in', () => {
    const byUrl = new Map(bundle.links.map((link) => [link.url, link]));
    for (const row of rawLinks) {
      expect(byUrl.get(row.url)?.createdAt).toBe(Date.parse(row.importDate ?? row.createdAt));
    }

    // The negative, which is the whole point: to the minute, `createdAt` takes
    // TWO values across the file — the two import runs, milliseconds apart within
    // each — while `importDate` spreads across the days the links were really
    // saved. A parser reading the wrong one still produces 25 dated links, which
    // is why this needs asserting rather than eyeballing.
    const minute = (stamp: string) => stamp.slice(0, 16);
    const minted = new Set(rawLinks.map((row) => minute(row.createdAt)));
    const saved = new Set(rawLinks.map((row) => minute(row.importDate ?? row.createdAt)));
    expect(minted.size).toBe(2);
    expect(saved.size).toBeGreaterThan(10);
  });

  // LinkWarden stores its scrape of `<title>` WITHOUT decoding it, so a JSON
  // string field arrives HTML-escaped. The control is inside one row: the title
  // says `&amp;` where that row's own metaDescription — same page, same scrape —
  // says `&`.
  it('decodes the entity LinkWarden left in a title, and only in the title', () => {
    const encoded = rawLinks.filter((row) => row.name.includes('&amp;'));
    expect(encoded).toHaveLength(2);
    // The one that carries the control in its own row.
    const control = encoded.find((row) => row.metaDescription?.includes(' & '));
    expect(control).toBeDefined();

    const link = bundle.links.find((row) => row.url === control?.url);
    expect(link?.customTitle).toContain(' & ');
    for (const row of bundle.links) expect(row.customTitle ?? '').not.toContain('&amp;');

    // The other half: a collection name is the user's own word, not a scrape, so
    // its bare `&` must survive untouched rather than be "fixed" in either
    // direction.
    expect(bundle.links.map((row) => row.folderPath)).toContainEqual(['books', 'draw & paint']);
  });

  // Pins are a SEPARATE relation on the user holding the same rows over again, so
  // the failure to guard is importing each pinned link twice — 25 rows would
  // become 28, and three links would silently duplicate.
  it('marks the pinned rows by id without importing them again', () => {
    const pinnedIds = new Set(raw.pinnedLinks.map((pin) => pin.id));
    const pinnedUrls = new Set(
      rawLinks.filter((row) => pinnedIds.has(row.id)).map((row) => row.url),
    );

    const marked = bundle.links.filter((link) => link.pinRank !== undefined);
    expect(marked.length).toBe(raw.pinnedLinks.length);
    for (const link of marked) expect(pinnedUrls.has(link.url)).toBe(true);
    expect(bundle.links).toHaveLength(rawLinks.length);

    // Zero-padded, so they still sort in the file's order past nine.
    const ranks = marked.map((link) => link.pinRank ?? '');
    expect([...ranks].sort()).toEqual(ranks.slice().sort((a, b) => a.localeCompare(b)));
  });

  // No bytes cross, and this specimen is the one that turns that from a policy
  // into a fact: it was re-exported after uploading a custom image to a link, and
  // the image is NOWHERE in the file — no `data:` URI, no base64 run. A
  // collection's link rows carry no `image`/`preview` key at all; only the three
  // pinned rows do, and what they hold is a server-side path
  // (`archives/341597/4842862.jpeg`) that means nothing outside that instance.
  // Re-fetching one is the single thing an import must never do.
  it('carries no image bytes, because the producer exports none', () => {
    expect(bundle.images.size).toBe(0);
    expect(EXPORT).not.toMatch(/data:[a-z]+\//);
    expect(EXPORT).toMatch(/"image":\s*"archives\//);
  });

  // A note is BLOCK text — the specimen's one typed note is three paragraphs, and
  // a collapse that is right for a title would run them together.
  it('keeps the blank lines inside a typed note', () => {
    const noted = bundle.links.filter((link) => link.note !== undefined);
    expect(noted).toHaveLength(1);
    expect(noted[0].note).toContain('\n\n');

    // Every other row's `description` is `""` in the file — LinkWarden fills
    // `metaDescription` from the page and leaves `description` to the user — so a
    // note-per-`description` reading would have put an empty note on 24 rows.
    expect(rawLinks.filter((row) => row.description.trim() !== '')).toHaveLength(1);
  });

  // A real library has duplicates in it — this one holds 25 rows over 18 distinct
  // resources, including an exact pair inside one collection and a pair whose
  // titles differ because one was renamed. The parser emits all of them ON
  // PURPOSE: dedupe is the orchestrator's job, against the library and the file at
  // once (data-lifecycle.md), and a parser that deduped here would hide from it
  // which rows the file actually declared.
  it('emits duplicate rows rather than deduping, which the orchestrator does', () => {
    const keys = bundle.links.map((link) => canonicalUrlKey(link.url));
    expect(keys).toHaveLength(25);
    expect(new Set(keys).size).toBeLessThan(keys.length);
  });

  // Not an endorsement — a record. A page title can carry a bidi control (this one
  // has an unbalanced U+202D), and nothing on our side strips it: `cleanTitle`
  // collapses whitespace only. Contained to the title element, so cosmetic today;
  // this case is here so that a future sanitizer changes it deliberately rather
  // than the fixture changing under one.
  it('passes a bidi control character in a title through untouched', () => {
    const titles = bundle.links.map((link) => link.customTitle ?? '');
    expect(titles.filter((title) => title.includes('‭'))).toHaveLength(1);
  });
});

// One rung downstream of the parser, because two of this file's names only mean
// something once they meet the library's own taxonomy.
describe('the same backup through the projection', () => {
  const projected = projectImportedLinks({
    rows: bundle.links,
    lists: SYSTEM_LIST_DEFAULTS.map((list) => ({ ...list })),
    tags: [],
    existingPinRanks: [],
    images: bundle.images,
    newId: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
    now: 1_700_000_000_000,
  });
  const links = projected.entries
    .filter((entry) => entry.path.startsWith(LINKS_PREFIX))
    .map((entry) => entry.data as Link);

  // The specimen's `archive` collection (lowercase, the user's own) matches the
  // system Archive list by case-insensitive name — the intended reading of a
  // folder called Archive, and until this file nothing pinned it. Trash would NOT
  // match, which is the asymmetry `ListResolver` exists to hold.
  it('resolves a collection named `archive` into the system Archive list', () => {
    const archived = links.filter((link) => link.listId === ARCHIVE_ID);
    expect(archived).toHaveLength(3);
    // Not a new list wearing the name.
    expect(projected.entries.some((entry) => entry.path.includes('/archive'))).toBe(false);
  });

  // Everything else is an ordinary folder, including LinkWarden's catch-all
  // collection — it carries no flag in the file, so there is nothing to recognize
  // and nothing that lands in the default list by accident.
  it('mints the rest as ordinary lists, with nothing falling into My List', () => {
    expect(links.filter((link) => link.listId === MY_LIST_ID)).toHaveLength(0);
    expect(projected.listCount).toBeGreaterThan(0);
  });
});
