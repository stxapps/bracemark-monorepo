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

// The library behind the marketing site's ONE screenshot — the list layout in the
// "A private library is still a library" band
// (apps/bracemark-site/src/app/page.tsx, `SCREENSHOT`).
//
// Sized for a frame that shows SEVEN of these links, not twenty-six: the capture
// is 1000x760 over a virtualized list (capture.ts counts the geometry), so the top
// seven are the picture and the rest are what makes the account worth signing back
// into. Order is newest-first, so the first entries in SHOT_LINKS below are the
// ones that ship.
//
// It is deliberately NOT `seed/library.ts`. That generator exists to make the app
// hard to break — a thousand synthetic links on `example.com` hosts, with a
// failed extraction every eleventh and a preview image every third, because the
// states you never see by hand are the ones worth seeding. Every one of those
// properties is wrong for a photograph of the product: fake hosts have no covers,
// and a wall that is two-thirds monogram argues the opposite of the band it sits
// in.
//
// SO THIS FILE IS A LIST, NOT A GENERATOR. Twenty-six real URLs, typed out, each
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
// records making. This is somebody's month: an interview on Thursday, a checkup,
// a trip, a tenancy, dinner, a bike, a chair to replace, and something to read.
//
// WHAT THE RAIL HAS TO ANSWER, which is the newest constraint here and the reason
// `Health` and `Shopping` exist. The hero paragraph four screens above this figure
// names the four things a library is a picture of — "what you are reading, buying,
// worrying about and working on" — and the first version of this library answered
// two of them: `Reading` and `Interview prep`. Those two lists are now four. That
// is the whole test a new list has to pass, and it is a narrow one on purpose: the
// looser version of it ("more personal categories, to make the privacy point
// land") was the brief this change arrived with, and it would have taken `Invest`
// as happily as `Health` — a list that is not one of the paragraph's four words is
// texture, and the texture below is already carrying its weight.
//
// HOW FAR `Health` GOES, and it is a line rather than a topic. The hero's rule —
// ordinary, non-sensitive, and still nobody's business — is the only thing that
// makes a health list usable here at all. Blood pressure, sleep and walking are
// what a person reads in the week after a routine checkup; a symptom, a diagnosis
// or a drug name is a CONFESSION, and a confession argues against the band it sits
// in, because a reader who thinks we staged something stops believing the rest of
// the picture too. The worry lives in the `checkup` TAG, which is an appointment
// and not a condition — the same job `thursday` does one row above it.
//
// ONE NESTED PAIR, AND IT IS NOT DECORATION. `nested` was false here, and the
// argument for that still holds in its stronger form: a three-deep tree in a 240px
// rail inside a 1000px frame is a column of indented slivers. What changed is what
// sits directly UNDER the figure — "Nested lists, hidden lists, the app lock … are
// Plus" (page.tsx, the footnote below LIBRARY) — so a flat rail was quietly
// declining to illustrate the first item on that line, from an account that is
// Plus and could make one. `Weekends > Lisbon` is the pair because it is the only
// one that costs nothing: both lists already existed, so the nest adds no ROW, and
// rows are the budget (below).
//
// THE RAIL IS A HEIGHT BUDGET, and nothing checks it. In a 760px frame the lockup
// takes 56 and the filter box 40 (shown from 12 lists+tags up, `FILTER_MIN_ITEMS`),
// the Lists header 34, and every row after that is 32 with a 2px gap. The system
// three (My List / Archive / Trash) and ten of ours make 13 rows, which puts the
// Tags header near 604 — and the capture bears that out: four whole tag rows ship
// and the fifth (`checkup`) is cut through. The library before this one had eight
// lists and six tag rows in frame, which is the trade stated exactly: a list added
// here is a tag REMOVED from the rail, and both arrays below are ordered on that
// basis. Re-count it against the capture rather than against this comment — the
// numbers come off sidebar.tsx's Tailwind classes and those are free to move.
//
// The system three are NOT a block at the top, and the rail in the shipped image
// reads My List / Interview prep / Archive / Health / Shopping / Trash / … . That
// is `use-lists` merging one ordered tree by `rank` (the system lists carry their
// own), not a defect to design around: the previous screenshot interleaved the
// same way. It does mean the LISTS order below is where a list lands relative to
// its neighbours, not its row number.
//
// The tags are not lost with the rail rows — every row in the main column prints
// its own chips, which is where a reader actually reads them.
//
// THE HOSTS ARE CURATED FOR NEUTRALITY, which is the second half of the same
// rule. Reference works, public bodies, a heritage charity's visiting pages, two
// public-domain ebook libraries and a couple of recipes: pages that are evergreen
// (a dated headline ages the screenshot the year after it ships), whose covers
// are photographs rather than a logo card, and none of which is selling anything
// we would appear to be recommending.
//
// The neutrality rule is also what keeps a VIDEO out of this list. A YouTube URL
// was proposed for `Health` on the understanding that it would sit below the fold
// and cost nothing: it does not. Its og:image is the video thumbnail rather than
// anything of YouTube's, so the row would have been fine — but preflight gates
// EVERY url here, not the seven in frame, so an item that can be deleted, made
// private or fronted by a consent wall is one that can block every future capture,
// and it would have been the only non-evergreen entry in a list curated against
// exactly that. A named channel's video is a third party's content on our
// marketing page besides.
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

