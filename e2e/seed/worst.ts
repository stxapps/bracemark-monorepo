import {
  ARCHIVE_ID,
  cleanName,
  cleanTitle,
  type Extraction,
  EXTRACTIONS_PREFIX,
  type Link,
  LINK_NOTE_MAX,
  LINK_TAGS_MAX,
  LINKS_PREFIX,
  type List,
  LIST_NAME_MAX,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  type Pin,
  PINS_PREFIX,
  ranksBetween,
  SETTINGS_GENERAL_PATH,
  type SettingsGeneral,
  type Tag,
  TAG_NAME_MAX,
  TAGS_PREFIX,
  TRASH_ID,
  TREE_MAX_DEPTH,
} from '@stxapps/shared';

import {
  type BuildOptions,
  buildTree,
  pad,
  rootListCeiling,
  type SeedLibrary,
  type TreeSpec,
} from './library';
import { previewPng, type PreviewShape } from './png';

// THE WORST-CASE LIBRARY — the `plus-worst` dev account, and the data the
// `break-ui` skill (.claude/skills/break-ui/) points a screen at.
//
// ./library.ts generates a library that looks like a bookmark list: titles that
// fit on a line, hosts that read cleanly, two tags a link. That is the right
// fixture for paging and search, and it is KIND data — every screen in the app
// was built against something like it. This one is the opposite on purpose:
// every value a link, list or tag can render, at the worst a real library
// actually produces.
//
// Two rules decide what may go in, and they are the skill's rules too:
//
//   1. PLAUSIBLE OR AT THE LIMIT, never random. Every value is either something a
//      real page, import or person produces — an Arabic og:title, a tracking URL
//      pasted from a newsletter, a bookmark folder nested by re-importing a
//      browser export into itself — or sits exactly at the bound the writers
//      enforce (docs/data-limits.md, _what is bounded_). The bounds are imported,
//      not re-spelled, and the cut is made by the writers' own `cleanTitle` /
//      `cleanName`: this is a WRITER standing in for the editors and the
//      extractor, like ./archive.ts, never an oracle a spec asserts against.
//   2. A STATE THE PRODUCT REACHES. Nothing here is hand-made garbage the app
//      could not hold — the url a user confirm-saved raw is `normalizeUrl`'s
//      documented soft-null path, the absent preview blob is the manifest's own
//      `omitted` record, the future date is another device's clock. A worst case
//      the product cannot produce would report a "bug" nobody can hit.
//
// The first rows are where the breaks are spread, because the first screen is
// what gets looked at: one failure per row, mixed, the way a real library mixes
// them — not every worst case stacked into row one.
//
// Hosts are `.invalid` / `.test` (RFC 2606, RFC 6761), so nothing here resolves:
// no extraction retry, from any client, can reach a real site.

// --- lists ---------------------------------------------------------------------

// The deep chain: what a browser export re-imported into a browser that already
// held it produces — "Imported" > "Bookmarks bar" > "Imported" > … — which is how
// real libraries get deep at all. Exactly TREE_MAX_DEPTH levels, the deepest the
// import and restore place (sync/tree.ts), so the link filed at its bottom is the
// longest breadcrumb and the deepest "Move to" row the app can be handed.
function deepChain(levels: number): TreeSpec {
  const name = (level: number) => (level % 2 === 1 ? 'Imported' : 'Bookmarks bar');
  let node: TreeSpec = { name: name(levels) };
  for (let level = levels - 1; level >= 1; level--) node = { name: name(level), children: [node] };
  return node;
}

// The key is how a link below files itself; the name is what the sidebar shows.
const LIST_SPECS = {
  // At LIST_NAME_MAX, cut where the create field stops typing — a project folder
  // named the way people name shared folders.
  longName: cleanName(
    'Client work — Northwind Industries Holdings — onboarding research, interview notes, ' +
      'competitive teardown and everything we collected before the Q3 redesign kickoff ' +
      '(do not delete, shared with legal and the procurement team until the audit closes)',
    LIST_NAME_MAX,
  ),
  rtl: 'قراءات لاحقة',
  cjk: 'あとで読む・技術記事まとめ',
  emoji: '🦊 Side projects',
  oneLetter: 'A',
  compound: 'Steuererklärungsunterlagen',
  // A user list that shares its name with a system list — a Netscape or Raindrop
  // import carries its own "Archive" folder, and the two then sit in one sidebar.
  archiveTwin: 'Archive',
  // Holds exactly one link: "1 link", never "1 links".
  one: 'Taxes',
  // Holds none: the empty state inside a user list, not the first-run one.
  empty: 'Someday',
} as const;

