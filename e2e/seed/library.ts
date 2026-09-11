import {
  ARCHIVE_ID,
  type BackupCounts,
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
  TRASH_ID,
} from '@stxapps/shared';

import type { SeedUser } from './catalog';
import { previewPng } from './png';

// The generated library — entities first, bytes second. Pure: no zip, no disk, no
// browser. seed/archive.ts turns what this returns into the archive.
//
// It builds the ENTITIES a Bracemark backup carries, not the rows a UI shows, and
// that is the whole reason the seed works this way: a backup restores `items.jsonl`
// verbatim through the normal write edge (docs/data-lifecycle.md), so anything
// expressible here is a state the app can really be in — including states the UI
// cannot easily be driven into by hand (a failed extraction, a link in Trash, a
// three-deep list tree).
//
// The one thing it may NOT do is invent shapes: every entity below is typed
// against `@stxapps/shared`'s schemas, which is also what `classifyBundleLine`
// gates the import on. A field this file gets wrong is dropped at import as an
// unreadable line — silently, one line at a time — so the types are load-bearing,
// not decoration.

// The vocabulary. Everything a seeded library says comes from these three banks,
// and they are sized so the distribution is KNOWABLE: topic `i % TOPICS.length`
// and host `i % HOSTS.length` mean a 1000-link library holds exactly 42 or 41
// links per topic, spread over every host. That is what makes the seed useful for
// checking search — "rust" is not "some results", it is a number you can predict
// and count, on every re-seed, on every machine.
const TOPICS = [
  'rust',
  'typescript',
  'postgres',
  'sqlite',
  'kubernetes',
  'wasm',
  'graphql',
  'redis',
  'python',
  'elixir',
  'swift',
  'kotlin',
  'terraform',
  'observability',
  'cryptography',
  'compilers',
  'databases',
  'networking',
  'accessibility',
  'typography',
  'animation',
  'testing',
  'security',
  'caching',
];

const HOSTS = [
  'example.com',
  'blog.example.org',
  'docs.example.net',
  'news.example.io',
  'lab.example.dev',
  'notes.example.co',
  'wiki.example.com',
  'papers.example.org',
  'talks.example.net',
  'zine.example.io',
  'handbook.example.dev',
  'archive.example.co',
  'weekly.example.com',
  'digest.example.org',
  'journal.example.net',
  'field.example.io',
  'atlas.example.dev',
  'ledger.example.co',
];

// Title shapes, rotated so a page of rows doesn't read as one sentence repeated.
// Deliberately ordinary phrasing: the point is to look like a bookmark list, not
// to be recognisably generated.
const SHAPES = [
  (topic: string) => `A field guide to ${topic}`,
  (topic: string) => `${cap(topic)} in production`,
  (topic: string) => `What nobody tells you about ${topic}`,
  (topic: string) => `${cap(topic)} — the parts that matter`,
  (topic: string) => `Notes on ${topic}, six months in`,
  (topic: string) => `Rewriting our ${topic} layer`,
  (topic: string) => `${cap(topic)} for people in a hurry`,
  (topic: string) => `The case against ${topic}`,
];

// The list tree, spelled out rather than derived.
//
// An earlier version took a flat list of names and picked each node's parent by
// index, which is a fine way to produce a tree and a terrible way to produce a
// READABLE one — it filed Recipes under Talks and Music under Backend. You spend
// this seed's whole life looking at the sidebar, and a hierarchy that means
// nothing is one you stop trusting: the first time a drag lands somewhere odd you
// cannot tell the bug from the fixture. So the shape is the data.
//
// It is sliced BREADTH-FIRST to whatever the catalog asks for, which is what makes
// one literal serve both plans: a nested account takes the whole tree, and a flat
// one takes the roots — the eight real categories. A flat slice forces every
// `parentId` to null, because a free account cannot create nesting
// (`nestedLists`) and must not be handed some.
interface TreeSpec {
  name: string;
  children?: TreeSpec[];
}