// A list, and optionally the list it hangs under. `parent` names another entry in
// this same array and must appear ABOVE its child, for two reasons that happen to
// agree: ranks are handed out in array order, and the id it resolves against is
// only in the map once its own row has been built.
type ListSpec = { readonly name: string; readonly parent?: string };

// The lists, in rail order — which is `rank` order, so this is the order the
// PERSON put them in rather than an arrangement we made, and "the live concerns
// first, the standing ones under them" is what that looks like. Ordinary
// categories a person would actually make, which is a lower bar than it sounds:
// the first draft of the big seed's tree filed Recipes under Talks, and a
// hierarchy that means nothing is one you stop reading (seed/library.ts says the
// same thing about itself).
//
// The first four are the hero paragraph's four words, in the rail's own order and
// not the sentence's: reading, buying, worrying, working are a list of concerns
// there and a list of FOLDERS here, and mirroring the sentence's sequence would
// be the one thing that reads as arranged.
const LISTS = [
  { name: 'Interview prep' },
  { name: 'Health' },
  { name: 'Shopping' },
  { name: 'Recipes' },
  { name: 'Reading' },
  { name: 'Weekends' },
  // The whole nest, and it is real rather than illustrative: the three links under
  // `Lisbon` are what you read before a long weekend away, and what `Weekends`
  // holds itself is a day out. A person who keeps both keeps them like this.
  { name: 'Lisbon', parent: 'Weekends' },
  { name: 'Renting' },
  { name: 'Garden' },
  { name: 'Bike' },
] as const satisfies readonly ListSpec[];

// The tags. Single words, lowercase, ONE LEVEL — tag nesting is a Plus feature
// too and this account has it, but it is the tree the rail genuinely cannot draw
// at 240px, where two shallow list levels read fine.
//
// Order is rail order, and by the budget above only the first four or so are in
// frame, so this is a ranking rather than a bag. `thursday` is still the one doing
// the work — tags are the part of a saved link the USER writes, so a day among the
// topics is what makes the row read as somebody's rather than a taxonomy's — and
// `checkup` and `budget` are its opposite numbers in the two new halves: an
// appointment and a feeling about money, neither of them a fact about a page.
const TAGS = [
  'work',
  'interview',
  'thursday',
  'health',
  'checkup',
  'budget',
  'recipe',
  'bread',
  'to-read',
  'classic',
  'lisbon',
  'weekend',
  'garden',
  'bike',
  'rented',
] as const;

