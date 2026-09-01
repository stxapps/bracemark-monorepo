import {
  type BackupCounts,
  type Link,
  LINKS_PREFIX,
  type List,
  LISTS_PREFIX,
  pathFromId,
  ranksBetween,
  SETTINGS_GENERAL_PATH,
  type SettingsGeneral,
  type Tag,
  TAGS_PREFIX,
} from '@stxapps/shared';

import type { SeedUser } from '../catalog';
import type { SeedLibrary } from '../library';

// The library behind the marketing site's ONE screenshot — the card grid in the
// "A private library is still a library" band
// (apps/bracemark-site/src/app/page.tsx, `SCREENSHOT`).
//
// It is deliberately NOT `seed/library.ts`. That generator exists to make the app
// hard to break — a thousand synthetic links on `example.com` hosts, with a
// failed extraction every eleventh and a preview image every third, because the
// states you never see by hand are the ones worth seeding. Every one of those
// properties is wrong for a photograph of the product: fake hosts have no covers,
// and a wall that is two-thirds monogram argues the opposite of the band it sits
// in.
//
// SO THIS FILE IS A LIST, NOT A GENERATOR. Two dozen real URLs, typed out, each
// one checked (see ./preflight.ts) to return a real page and a real og:image
// through `bracemark-extractor` itself. Nothing here invents a title or an image:
// the archive carries bare URLs, list membership and tags, and the capture run
// turns on server extraction and lets the product fill in the rest. What ends up
// in the picture is what the product produced, which is the only version of this
// screenshot worth shipping.
//
// WHOSE LINKS THESE ARE. The persona is settled in `HeroPanel`'s comment on the
// site's landing page, and it was settled the hard way — twice — so it is
// inherited here rather than re-argued. In short: a link implies an ACT, not a
// TASTE; it is ordinary and non-sensitive and still nobody's business; it is
// never a link about US (a product demonstrating itself with its own pitch), and
// never a vendor or an advocacy org, because a third party's mark on our
// marketing page reads as an endorsement we do not have. "Aligned with the hero"
// is not a resemblance if the two libraries could not belong to the same person,
// so the first row here is the hero's own act — preparing for Thursday's
// interview, under its own three tags — even though it could not be the hero's
// own URL (see the note above the list).
//
// That rules out, by construction, the vocabulary `seed/library.ts` speaks. Rust,
// Postgres, Kubernetes and WASM are the reading list of a distributed-systems
// engineer, and casting the user as one is the exact repair the hero comment
// records making. This is somebody's month: an interview on Thursday, a trip, a
// tenancy, dinner, a bike, and something to read.
//
// THE HOSTS ARE CURATED FOR NEUTRALITY, which is the second half of the same
// rule. Reference works, public bodies, a heritage charity's visiting pages, two
// public-domain ebook libraries and a couple of recipes: pages that are evergreen
// (a dated headline ages the screenshot the year after it ships), whose covers
// are photographs rather than a logo card, and none of which is selling anything
// we would appear to be recommending.
//
// AND FOR SPEED, which is not an aesthetic preference here. `bracemark-extractor`
// gives each hop 8 seconds (`FETCH_TIMEOUT_MS`), and the og:image is a second hop
// after the page — so a host that answers slowly does not fail cleanly, it fails
// INTERMITTENTLY, and an intermittent failure costs a `backoff(attempts)` ladder
// that starts at ten minutes and doubles. Two National Trust pages were in this
// list and they are the reason the ladder was discovered: their covers took 3.0s
// and 4.1s to fetch from a fast connection, so a capture would come back 21 of 24
// and then spend forty minutes not converging. Both were replaced with pages that
// answer in well under a second. `shot:preflight` measures this now, so a slow
// host is a red line before a capture rather than a mystery during one.

// The lists, in rail order. Ordinary categories a person would actually make,
// which is a lower bar than it sounds: the first draft of the big seed's tree
// filed Recipes under Talks, and a hierarchy that means nothing is one you stop
// reading (seed/library.ts says the same thing about itself).
const LISTS = [
  'Interview prep',
  'Recipes',
  'Lisbon',
  'Renting',
  'Reading',
  'Bike',
  'Garden',
  'Weekends',
] as const;

// The tags. Single words, lowercase, in the hero's own register — its three are
// `work`, `interview`, `thursday`, and `thursday` is the one that does the work:
// tags are the part of a saved link the USER writes, so a day among the topics is
// what makes the row read as somebody's rather than a taxonomy's.
const TAGS = [
  'work',
  'interview',
  'thursday',
  'recipe',
  'bread',
  'lisbon',
  'to-read',
  'classic',
  'weekend',
  'garden',
  'bike',
  'rented',
] as const;