type ListKey = keyof typeof LIST_SPECS | 'deepest';

const LIST_TREE: TreeSpec[] = [
  ...Object.values(LIST_SPECS).map((name) => ({ name })),
  deepChain(TREE_MAX_DEPTH),
];

// --- tags ----------------------------------------------------------------------

const TAG_SPECS = {
  toRead: 'to-read',
  oneLetter: 'a',
  emojiOnly: '⭐',
  cjk: '読む',
  rtl: 'مهم',
  // No spaces, so nowhere to wrap: wider than a chip column at 320px.
  unbreakable: 'customer-feedback-from-enterprise-onboarding',
  // Cut to TAG_NAME_MAX by the writer — a tag that is really a sentence, the
  // shape a Pocket or Pinboard import hands over when someone used tags as notes.
  sentence: cleanName(
    'articles I keep meaning to send to the team before the planning meeting but never ' +
      'quite get around to, mostly about estimation, roadmaps, saying no to scope, and ' +
      'why every migration takes three times longer than the plan said it would',
    TAG_NAME_MAX,
  ),
  // Case twins: an import matches tag names exactly, so two files' spellings
  // become two tags that look like one in a chip.
  designUpper: 'Design',
  designLower: 'design',
  via: 'via:hn',
} as const;

type TagKey = keyof typeof TAG_SPECS;

// The bulk that takes the count to LINK_TAGS_MAX, so one link can carry every tag
// an import gives it: Pinboard-style year tags and the ordinary subject words a
// heavy tagger accumulates.
const YEAR_TAGS = Array.from({ length: 17 }, (_, i) => String(2010 + i));
const WORD_TAGS = [
  'rust typescript python go sql postgres sqlite redis kafka kubernetes ',
  'docker terraform aws cloudflare wasm graphql grpc http dns tls crypto ',
  'privacy security auth testing ci perf caching ux a11y css fonts typography ',
  'color animation react svelte swift kotlin android ios compilers parsers ',
  'math stats ml llm search maps audio video photography cooking travel ',
  'finance health books history career hiring management writing talks papers ',
  'postmortem opinion tutorial reference tool library longform thread news',
]
  .join('')
  .split(' ');
const BULK_TAGS = [...YEAR_TAGS, ...WORD_TAGS].slice(
  0,
  LINK_TAGS_MAX - Object.keys(TAG_SPECS).length,
);
const TAG_NAMES = [...Object.values(TAG_SPECS), ...BULK_TAGS];

// --- links ---------------------------------------------------------------------

type Image = 'tile' | 'missing' | PreviewShape;