type ListName = (typeof LISTS)[number]['name'];
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
  // and three rules shape it — the first two learned from looking at the first
  // capture.
  //
  // ALTERNATE THE HOSTS. Wikipedia is the single largest supplier below, and left
  // in topic order it clustered: rows reading `en.wikipedia.org` four times under
  // four different photographs, which is the one thing in the frame that looks
  // generated. It is now exactly half the list — 13 of 26 — and it sits on every
  // ODD index, which is the only arrangement that holds: n other hosts can
  // separate at most n+1 Wikipedia ones, so the two counts have to stay level, and
  // a Wikipedia URL added without a host to go with it breaks the pattern
  // somewhere below where anyone is still looking. Interleaving also happens to be
  // MORE truthful about how a library fills up — nobody saves all their recipes on
  // Tuesday and all their holiday reading on Wednesday.
  //
  // KEEP THE LOGO CARDS OUT OF THE FIRST ROWS. A handful of these hosts serve a
  // site-wide social card rather than art for the piece, so those cards render as
  // a wordmark on a flat field. One is fine and honest. Two near the top of the
  // frame is the first thing a visitor sees, and it reads as a page about other
  // people's brands. The Ask a Manager card stays first because it is the hero's
  // own link; GOV.UK's is below the fold of the frame.
  //
  // THE SECOND ROW IS THE HEALTH ROW, and the pick was made on the COVER as much
  // as on the topic: it is the tile directly under the hero's own link, so it is
  // the second thing looked at in the whole figure. `Blood pressure` earns it with
  // a photograph of a monitor on an arm. `Nail (anatomy)` was proposed for this
  // slot and declined on the same test — its og:image is an SVG diagram rendered
  // to PNG, i.e. a near-white line drawing, which is the logo card's defect
  // arriving by a different route. A cover in the top rows is a photograph or it
  // is somebody else's page.
  {
    url: 'https://www.askamanager.org/2018/09/15838.html',
    list: 'Interview prep',
    tags: ['work', 'interview', 'thursday'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Blood_pressure',
    list: 'Health',
    tags: ['health', 'checkup'],
  },
  {
    url: 'https://www.bbcgoodfood.com/recipes/classic-lasagne',
    list: 'Recipes',
    tags: ['recipe'],
  },
  // The one row that is in two threads at once: a chair is a purchase and it is
  // also the desk you would be interviewing from. Tags cross lists — that is what
  // they are for — and this is the row where the picture shows it.
  {
    url: 'https://en.wikipedia.org/wiki/Office_chair',
    list: 'Shopping',
    tags: ['budget', 'work'],
  },
  {
    url: 'https://www.wikihow.com/Prepare-for-a-Job-Interview',
    list: 'Interview prep',
    tags: ['interview', 'thursday'],
  },
  { url: 'https://en.wikipedia.org/wiki/Sleep', list: 'Health', tags: ['health'] },
  // The seventh row, cut 62px in: its cover, title and host are in frame and its
  // tags are not (capture.ts derives the number).
  {
    url: 'https://standardebooks.org/ebooks/jane-austen/persuasion',
    list: 'Reading',
    tags: ['to-read', 'classic'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower',
    list: 'Lisbon',
    tags: ['lisbon', 'weekend'],
  },
  {
    url: 'https://www.english-heritage.org.uk/visit/places/stonehenge/',
    list: 'Weekends',
    tags: ['weekend'],
  },
  { url: 'https://en.wikipedia.org/wiki/Electric_kettle', list: 'Shopping', tags: ['budget'] },
  {
    url: 'https://www.bbcgoodfood.com/recipes/best-ever-chocolate-brownies-recipe',
    list: 'Recipes',
    tags: ['recipe', 'weekend'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Job_interview',
    list: 'Interview prep',
    tags: ['work', 'interview'],
  },
  { url: 'https://www.gutenberg.org/ebooks/1342', list: 'Reading', tags: ['classic'] },
  { url: 'https://en.wikipedia.org/wiki/Walking', list: 'Health', tags: ['health', 'checkup'] },
  {
    url: 'https://nationalcareers.service.gov.uk/careers-advice/interview-advice',
    list: 'Interview prep',
    tags: ['work', 'interview'],
  },
  { url: 'https://en.wikipedia.org/wiki/Lisbon', list: 'Lisbon', tags: ['lisbon'] },
  { url: 'https://www.wikihow.com/Change-a-Bike-Tire', list: 'Bike', tags: ['bike'] },
  { url: 'https://en.wikipedia.org/wiki/Damp_(structural)', list: 'Renting', tags: ['rented'] },
  {
    url: 'https://www.citizensadvice.org.uk/housing/renting-privately/',
    list: 'Renting',
    tags: ['rented'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Pastel_de_nata',
    list: 'Lisbon',
    tags: ['lisbon', 'recipe'],
  },
  {
    url: 'https://standardebooks.org/ebooks/f-scott-fitzgerald/the-great-gatsby',
    list: 'Reading',
    tags: ['to-read', 'classic'],
  },
  { url: 'https://en.wikipedia.org/wiki/Compost', list: 'Garden', tags: ['garden'] },
  { url: 'https://www.gutenberg.org/ebooks/2701', list: 'Reading', tags: ['to-read'] },
  { url: 'https://en.wikipedia.org/wiki/Bicycle_lighting', list: 'Bike', tags: ['bike', 'budget'] },
  { url: 'https://www.wikihow.com/Repot-a-Plant', list: 'Garden', tags: ['garden', 'weekend'] },
  { url: 'https://en.wikipedia.org/wiki/Sourdough', list: 'Recipes', tags: ['recipe', 'bread'] },
];

// The catalog entry. It sits BELOW the array because it counts it: `SHOT_LINKS`
// is a `const`, so reading it from above would be a temporal-dead-zone throw at
// import time — and every count here is DERIVED rather than typed so adding a
// link, a list or a tag cannot leave the catalog disagreeing with the archive's
// manifest. `lists` and `tags` were hand-typed numbers until the change that
// added `Health` and `Shopping`, which is exactly the edit that would have left
// them wrong.
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
  lists: LISTS.length,
  tags: TAGS.length,
  // One pair, `Weekends > Lisbon`, and the flag is true for it (see the header:
  // the figure sits directly above a line naming nested lists as a Plus feature).
  // Nesting anything else is what the 240px rail cannot take — and note that a
  // backup restores `parentId` verbatim on ANY plan, so this being true is only
  // honest because this account is genuinely Plus (catalog.ts, `nested`).
  nested: true,
  // No pins. Pinned links sort to the top and wear a badge on the host line, so a
  // pin would spend one of the seven visible rows saying something the caption
  // does not explain.
  pins: 0,
  // `satisfies`, not a `: SeedUser` annotation: the annotation widens `plan` to
  // `SeedPlan`, and `grantPlan` takes the paid half of that union — so the
  // annotated version does not typecheck at the one call site that matters, for
  // a value that is right there in the literal.
} satisfies SeedUser;

export function shotLinkUrls(): string[] {
  return SHOT_LINKS.map((link) => link.url);
}

// ~14 hours between links, so twenty-six of them span about a fortnight and the
// list's dates read as one recent, ordinary stretch. The big seed walks back at
// 3.7h because it has a thousand to place; this one is a fortnight of somebody's
// life, not five months of it.
const STEP_MS = 14 * 60 * 60 * 1000;

export function buildShotLibrary(now: number): SeedLibrary {
  const items: { path: string; data: object }[] = [];

  // One global run of ranks over LISTS, even though `rank` only ever orders a row
  // against its SIBLINGS: a child declared directly under its parent lands between
  // that parent and the next top-level list, so an ascending global sequence is a
  // correct sibling order in every group it gets split into. It stops being true
  // the moment a child is declared away from its parent, which is the other reason
  // the type above says it may not be.
  const listRanks = ranksBetween(null, null, LISTS.length);
  const listIds = new Map<string, string>(
    LISTS.map((spec, i) => [spec.name, `shot-list-${pad(i)}`]),
  );
  const lists: List[] = LISTS.map((spec, i) => {
    const parent = 'parent' in spec ? spec.parent : undefined;
    return {
      id: `shot-list-${pad(i)}`,
      name: spec.name,
      parentId: parent === undefined ? null : must(listIds, parent, 'list'),
      rank: listRanks[i],
      createdAt: now,
      updatedAt: now,
    };
  });

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

  const tagId = new Map(tags.map((tag) => [tag.name, tag.id]));

  SHOT_LINKS.forEach((spec, i) => {
    const createdAt = Math.round(now - i * STEP_MS);
    const link: Link = {
      url: spec.url,
      listId: must(listIds, spec.list, 'list'),
      tagIds: spec.tags.map((name) => must(tagId, name, 'tag')),
      createdAt,
      updatedAt: createdAt,
      // No `customTitle` and no `note`, and both absences are the point. A user
      // override would put a string WE wrote into a picture whose entire claim is
      // that the product wrote it, and it would do so in the one place a reader
      // cannot tell the difference. Notes are the same argument one step quieter:
      // the row renders a note as a badge on the host line, so a note is a visual
      // assertion about a page nobody here has read.
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
    // The picture is of the LIST layout, and this is the synced value that puts it
    // there: `useSettings` resolves this one unless a device has opted out, and a
    // fresh profile never has (`linksLayoutSource` defaults to 'sync'). It does
    // NOT make capture.ts's `useListLayout()` redundant — this account is reused,
    // the setting syncs, and one manual click in the app would otherwise silently
    // photograph cards on the next run. The seeded value is where a fresh import
    // starts; the click is what makes it true of an account that already existed.
    linksLayout: 'list',
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
// in a link's `list`/`tags` a type error, so this is for the two cases they cannot
// see — a name removed from LISTS/TAGS while a link still cites it through a
// widened lookup, and a `parent` naming a list that isn't one. It throws rather
// than asserting non-null because of how the failure would otherwise surface: an
// `undefined` listId produces an entity that fails `classifyBundleLine`, and the
// import DROPS an unreadable line silently, one at a time (seed/library.ts carries
// the same warning). A missing card in the finished screenshot is not a symptom
// anyone traces back to this.
function must(ids: Map<string, string>, name: string, kind: string): string {
  const id = ids.get(name);
  if (!id) throw new Error(`no ${kind} named "${name}" — seed/shot/library.ts is inconsistent`);
  return id;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