type ListName = (typeof LISTS)[number];
type TagName = (typeof TAGS)[number];

interface ShotLink {
  url: string;
  list: ListName;
  tags: TagName[];
}

// The list itself. Order is display order, newest first — the capture shows the
// top of the grid, so the first row of this array is the first row of the
// picture, and `SHOT_USER.links` counts whatever is here.
//
// EVERY URL HERE HAS BEEN CHECKED, and `npm run shot:preflight` is how: it asks
// the local `bracemark-extractor` for all of them and fails on any that does not
// come back `ok` with an `imageUrl`. Run it before a capture and after any edit
// to this list. A URL that has gone 404, or lost its og:image, or moved behind a
// bot wall since this was written costs one monogram in the middle of the wall
// the band exists to show — the kind of defect that is invisible in a diff and
// obvious in the shipped PNG.
//
// THE FIRST ROW IS THE HERO PANEL'S OWN SPECIMEN, which is what makes "aligned
// with the hero" a fact about this library rather than a resemblance: it is the
// same person's same act, under the same three tags, and the extractor returns
// the same headline the panel prints. Its URL is now recorded beside the panel
// too (apps/bracemark-site/src/app/page.tsx) — for a while it was written down
// nowhere, and a slug reconstructed from the headline 404s, because the path is
// the post id and not the words.
//
// It is also the one card here whose cover is a LOGO rather than a photograph:
// askamanager.org serves a site-wide social card on every post, so this tile is
// the Ask a Manager wordmark where its neighbours are pictures. That is a real
// property of the page and it is left alone. The hero panel declines the same
// image for a reason that does not apply at this size — a 480x480 card
// centre-cropped into a 64x40 slot is a smear of somebody else's brand colour,
// which is why that slot draws the monogram instead — whereas a card banner is
// wide enough to render it as what it is. One wordmark tile in a wall of
// photographs is also what a real library looks like. If it ever reads as an
// endorsement rather than as a bookmark, dropping this row is a one-line change.
const SHOT_LINKS: ShotLink[] = [
  // ORDERING IS A DESIGN DECISION HERE, not the order these were collected in,
  // and two rules shape it — both learned from looking at the first capture.
  //
  // ALTERNATE THE HOSTS. Wikipedia is the single largest supplier below, and left
  // in topic order it clustered: rows of four cards reading `en.wikipedia.org`
  // four times under four different photographs, which is the one thing in the
  // frame that looks generated. Interleaving also happens to be MORE truthful
  // about how a library fills up — nobody saves all their recipes on Tuesday and
  // all their holiday reading on Wednesday — so the mixed order is what a real
  // newest-first list looks like anyway.
  //
  // KEEP THE LOGO CARDS OUT OF THE FIRST ROW. A handful of these hosts serve a
  // site-wide social card rather than art for the piece, so those cards render as
  // a wordmark on a flat field. One is fine and honest. Two side by side at the
  // top-left of a 16:10 crop is the first thing a visitor sees, and it reads as a
  // page about other people's brands. The Ask a Manager card stays first because
  // it is the hero's own link; GOV.UK's moves down to the fourth row, below the
  // fold of the frame.
  {
    url: 'https://www.askamanager.org/2018/09/15838.html',
    list: 'Interview prep',
    tags: ['work', 'interview', 'thursday'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower',
    list: 'Lisbon',
    tags: ['lisbon', 'weekend'],
  },
  {
    url: 'https://www.bbcgoodfood.com/recipes/classic-lasagne',
    list: 'Recipes',
    tags: ['recipe'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Job_interview',
    list: 'Interview prep',
    tags: ['work', 'interview'],
  },
  {
    url: 'https://www.wikihow.com/Prepare-for-a-Job-Interview',
    list: 'Interview prep',
    tags: ['interview', 'thursday'],
  },
  { url: 'https://en.wikipedia.org/wiki/Sourdough', list: 'Recipes', tags: ['recipe', 'bread'] },
  {
    url: 'https://standardebooks.org/ebooks/jane-austen/persuasion',
    list: 'Reading',
    tags: ['to-read', 'classic'],
  },
  { url: 'https://en.wikipedia.org/wiki/Lisbon', list: 'Lisbon', tags: ['lisbon'] },
  {
    url: 'https://www.english-heritage.org.uk/visit/places/stonehenge/',
    list: 'Weekends',
    tags: ['weekend'],
  },
  { url: 'https://en.wikipedia.org/wiki/Compost', list: 'Garden', tags: ['garden'] },
  {
    url: 'https://www.bbcgoodfood.com/recipes/best-ever-chocolate-brownies-recipe',
    list: 'Recipes',
    tags: ['recipe', 'weekend'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Pastel_de_nata',
    list: 'Lisbon',
    tags: ['lisbon', 'recipe'],
  },
  { url: 'https://www.gutenberg.org/ebooks/1342', list: 'Reading', tags: ['classic'] },
  { url: 'https://en.wikipedia.org/wiki/Rye_bread', list: 'Recipes', tags: ['bread'] },
  {
    url: 'https://nationalcareers.service.gov.uk/careers-advice/interview-advice',
    list: 'Interview prep',
    tags: ['work', 'interview'],
  },
  { url: 'https://en.wikipedia.org/wiki/Damp_(structural)', list: 'Renting', tags: ['rented'] },
  { url: 'https://www.wikihow.com/Change-a-Bike-Tire', list: 'Bike', tags: ['bike'] },
  { url: 'https://en.wikipedia.org/wiki/Hampstead_Heath', list: 'Weekends', tags: ['weekend'] },
  {
    url: 'https://standardebooks.org/ebooks/f-scott-fitzgerald/the-great-gatsby',
    list: 'Reading',
    tags: ['to-read', 'classic'],
  },
  { url: 'https://en.wikipedia.org/wiki/Risotto', list: 'Recipes', tags: ['recipe'] },
  {
    url: 'https://www.citizensadvice.org.uk/housing/renting-privately/',
    list: 'Renting',
    tags: ['rented'],
  },
  { url: 'https://en.wikipedia.org/wiki/Fado', list: 'Lisbon', tags: ['lisbon'] },
  { url: 'https://www.gutenberg.org/ebooks/2701', list: 'Reading', tags: ['to-read'] },
  { url: 'https://en.wikipedia.org/wiki/Bicycle_lighting', list: 'Bike', tags: ['bike'] },
  { url: 'https://www.wikihow.com/Repot-a-Plant', list: 'Garden', tags: ['garden', 'weekend'] },
];

// The catalog entry. It sits BELOW the array because it counts it: `SHOT_LINKS`
// is a `const`, so reading it from above would be a temporal-dead-zone throw at
// import time — and `links` is derived rather than typed so adding a link cannot
// leave the catalog disagreeing with the archive's manifest.
//
// It is deliberately NOT in `SEED_USERS`. That list is what `npm run seed` fans
// out over, and this account is not part of the 2x2 a dev session wants: it is a
// fixture for one marketing asset, it reaches the public internet, and its
// library is this file rather than the generator. `npm run shot` is its entry
// point.
export const SHOT_USER = {
  key: 'shot',
  username: 'seed_shot',
  // Plus, and not for the plan badge: `serverExtraction` is a Plus entitlement
  // (packages/shared/src/iap/plans.ts), so a free account cannot take the opt-in
  // that fills this library in — Settings shows it the upsell instead of the
  // toggle. The capture run reads that as its proof the grant landed.
  plan: 'plus',
  links: SHOT_LINKS.length,
  lists: 8,
  tags: 12,
  // Flat. Nesting is a Plus feature and this account has it, but the picture is
  // of the CARD GRID, and a rail of eight plain lists is legible at the width
  // the figure is actually rendered (1088px, scaled into a 16:10 frame) where a
  // three-deep tree is a column of indented slivers.
  nested: false,
  // No pins. The pinned block is a second, differently-shaped row above the grid,
  // and the band's claim is about the grid.
  pins: 0,
  // `satisfies`, not a `: SeedUser` annotation: the annotation widens `plan` to
  // `SeedPlan`, and `grantPlan` takes the paid half of that union — so the
  // annotated version does not typecheck at the one call site that matters, for
  // a value that is right there in the literal.
} satisfies SeedUser;

export function shotLinkUrls(): string[] {
  return SHOT_LINKS.map((link) => link.url);
}

// ~14 hours between links, so twenty-four of them span about a fortnight and the
// grid's dates read as one recent, ordinary stretch. The big seed walks back at
// 3.7h because it has a thousand to place; this one is a fortnight of somebody's
// life, not five months of it.
const STEP_MS = 14 * 60 * 60 * 1000;

export function buildShotLibrary(now: number): SeedLibrary {
  const items: { path: string; data: object }[] = [];

  const listRanks = ranksBetween(null, null, LISTS.length);
  const lists: List[] = LISTS.map((name, i) => ({
    id: `shot-list-${pad(i)}`,
    name,
    parentId: null,
    rank: listRanks[i],
    createdAt: now,
    updatedAt: now,
  }));

  const tagRanks = ranksBetween(null, null, TAGS.length);
  const tags: Tag[] = TAGS.map((name, i) => ({
    id: `shot-tag-${pad(i)}`,
    name,
    parentId: null,
    rank: tagRanks[i],
    createdAt: now,
    updatedAt: now,
  }));

  for (const list of lists) items.push({ path: pathFromId(list.id, LISTS_PREFIX), data: list });
  for (const tag of tags) items.push({ path: pathFromId(tag.id, TAGS_PREFIX), data: tag });

  const listId = new Map(lists.map((list) => [list.name, list.id]));
  const tagId = new Map(tags.map((tag) => [tag.name, tag.id]));

  SHOT_LINKS.forEach((spec, i) => {
    const createdAt = Math.round(now - i * STEP_MS);
    const link: Link = {
      url: spec.url,
      listId: must(listId, spec.list, 'list'),
      tagIds: spec.tags.map((name) => must(tagId, name, 'tag')),
      createdAt,
      updatedAt: createdAt,
      // No `customTitle` and no `note`, and both absences are the point. A user
      // override would put a string WE wrote into a picture whose entire claim is
      // that the product wrote it, and it would do so in the one place a reader
      // cannot tell the difference. Notes are the same argument one step quieter:
      // the card grid renders a note as a badge, so a note is a visual assertion
      // about a page nobody here has read.
    };
    items.push({ path: pathFromId(`shot-link-${pad(i)}`, LINKS_PREFIX), data: link });
  });

  // NO `extractions/` ENTITIES AT ALL, which is what makes the capture honest.
  // Absence counts as pending (queries.ts, `readTrashedTitleImageCounts` — "Absence
  // counts as pending, exactly as the tally above defines it"), so every one of
  // these links lands in the drain's queue and every title and cover in the
  // finished picture was fetched by `bracemark-extractor` and written back by the
  // client, through the same path a paying user's would be.
  const settings: SettingsGeneral = {
    // The picture is of the CARD layout, and this is how it gets there: the
    // synced setting is what `useSettings` resolves unless a device has opted
    // out, and a fresh profile never has (`linksLayoutSource` defaults to
    // 'sync'). Setting it here rather than clicking through Settings → Misc
    // keeps the capture run's clicks to the two that are load-bearing.
    linksLayout: 'card',
    // Inherited from the big seed for the same reason it holds there: a device
    // that opens this account must not start fetching these (real, reachable)
    // hosts on its own. Web ignores the field — bracemark-expo reads it — and
    // the capture's own fetching is the SERVER path, which is a different,
    // explicitly-toggled switch.
    deviceExtractionMode: 'off',
    // NOT `serverExtraction: true`. It could be set here and it deliberately
    // isn't: it is the privacy-load-bearing opt-in, so the capture run flips the
    // real Switch in Settings → Link previews. That costs one click and buys the
    // proof that the Plus grant reached the client — a free account is shown an
    // upsell where the switch would be, so a missing grant fails loudly at the
    // toggle instead of quietly producing a wall of monograms.
    createdAt: now,
    updatedAt: now,
  };
  items.push({ path: SETTINGS_GENERAL_PATH, data: settings });

  const counts: BackupCounts = {
    links: SHOT_LINKS.length,
    lists: lists.length,
    tags: tags.length,
    pins: 0,
    extractions: 0,
    files: 0,
  };

  return { items, files: [], counts };
}

// Resolve a name to its id, or throw. The union types above already make a typo
// here a type error, so this is for the case they cannot see — a name removed
// from LISTS/TAGS while a link still cites it through a widened lookup. It throws
// rather than asserting non-null because of how the failure would otherwise
// surface: an `undefined` listId produces an entity that fails
// `classifyBundleLine`, and the import DROPS an unreadable line silently, one at
// a time (seed/library.ts carries the same warning). A missing card in the
// finished screenshot is not a symptom anyone traces back to this.
function must(ids: Map<string, string>, name: string, kind: string): string {
  const id = ids.get(name);
  if (!id) throw new Error(`no ${kind} named "${name}" — seed/shot/library.ts is inconsistent`);
  return id;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