const LIST_TREE: TreeSpec[] = [
  { name: 'Reading list', children: [{ name: 'Read later' }, { name: 'Longreads' }] },
  { name: 'Reference', children: [{ name: 'Papers' }, { name: 'Talks' }] },
  {
    name: 'Engineering',
    children: [
      { name: 'Frontend' },
      { name: 'Backend' },
      // The one three-deep branch, and it is here on purpose: reparenting a
      // grandchild is the drag the tree is most likely to get wrong, and a
      // two-level fixture cannot ask for it.
      { name: 'Infrastructure', children: [{ name: 'Databases' }, { name: 'Security' }] },
      { name: 'Tooling' },
    ],
  },
  { name: 'Design', children: [{ name: 'Design systems' }] },
  { name: 'Personal', children: [{ name: 'Recipes' }, { name: 'Travel' }, { name: 'Finance' }] },
  { name: 'Media', children: [{ name: 'Music' }, { name: 'Photography' }] },
  { name: 'Career' },
  { name: 'Inbox triage' },
];

// Tags are FLAT, on every plan. The entity carries a `parentId` (it is the same
// shape as a List), but tag hierarchy is a planned lever, not a shipped one
// (plans.ts, _PLANNED, NOT YET GATED_): nothing in the product mints a tag
// parent — the Tags settings section in both apps renders only the root group,
// and the import mints every tag at the root (docs/data-lifecycle.md). So a nested
// tag is the same impossible state a nested free list is, and worse to be handed:
// the children vanish from Settings, and the parents there cannot be deleted
// (destroy rejects a tag with sub-tags). When tag hierarchy ships, this becomes a
// TreeSpec like LIST_TREE and `buildTags` passes `user.nested`.
//
// The slice is a prefix, so the order is the plan split: the first 14 are what a
// free account gets, and they are the everyday labels — the ones a small library
// actually uses — before the subject tags a big one accumulates.
const TAG_NAMES: string[] = [
  'to-read',
  'to-watch',
  'favourite',
  'work',
  'personal',
  'research',
  'reference',
  'tutorial',
  'deep-dive',
  'quick-read',
  'design',
  'security',
  'video',
  'podcast',
  // Free ends here.
  'archive-me',
  'inspiration',
  'opinion',
  'rust',
  'typescript',
  'python',
  'sql',
  'kotlin',
  'swift',
  'ux',
  'a11y',
  'perf',
  'privacy',
  'testing',
  'tool',
  'library',
  'framework',
  'benchmark',
  'ci',
  'deploy',
  'paper',
  'thread',
  'postmortem',
  'longform',
  'news',
  'side-project',
];

export interface SeedLibrary {
  // One `{ path, data }` per items.jsonl line.
  items: { path: string; data: object }[];
  // The `files/{id}` blobs the extractions above reference.
  files: { id: string; bytes: Uint8Array }[];
  counts: BackupCounts;
}

export interface BuildOptions {
  // The instant the library is anchored to — the newest link's `updatedAt`.
  // Passed in rather than read here so the caller owns the one axis of this
  // generator that is NOT deterministic (see the note on timestamps below).
  now: number;
}