interface LinkSpec {
  slug: string;
  url: string;
  // The extracted title. Absent with no `status` means a `done` extraction of a
  // page that had no title at all — the row falls back to the url.
  title?: string;
  customTitle?: string;
  note?: string;
  tags?: TagKey[] | 'all';
  list?: ListKey | typeof ARCHIVE_ID | typeof TRASH_ID;
  image?: Image;
  // A failed extraction (retried later) or a permanent one (never again) — both
  // render the host and a monogram.
  status?: 'failed' | 'permanent';
  pinned?: boolean;
  // Overrides the row's place in the timeline: ms from `now`, or an absolute
  // epoch for a date that must not move with it.
  at?: number;
  on?: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Display order, newest first. The default sort is by date, and every link's
// `updatedAt` equals its `createdAt`, so this order holds on either sort key.
const LINK_SPECS: LinkSpec[] = [
  {
    // Another device's clock ran three days fast. Sorts above everything, and
    // its relative date is in the future.
    slug: 'clock-skew',
    url: 'https://calendar.example.invalid/events/team-offsite-2026',
    title: 'Team offsite — agenda and travel',
    at: 3 * DAY,
  },
  {
    // At LINK_TITLE_MAX, cut mid-word the way the extractor cuts an og:title.
    slug: 'title-at-cap',
    url: 'https://journal.example.invalid/2026/10/large-scale-study-of-sleep-and-memory',
    title: cleanTitle(
      'A large-scale longitudinal study of sleep duration, sleep timing and memory ' +
        'consolidation across adolescence and early adulthood: evidence from wearable ' +
        'actigraphy, repeated cognitive testing and a randomised intervention in ' +
        'twelve secondary schools, with implications for school start times, exam ' +
        'scheduling and public health guidance — full text, supplementary data and ' +
        'reviewer comments',
    ),
    tags: ['toRead', 'unbreakable', 'cjk'],
    image: 'tile',
    pinned: true,
    at: 0,
  },
  {
    // Done, but the page had no <title>: the row shows the url, and this one is a
    // tracking link pasted out of a newsletter — no spaces, nowhere to wrap.
    slug: 'tracking-url',
    url:
      'https://shop.example.invalid/products/ergonomic-split-keyboard-wireless-low-profile-' +
      'hot-swappable-black?variant=40912345678901&utm_source=newsletter&utm_medium=email' +
      '&utm_campaign=2026-10-weekly-digest-autumn-sale&utm_content=hero-cta-button-variant-b' +
      '&utm_term=split+keyboard&fbclid=IwAR3xk9QmVvZ2xlU2VhcmNoQ29uc29sZUxpbmtDbGljaw' +
      '&gclid=Cj0KCQjw8O-VBhCpARIsACMvVLNk2a9q3XbYz1',
    at: -1 * MINUTE,
  },
  {
    // RTL with a Latin word and a number inside it — bidi, not just direction.
    slug: 'rtl',
    url: 'https://blog.example.invalid/ar/kubernetes-home-server',
    title: 'كيفية إعداد Kubernetes على خادم منزلي: دليل شامل في 12 خطوة',
    note: 'جرّبت الخطوات حتى الخطوة السابعة. الشبكة تحتاج إعدادًا مختلفًا على الراوتر.',
    tags: ['rtl', 'toRead'],
    image: 'tile',
    pinned: true,
    at: -1 * HOUR,
  },
  {
    // CJK, no spaces: the line breaker may break anywhere, and a two-line clamp
    // fills edge to edge.
    slug: 'cjk',
    url: 'https://tech.example.invalid/articles/typescript-monorepo-typecheck',
    title:
      '大規模なTypeScriptモノレポにおける型チェック時間を半分にした方法とその過程で学んだこと（2026年版）',
    tags: ['cjk'],
    at: -1 * DAY,
  },
  {
    // A title the user typed, starting with a skin-toned ZWJ emoji — `.length`
    // is 7 before the first letter, and `charAt(0)` is half a surrogate pair.
    slug: 'emoji-first',
    url: 'https://notes.example.invalid/side-projects/one-a-month',
    title: 'One side project a month for a year',
    customTitle: '👩🏽‍💻 Shipping a side project every month for a year 🚀',
    tags: ['emojiOnly'],
    list: 'emoji',
  },
  {
    // Double-escaped by the site itself: the row must show the entities as text,
    // not decode them, and never render the markup.
    slug: 'entities',
    url: 'https://archive.example.invalid/cartoons/tom-and-jerry',
    title:
      'Tom &amp; Jerry: The &lt;b&gt;Complete&lt;/b&gt; Collection | Archive &#8211; Classic Cartoons',
    image: { width: 1200, height: 80 },
  },
  {
    // Stacked Vietnamese diacritics — clipped by a tight line-height under
    // `overflow: hidden`.
    slug: 'vietnamese',
    url: 'https://recipes.example.invalid/vi/pho-bo-ha-noi',
    title: 'Đặng Thị Ngọc Hân: Hướng dẫn nấu phở bò Hà Nội chuẩn vị',
    tags: ['oneLetter'],
  },
  {
    // Thai has no spaces and tall marks above and below; the url is the same
    // title percent-encoded, which is what a Thai article's address looks like.
    slug: 'thai',
    url:
      'https://wiki.example.invalid/wiki/%E0%B8%A7%E0%B8%B4%E0%B8%98%E0%B8%B5%E0%B8%95%E0%B8%B1' +
      '%E0%B9%89%E0%B8%87%E0%B8%84%E0%B9%88%E0%B8%B2%E0%B9%80%E0%B8%A3%E0%B8%B2%E0%B9%80%E0%B8' +
      '%95%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%97%E0%B8%B5%E0%B9%88%E0%B8%9A%E0%B9%89%E0%B8%B2%E0' +
      '%B8%99',
    title: 'วิธีตั้งค่าเราเตอร์ที่บ้านให้เร็วขึ้นโดยไม่ต้องซื้ออุปกรณ์ใหม่',
    image: { width: 80, height: 1200 },
  },
  {
    // One word too long for a narrow column, with nowhere to break inside it.
    slug: 'compound',
    url: 'https://versicherung.example.invalid/vergleich/rechtsschutz',
    title: 'Rechtsschutzversicherungsgesellschaften im Vergleich: Kündigungsfristen',
    tags: ['designUpper', 'designLower'],
    list: 'compound',
  },
  // Three identical, one-word titles — the og:title of every site's front page.
  // The host is the only thing that tells them apart.
  { slug: 'home-1', url: 'https://studio.example.invalid/', title: 'Home' },
  { slug: 'home-2', url: 'https://bakery.example.invalid/', title: 'Home', image: 'tile' },
  { slug: 'home-3', url: 'https://www.example.test/', title: 'Home' },
  {
    // An internationalised host that never answered: the host fallback renders
    // whatever form the url is stored in.
    slug: 'idn',
    url: 'https://例え.テスト/ブログ/2026/10/秋の旅行記',
    status: 'permanent',
  },
  {
    // `host:port` with no scheme — `normalizeUrl` refuses it, and the add form
    // lets the user confirm-and-save the raw text anyway (url/url.ts). There is
    // no host to parse.
    slug: 'raw-text',
    url: 'nas.home.invalid:5000/photo',
    status: 'permanent',
    note: 'Only works on the home wifi.',
  },
  {
    slug: 'note-at-cap',
    url: 'https://docs.example.invalid/handbook/incident-response',
    title: 'Incident response handbook',
    // At LINK_NOTE_MAX, where the edit field stops typing — multi-line, with an
    // unbreakable url in the middle of it.
    note: (
      'Read before the on-call rotation starts.\n\n' +
      'Sections 2 and 5 are out of date — the escalation tree changed when the platform ' +
      'team split, and the paging policy now lives at ' +
      'https://wiki.example.invalid/platform/on-call/escalation-policy-2026?version=14#paging\n\n' +
      'Things to raise at the retro: the status page took 25 minutes to update, nobody ' +
      'knew who owned the database failover, and the runbook assumed a VPN that half the ' +
      'team no longer has. Also ask whether the customer comms template can be shortened, ' +
      'because the last one was four paragraphs before it said what was broken and what ' +
      'people should do about it in the meantime.'
    ).slice(0, LINK_NOTE_MAX),
    tags: ['sentence'],
  },
  {
    // Every tag an import gives one link: the chip row's "+N" at its largest.
    slug: 'every-tag',
    url: 'https://bookmarks.example.invalid/export/pinboard-favourites',
    title: 'Pinboard favourites (imported)',
    tags: 'all',
    pinned: true,
  },
  {
    // A user rename to two letters, over a long extracted title it hides.
    slug: 'short-custom-title',
    url: 'https://forum.example.invalid/t/what-is-the-best-way-to-structure-a-monorepo/88412',
    title: 'What is the best way to structure a monorepo with shared packages and apps?',
    customTitle: 'ok',
    tags: ['via'],
  },
  {
    // A logo with a transparent background: invisible on the theme it matches.
    slug: 'transparent-logo',
    url: 'https://brand.example.invalid/press-kit',
    title: 'Press kit and logo downloads',
    image: { transparent: true },
  },
  {
    // The preview's blob is not in the archive — an export that could not
    // download it says so in the manifest (`omitted`). The row has an imageId
    // and nothing to show.
    slug: 'missing-image',
    url: 'https://photos.example.invalid/albums/autumn-2026',
    title: 'Autumn 2026 — shared album',
    image: 'missing',
  },
  {
    // Failed for now (behind a VPN), to be retried.
    slug: 'failed',
    url: 'https://intranet.corp.invalid/wiki/Onboarding',
    status: 'failed',
  },
  // The same page twice: the urls differ only at the END, so an end-truncated url
  // shows two identical rows.
  {
    slug: 'trailing-slash-a',
    url: 'https://docs.example.invalid/guides/getting-started/installation',
    title: 'Getting started — Docs',
  },
  {
    slug: 'trailing-slash-b',
    url: 'https://docs.example.invalid/guides/getting-started/installation/',
    title: 'Getting started — Docs',
  },
  {
    // A bookmark from a 2009 Delicious export: a date far enough back that a
    // relative date must give way to an absolute one. It sorts to the bottom of
    // My List, below the filler.
    slug: 'decades-old',
    url: 'https://delicious.example.invalid/2009/css-sprites',
    title: 'CSS sprites: image slicing’s kiss of death',
    on: Date.UTC(2009, 2, 14, 9, 30),
  },
  // The rest of the lists' contents, and the two system lists.
  {
    slug: 'deepest',
    url: 'https://bookmarks.example.invalid/very/old/folder',
    title: 'Filed one hundred folders deep',
    list: 'deepest',
  },
  {
    slug: 'only-one',
    url: 'https://tax.example.invalid/2026/self-assessment-deadlines',
    title: 'Self-assessment deadlines 2026',
    list: 'one',
  },
  {
    slug: 'long-list',
    url: 'https://research.example.invalid/interviews/round-2',
    title: 'Interview synthesis — round 2',
    list: 'longName',
  },
  {
    slug: 'rtl-list',
    url: 'https://news.example.invalid/ar/tech-weekly',
    title: 'النشرة التقنية الأسبوعية',
    list: 'rtl',
  },
  {
    slug: 'cjk-list',
    url: 'https://tech.example.invalid/articles/rust-async',
    title: 'Rustの非同期処理を理解する',
    list: 'cjk',
  },
  {
    slug: 'one-letter-list',
    url: 'https://example.test/a',
    title: 'A',
    list: 'oneLetter',
  },
  {
    slug: 'archive-twin',
    url: 'https://old.example.invalid/2018/notes',
    title: 'Notes from 2018',
    list: 'archiveTwin',
  },
  {
    slug: 'system-archive',
    url: 'https://news.example.invalid/2025/annual-review',
    title: 'The year in review',
    list: ARCHIVE_ID,
  },
  {
    slug: 'trash',
    url: 'https://ads.example.invalid/landing',
    title: 'Limited offer!!! 🔥🔥🔥',
    list: TRASH_ID,
  },
];

// My List is the landing view, so it is the one sized to the paging boundary:
// two full pages and one row more (both apps' PAGE_SIZE is 50), so the last
// "Show more" loads a single link. Ordinary links make up the difference, after
// the worst rows — they are what the worst cases sit among, not the subject.
const MY_LIST_LINKS = 101;

const FILLER_TITLES = [
  'Weeknight dinners in thirty minutes',
  'A short history of the shipping container',
  'Why your database is slow',
  'Notes',
  'The quiet joy of reading the manual',
  'How we cut our build times in half',
  'Bike maintenance for people who hate bike maintenance',
  'Understanding compound interest, finally',
];

const FILLER_HOSTS = [
  'kitchen.example.invalid',
  'history.example.invalid',
  'blog.example.invalid',
  'garage.example.invalid',
];

function fillerSpecs(): LinkSpec[] {
  const inMyList = LINK_SPECS.filter((spec) => spec.list === undefined).length;
  return Array.from({ length: MY_LIST_LINKS - inMyList }, (_, i) => {
    const title = FILLER_TITLES[i % FILLER_TITLES.length];
    return {
      slug: `filler-${pad(i, 3)}`,
      url: `https://${FILLER_HOSTS[i % FILLER_HOSTS.length]}/posts/${i}`,
      title,
      ...(i % 3 === 0 ? { image: 'tile' as const } : {}),
      ...(i % 4 === 1 ? { tags: ['toRead' as const] } : {}),
    };
  });
}

const ALL_LINK_SPECS = [...LINK_SPECS, ...fillerSpecs()];

// What the catalog records for this account — derived, so the two can't drift.
export const WORST_COUNTS = {
  links: ALL_LINK_SPECS.length,
  lists: Object.keys(LIST_SPECS).length + TREE_MAX_DEPTH,
  tags: TAG_NAMES.length,
  pins: ALL_LINK_SPECS.filter((spec) => spec.pinned).length,
};

// --- the build -----------------------------------------------------------------

export function buildWorstLibrary(options: BuildOptions): SeedLibrary {
  const { now } = options;
  const items: { path: string; data: object }[] = [];
  const files: { id: string; bytes: Uint8Array }[] = [];

  const lists: List[] = buildTree(
    LIST_TREE,
    'worst-list',
    WORST_COUNTS.lists,
    true,
    now,
    rootListCeiling(),
  );
  const tags: Tag[] = buildTree(
    TAG_NAMES.map((name) => ({ name })),
    'worst-tag',
    TAG_NAMES.length,
    false,
    now,
    null,
  );
  for (const list of lists) items.push({ path: pathFromId(list.id, LISTS_PREFIX), data: list });
  for (const tag of tags) items.push({ path: pathFromId(tag.id, TAGS_PREFIX), data: tag });

  // Keys resolve by name, which is safe because every name above is unique in
  // its tree — except the deep chain's, which is why it is found by position:
  // the last list built is the bottom of the chain.
  const listIdOf = (key: NonNullable<LinkSpec['list']>): string => {
    if (key === ARCHIVE_ID || key === TRASH_ID) return key;
    if (key === 'deepest') return lists[lists.length - 1].id;
    return rootIdNamed(lists, LIST_SPECS[key]);
  };
  const tagIdOf = (key: TagKey): string => rootIdNamed(tags, TAG_SPECS[key]);

  // A row without an `at` sits i × 5h back, so after the hand-placed first rows
  // ("just now", "1 minute", "1 hour", "1 day") the date column walks back
  // steadily.
  const STEP_MS = 5 * HOUR;
  let omittedFiles = 0;
  const pinned: string[] = [];

  ALL_LINK_SPECS.forEach((spec, i) => {
    const id = `worst-link-${spec.slug}`;
    const createdAt = spec.on ?? Math.round(now + (spec.at ?? -i * STEP_MS));

    const link: Link = {
      url: spec.url,
      listId: spec.list === undefined ? MY_LIST_ID : listIdOf(spec.list),
      tagIds: spec.tags === 'all' ? tags.map((tag) => tag.id) : (spec.tags ?? []).map(tagIdOf),
      createdAt,
      updatedAt: createdAt,
      ...(spec.customTitle ? { customTitle: spec.customTitle } : {}),
      ...(spec.note ? { note: spec.note } : {}),
    };
    items.push({ path: pathFromId(id, LINKS_PREFIX), data: link });

    const done = spec.status === undefined;
    let imageId: string | undefined;
    if (done && spec.image !== undefined) {
      imageId = `worst-image-${spec.slug}`;
      if (spec.image === 'missing') {
        omittedFiles++;
      } else {
        const shape = spec.image === 'tile' ? {} : spec.image;
        files.push({ id: imageId, bytes: previewPng(i, shape) });
      }
    }

    const extraction: Extraction = {
      id,
      ...(done && spec.title !== undefined ? { title: spec.title } : {}),
      ...(imageId ? { imageId } : {}),
      facets: {
        titleImage: {
          status: spec.status ?? 'done',
          extractedBy: 'extension:fg',
          extractedAt: createdAt,
          attempts: done ? 1 : 2,
        },
      },
      createdAt,
      updatedAt: createdAt,
    };
    items.push({ path: pathFromId(id, EXTRACTIONS_PREFIX), data: extraction });

    if (spec.pinned) pinned.push(id);
  });

  const pinRanks = ranksBetween(null, null, Math.max(pinned.length, 1));
  pinned.forEach((id, p) => {
    const pin: Pin = { id, rank: pinRanks[p], createdAt: now, updatedAt: now };
    items.push({ path: pathFromId(id, PINS_PREFIX), data: pin });
  });

  // The same settings blob the everyday seed writes, for the same reason
  // (./library.ts): no device that opens this library fetches anything.
  const settings: SettingsGeneral = {
    deviceExtractionMode: 'off',
    createdAt: now,
    updatedAt: now,
  };
  items.push({ path: SETTINGS_GENERAL_PATH, data: settings });

  return {
    items,
    files,
    counts: {
      links: WORST_COUNTS.links,
      lists: lists.length,
      tags: tags.length,
      pins: pinned.length,
      extractions: ALL_LINK_SPECS.length,
      files: files.length,
    },
    ...(omittedFiles > 0 ? { omitted: { files: omittedFiles, unreadable: 0 } } : {}),
  };
}

function rootIdNamed(entities: (List | Tag)[], name: string): string {
  const entity = entities.find((e) => e.name === name && e.parentId === null);
  if (!entity) throw new Error(`worst-case fixture: no root named "${name}"`);
  return entity.id;
}