export function buildLibrary(user: SeedUser, options: BuildOptions): SeedLibrary {
  const random = mulberry32(hashSeed(user.key));
  const items: { path: string; data: object }[] = [];
  const files: { id: string; bytes: Uint8Array }[] = [];

  const lists = buildLists(user, options.now);
  const tags = buildTags(user, options.now);
  for (const list of lists) items.push({ path: pathFromId(list.id, LISTS_PREFIX), data: list });
  for (const tag of tags) items.push({ path: pathFromId(tag.id, TAGS_PREFIX), data: tag });

  // Where a link can live. User lists carry most of it; the three system lists
  // are seeded too, because a My List / Archive / Trash that is empty on a
  // thousand-link account is the one thing a real library never looks like — and
  // Trash in particular gates behaviour (restore, delete-permanently) you cannot
  // check on an account that has none.
  const listIds = [...lists.map((l) => l.id), MY_LIST_ID, ARCHIVE_ID, TRASH_ID];

  // Timestamps are the ONE thing here that isn't a pure function of `user.key`:
  // they walk backwards from `now`, so a freshly seeded library reads as one
  // someone has been keeping rather than an archive from whenever this file was
  // written. Everything you would ever assert on or search for — ids, urls,
  // titles, tags, list membership — is fixed. The step is ~3.7h, so a thousand
  // links spans about five months.
  const STEP_MS = 3.7 * 60 * 60 * 1000;

  let extractionCount = 0;
  for (let i = 0; i < user.links; i++) {
    const id = `seed-link-${pad(i, 4)}`;
    const topic = TOPICS[i % TOPICS.length];
    const host = HOSTS[i % HOSTS.length];
    const title = SHAPES[i % SHAPES.length](topic);
    const createdAt = Math.round(options.now - i * STEP_MS);
    const updatedAt = createdAt + (i % 5) * 30 * 60 * 1000;

    // ~4% Trash, ~8% Archive, the rest across user lists and My List. Picked by
    // the seeded PRNG rather than `i % n` so list sizes vary the way a real
    // library's do instead of coming out suspiciously even.
    const roll = random();
    const listId =
      roll < 0.04
        ? TRASH_ID
        : roll < 0.12
          ? ARCHIVE_ID
          : listIds[Math.floor(random() * (listIds.length - 2))];

    const tagIds = pickTags(tags, random);

    const link: Link = {
      url: `https://${host}/${topic}/${slug(title)}-${i}`,
      listId,
      tagIds,
      createdAt,
      updatedAt,
      // Every 7th link carries a user override, so the display resolution
      // `customTitle ?? extraction.title ?? host(url)` has all three arms
      // represented in one library.
      ...(i % 7 === 3 ? { customTitle: `${title} (my copy)` } : {}),
      ...(i % 5 === 2 ? { note: noteFor(topic, i) } : {}),
    };
    items.push({ path: pathFromId(id, LINKS_PREFIX), data: link });

    // The machine half. Every 11th link's extraction FAILED and every 23rd is
    // permanent — both of which render as `host(url)` with a monogram, which is
    // a steady state the app is designed for and the one you would otherwise
    // never see on a seeded account.
    const failed = i % 11 === 5;
    const permanent = i % 23 === 9;
    const done = !failed && !permanent;
    const imageId = done && i % 3 === 0 ? `seed-image-${pad(i, 4)}` : undefined;
    if (imageId) files.push({ id: imageId, bytes: previewPng(i) });

    const extraction: Extraction = {
      id,
      ...(done ? { title } : {}),
      ...(imageId ? { imageId } : {}),
      facets: {
        titleImage: {
          status: permanent ? 'permanent' : failed ? 'failed' : 'done',
          extractedBy: 'extension:fg',
          extractedAt: updatedAt,
          attempts: done ? 1 : 2,
        },
      },
      createdAt,
      updatedAt,
    };
    items.push({ path: pathFromId(id, EXTRACTIONS_PREFIX), data: extraction });
    extractionCount++;
  }

  // Pins, spread through the library rather than taken off the top, so the pinned
  // block above the list is visibly not just "the newest links".
  const pinRanks = ranksBetween(null, null, Math.max(user.pins, 1));
  for (let p = 0; p < user.pins && p < user.links; p++) {
    const index = (p * 37) % user.links;
    const pin: Pin = {
      id: `seed-link-${pad(index, 4)}`,
      rank: pinRanks[p],
      createdAt: options.now,
      updatedAt: options.now,
    };
    items.push({ path: pathFromId(pin.id, PINS_PREFIX), data: pin });
  }

  // A real backup carries the settings blob, so this one does too. The only field
  // set is the one that matters on a seeded account: `deviceExtractionMode: 'off'`
  // means a device that opens this library never fetches any of the (real,
  // reachable) hosts above. Web ignores the field — bracemark-expo is what reads
  // it — and the default ('saves') would already spare imported links; this makes
  // it true even if someone flips the account to 'all' to test extraction, at
  // which point turning it back on in Settings is the deliberate gesture.
  const settings: SettingsGeneral = {
    deviceExtractionMode: 'off',
    createdAt: options.now,
    updatedAt: options.now,
  };
  items.push({ path: SETTINGS_GENERAL_PATH, data: settings });

  const counts: BackupCounts = {
    links: user.links,
    lists: lists.length,
    tags: tags.length,
    pins: Math.min(user.pins, user.links),
    extractions: extractionCount,
    files: files.length,
  };

  return { items, files, counts };
}

// --- the trees ----------------------------------------------------------------

// `List` and `Tag` are the same shape by design (entities.ts), which is what lets
// one builder serve both. Named here so neither call site reads as "a tag is a
// list" — if the two schemas ever diverge, this alias is where it breaks.
type TreeNode = List & Tag;

function buildLists(user: SeedUser, now: number): List[] {
  return buildTree(LIST_TREE, 'seed-list', user.lists, user.nested, now);
}

// `nested: false` whatever the account — see TAG_NAMES.
function buildTags(user: SeedUser, now: number): Tag[] {
  const spec = TAG_NAMES.map((name) => ({ name }));
  return buildTree(spec, 'seed-tag', user.tags, false, now);
}

// Walk a TreeSpec breadth-first, take the first `count`, and stamp ids, parents
// and ranks.
//
// Breadth-first is what makes the slice safe: a node is only ever reached after
// its parent, so any prefix of the walk is a complete tree with no dangling
// `parentId`. (Dangling ones are survivable — buildTree in the read layer
// promotes them to root — but a fixture that relied on that would be testing the
// recovery path by accident.)
//
// Ranks come from `ranksBetween` per SIBLING GROUP: the same fractional keyspace
// (sync/rank.ts) the app mints into, so the first drag in the UI computes a key
// between two of these rather than tripping over an invented format.
function buildTree(
  spec: TreeSpec[],
  idPrefix: string,
  count: number,
  nested: boolean,
  now: number,
): TreeNode[] {
  if (count === 0) return [];

  const entities: TreeNode[] = [];
  const queue: { node: TreeSpec; parentId: string | null }[] = spec.map((node) => ({
    node,
    parentId: null,
  }));

  while (entities.length < count) {
    const next = queue.shift();
    // The spec ran out before the catalog's count did — a fixture bug, but a
    // smaller tree is a better failure than a crash on an empty queue.
    if (!next) break;
    const { node, parentId } = next;
    const id = `${idPrefix}-${pad(entities.length, 2)}`;
    entities.push({
      id,
      name: node.name,
      // Flat accounts get a flat tree, whatever the spec says — see the note on
      // the literals above.
      parentId: nested ? parentId : null,
      rank: '', // filled per sibling group below
      createdAt: now,
      updatedAt: now,
    });
    for (const child of node.children ?? []) queue.push({ node: child, parentId: id });
  }

  const groups = new Map<string, TreeNode[]>();
  for (const entity of entities) {
    const key = entity.parentId ?? '';
    const group = groups.get(key);
    if (group) group.push(entity);
    else groups.set(key, [entity]);
  }
  for (const siblings of groups.values()) {
    const ranks = ranksBetween(null, null, siblings.length);
    siblings.forEach((entity, i) => {
      entity.rank = ranks[i];
    });
  }

  return entities;
}

// --- odds and ends ------------------------------------------------------------

// Between zero and three tags, weighted so most links have one or two — an
// untagged link and an over-tagged one are both worth having on screen.
function pickTags(tags: Tag[], random: () => number): string[] {
  if (tags.length === 0) return [];
  const roll = random();
  const count = roll < 0.18 ? 0 : roll < 0.62 ? 1 : roll < 0.9 ? 2 : 3;
  const picked = new Set<string>();
  while (picked.size < count) picked.add(tags[Math.floor(random() * tags.length)].id);
  return [...picked];
}

function noteFor(topic: string, i: number): string {
  const notes = [
    `Skim the middle section — the ${topic} benchmark at the end is the useful bit.`,
    `Came up in review. Worth re-reading before we touch ${topic} again.`,
    `Disagree with most of this, but the ${topic} framing is a good one to argue with.`,
    `Saved for the diagrams. The ${topic} walkthrough starts about halfway down.`,
  ];
  return notes[i % notes.length];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function cap(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// A seeded PRNG, so "random-looking" and "the same every time" are both true.
// mulberry32 — small, fast, and good enough for choosing which tag goes on which
// link; nothing here is security-sensitive.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
