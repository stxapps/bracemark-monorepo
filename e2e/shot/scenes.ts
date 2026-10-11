import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import { SHOT_OUTPUT } from '../paths';
import { fillCredentialSteps, newCredentials } from '../web/fixtures/account';
import { writeOverCapBookmarks } from '../web/fixtures/data-lifecycle';

// WHAT to photograph. `web.ts` is the HOW, and the split is the point: the
// account, the import, the extraction drain and the waits are one apparatus that
// every picture needs, and the only thing that varies between pictures is a
// viewport, a URL and what "finished" means on that screen.
//
// One scene = one PNG at `e2e/.artifacts/shot/<id>.png`, at `viewport × scale`
// device pixels — or, for a scene with a `frame`, at that element's box × scale.
// Nothing here knows where a picture ends up — the marketing site's figures and
// the PWA install dialog's screenshots are both just scenes, and the mapping
// from scene to destination lives with the compositor.
//
// ⚠ A SCENE'S GEOMETRY IS A CONTRACT WITH SOMETHING OFF-STAGE. Every entry below
// says which one and what breaks. Do not retune a number here because a picture
// looks better; the consumer is what decides, and it is in another file (or
// another repo).

export interface Scene {
  /** `.artifacts/shot/<id>.png`, and what `npm run shot:web -- <id>` selects. */
  id: string;
  /** One line, for the run's own listing. */
  what: string;
  /** CSS px. With `scale`, this is the finished pixel size. */
  viewport: { width: number; height: number };
  /**
   * Device pixel ratio. ⚠ `deviceScaleFactor` is a BROWSER-CONTEXT option, not a
   * page one, so scenes at different scales cannot share a launch — `web.ts`
   * groups on this field (and `account`) and launches once per group. Getting that wrong does not
   * throw; it silently photographs everything at the first group's DPR.
   */
  scale: number;
  /** Path after `WEB_URL`. */
  goto: string;
  /** Clicks before the shot. Omit when the URL alone puts the app in the state. */
  prepare?: (page: Page) => Promise<void>;
  /** The wait that means "finished". Never `waitForTimeout` — see below. */
  settle: (page: Page) => Promise<void>;
  /**
   * Photograph this element's box instead of the viewport. For a picture whose
   * subject is one surface — a panel, a dialog — and whose consumer shows it at
   * the size the app draws it: the docs figures (below). The viewport is then
   * only the room the element is given, and the PNG is the box × `scale`.
   */
  frame?: (page: Page) => Locator;
  /**
   * CSS px of the page to keep round the `frame`, on every side. For a surface
   * whose own edge is not a plain rounded box — the auth card turns one corner
   * down — so the edge has to be IN the picture rather than redrawn by whatever
   * shows it. Whole pixels only: the PNG is then `(box + 2 × bleed) × scale`.
   */
  bleed?: number;
  /**
   * A `seed/catalog.ts` key, for the scene that is NOT a picture of the shot
   * account — a plan's limit, which that account's Plus grant removes — or
   * `SIGNED_OUT` for a screen nobody is signed in on. Omit it everywhere else.
   * ⚠ Like `scale` it is fixed per launch, so `web.ts` groups on the pair; and a
   * seed account is `npm run seed:accounts`'s to make, a second prerequisite
   * beside `shot:account`.
   */
  account?: string;
}

/** `Scene.account` for a launch with no session at all. Not a seed key. */
export const SIGNED_OUT = 'signed-out';

// The links list, photographed at every width. Two conditions, and neither is
// what "wait for the images" first looks like — they were paid for one bad
// capture at a time, so read the reasoning before simplifying either.
//
// FIRST: no row may be wearing a MONOGRAM. `LinkPreviewImage` renders an `<img>`
// only once the bytes are in hand; with no image it renders
// `PreviewFallbackIcon`/`PreviewFallbackPanel`, a `<div>` — so "every img has
// loaded" is satisfied vacuously by a column of monograms, which is the exact
// picture this run exists to avoid, passing the check meant to catch it. Every
// branch takes the SLOT's own `h-10 w-16` (list-layout.tsx sizes the box and
// link-media.tsx passes that className through all three), so counting the slots
// and counting the `<img>`s among them is the reading that means something.
//
// Matching on the two size classes rather than on one distinctive one, because
// there isn't one: the card grid had `aspect-12/7`, which nothing else wore,
// where `h-10` and `w-16` are ordinary utilities that are only this slot IN
// COMBINATION. `PreviewFallbackIcon` nests a second `<img>` for the favicon it
// escalates through — that one is `size-4`, so it is not caught here, and a row
// showing it is correctly counted as a slot with no cover.
//
// SECOND: every one of those images DECODED. The list pulls each preview out of
// `files/` as its row mounts (rows are virtualized, so mounted = displayed),
// which means an `<img>` can be attached and on screen with nothing in it yet.
// `naturalWidth` is the only reading that says the bytes arrived.
//
// Both are scoped to what is MOUNTED rather than to the whole library, and that
// is correct rather than a compromise: the virtualizer only builds the rows near
// the viewport, and the rows near the viewport are precisely what gets
// photographed.
async function coversDecoded(page: Page): Promise<void> {
  const slots = page.getByRole('main').locator('[class~="h-10"][class~="w-16"]');
  const covers = page.getByRole('main').locator('img[class~="h-10"][class~="w-16"]');
  await expect(covers.first()).toBeVisible();

  await expect
    .poll(
      async () => {
        const [slotCount, coverCount, decoded] = await Promise.all([
          slots.count(),
          covers.count(),
          covers.evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
        ]);
        return slotCount > 0 && slotCount === coverCount && decoded;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

// Then let the FAVICONS land. They are fetched per host through the same
// extractor, one `GET /v1/image` each, bounded to `MAX_IN_FLIGHT` with a stagger
// so they never compete with the previews (web-react's FaviconProvider) — which
// means they are still arriving for several seconds after every cover has
// decoded. Capturing on the covers alone caught the page mid-fill: every row
// correct, and a column of empty grey plates where the site marks go, which
// reads as a half-loaded page rather than as a product. The list layout prints
// the host as TEXT beside each one, so a missing mark is more conspicuous here
// than it was in the grid, not less.
//
// Located positively, on the host line's own `size-3.5`, rather than as "every
// img that is not a cover" — that negation was written when the cover carried a
// class nothing else did, and against `h-10 w-16` it would also sweep in
// `PreviewFallbackIcon`'s nested favicon and count it twice.
//
// ⚠ This waits for the count to STOP CHANGING rather than for some number of
// them, and that is deliberate: a host that serves no `/favicon.ico` records
// `none` and `Favicon` renders its quiet plate forever, which is a correct final
// state and not something to wait out. Quiescence is the only condition true of
// both outcomes. Three of this library's hosts land there.
async function faviconsQuiesced(page: Page): Promise<void> {
  const favicons = page.getByRole('main').locator('img[class~="size-3.5"]');
  let settled = 0;
  let previous = -1;
  while (settled < 3) {
    await page.waitForTimeout(2_000);
    const count = await favicons.count();
    settled = count === previous ? settled + 1 : 0;
    previous = count;
  }
}

/** Both waits, in the order they can be satisfied. Every scene here is the list. */
async function settleList(page: Page): Promise<void> {
  await coversDecoded(page);
  await faviconsQuiesced(page);
}

/** The lead scenes are the real default inbox, not a relabelled all-links view. */
async function settleMyList(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'My List', exact: true })).toBeVisible();
  await settleList(page);
}

// The one query the search scenes commit, as a URL rather than as keystrokes —
// `?text=` IS the committed search (docs/search.md, _the query is the URL_), so
// driving the box would only be re-typing what the address bar already says, and
// it would photograph a component mid-debounce.
//
// "travel" is chosen for what it demonstrates: it lands in the fetched TITLE of
// all five Wikivoyage guides and in the URL of none of them, so every row on
// screen is there because of a word the EXTRACTOR supplied. That is the half of
// the combined `url ⊕ title` haystack a reader cannot otherwise account for — a
// hit on the url explains itself, a hit on the title only makes sense once you
// know the title was fetched. A person with a `Lisbon` list under `Weekends` is
// the person who types it. It also happens to fill the frame, which is the one
// thing the note below is about.
//
// ⚠ IT USED TO BE "interview", and what retired it was the listing-safe swap in
// `library.ts`, not a view about the word. "interview" landed in three URLs and in
// the fetched title of a fourth — askamanager's — showing BOTH halves of the union
// in one frame. Two of those four links left (a masthead cover and a crest card),
// and the title-only match went with them. The whole vocabulary was searched
// afterwards: NO word in this library now matches 3-5 links with a url hit and a
// title-only hit at the same time, so the union cannot be shown in one picture and
// this scene shows the half that needs showing. If a future library restores a
// link whose title and url disagree, that word is worth having back — Gutenberg is
// the structural candidate, since its urls are numeric and its titles are not.
const SEARCH_WORD = 'travel';

// ⚠ A FILTERED VIEW IS SHORT, AND THAT IS THE FIXTURE, NOT THE QUERY. The library
// is 26 links across My List and 10 named lists, so a search lands 2–5 rows and
// leaves air under them. Look at it in `--preview`: if the air reads as an empty
// product rather than as a narrowed one, the fix is a longer library in
// `library.ts`, not a broader search word.
async function searchCommitted(page: Page): Promise<void> {
  // The box is `value={text}`, seeded from the committed query, so this asserts
  // the URL actually reached the UI — a parse regression would otherwise
  // photograph an empty box over a filtered list and look like a design choice.
  // `textbox`, not `searchbox`: the field is web-ui's `Input` with no `type`, so
  // it is a plain text input inside a `role="search"` form.
  await expect(page.getByRole('textbox', { name: 'Search links' })).toHaveValue(SEARCH_WORD);
  await settleList(page);
}

// The Advanced search panel, for the figure on the marketing site's
// /docs/search. That page spends a paragraph naming six fields and two
// checklists; the panel is the one place they are all on screen at once.
//
// The draft is ONE search a person with this library would build — "interview"
// in the title or address, nothing from Wikipedia, in Interview prep but not in
// Archive, tagged both work and interview — and it is chosen for what it puts
// in the picture rather than for what it finds: a word field in use beside the
// two that keep their placeholders, a list included and a list excluded (the
// tri-state is the control nobody guesses), and two tags, which is what it
// takes for the Match any/all toggle to exist at all. It is never committed:
// Search would close the panel, and the picture is of the form.
//
// The four rows it ticks are the first four of each checklist. The boxes are
// `max-h-32`, about four rows, and a state scrolled out of its own box is not
// in the picture.
async function buildAdvancedSearch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Advanced search' }).click();
  const panel = advancedSearchPanel(page);
  await expect(panel).toBeVisible();

  // The panel opens on the COMMITTED query, and `/links` is one: My List arrives
  // already included. Clear is how a person starts a search of the whole library
  // from there, and it is the panel's own button.
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'My List: not selected' })).toBeVisible();

  await panel.getByLabel('All of these words (URL or title)').fill('interview');
  await panel.getByLabel('None of these words').fill('wikipedia');

  // The tri-state cycles off → include → exclude, so excluding is two clicks.
  await panel.getByRole('checkbox', { name: 'Interview prep: not selected' }).click();
  await panel.getByRole('checkbox', { name: 'Archive: not selected' }).click();
  await panel.getByRole('checkbox', { name: 'Archive: included' }).click();
  await panel.getByRole('checkbox', { name: 'work: not selected' }).click();
  await panel.getByRole('checkbox', { name: 'interview: not selected' }).click();
  await panel.getByRole('button', { name: 'all', exact: true }).click();

  // The pointer is still over the last thing it pressed, and a row under the
  // pointer wears `hover:bg-muted` — a highlight on a control the picture is not
  // about. The focus is in the same place and takes its ring with it.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Radix gives PopoverContent `role="dialog"` and no name of its own; the panel's
// title is a `<p>`, so the text is what tells it from any other open dialog.
function advancedSearchPanel(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'Advanced search' });
}

// ⚠ "WHOLE" IS THE CLAIM, AND THE PANEL SCROLLS. It is `max-h-[70vh]` with the
// fields in a scroll box of their own, so a panel that outgrows the viewport
// does not fail and does not look wrong — it photographs with Clear and Search
// pinned under a list that is quietly cut off. Both scroll boxes are measured
// instead: the fields' own, and the panel around it.
async function advancedSearchWhole(page: Page): Promise<void> {
  const panel = advancedSearchPanel(page);
  await expect(panel.getByRole('button', { name: 'all', exact: true })).toBeVisible();
  // The open animation is a 100ms fade and zoom; a capture inside it is a
  // translucent panel at 95% size, and the box measured below is the scaled one.
  await expect
    .poll(() =>
      panel.evaluate((element) => element.getAnimations().every((a) => a.playState !== 'running')),
    )
    .toBe(true);

  const overflowing = await panel.evaluate((element) =>
    [element, ...element.querySelectorAll('.overflow-y-auto:not([class~="max-h-32"])')].some(
      (box) => box.scrollHeight > box.clientHeight,
    ),
  );
  if (overflowing) {
    throw new Error(
      'the Advanced search panel does not fit its viewport, so the capture would be cut off. ' +
        'Raise `search-advanced`’s viewport height until 70vh holds the whole panel.',
    );
  }
}

// Selection mode, for the figure on /docs/select-and-bulk-edit: the mode is the
// thing to recognise — a bar where the search row was, a tick on every row — and
// its bar names only half its actions at this width, which is what the caption
// under the figure is for.
//
// The first row and the third: a gap in the selection is what says the ticks are
// per row, where two in a run reads as a range.
//
// ⚠ ONLY ROWS THAT ARE WHOLLY IN FRAME. A click on a tick below the fold does
// not fail — Playwright scrolls the row into view to reach it — and the capture
// is then of a list scrolled two rows down, under a count naming rows that are
// no longer in the picture. `linksSelected` holds the list to its top for that.
const SELECTED_ROWS = [0, 2];

async function selectSomeLinks(page: Page): Promise<void> {
  await settleMyList(page);
  await page.getByRole('button', { name: 'Bulk edit' }).click();
  const ticks = page.getByRole('main').getByRole('checkbox', { name: 'Select link' });
  for (const row of SELECTED_ROWS) await ticks.nth(row).click();
  // The pointer rests on the last row it ticked, which then wears the hover
  // tint — on a selected row, indistinguishable from nothing; on the way there,
  // one more highlighted row.
  await page.mouse.move(0, 0);
}

async function linksSelected(page: Page): Promise<void> {
  await expect(page.getByText(`${SELECTED_ROWS.length} selected`)).toBeVisible();
  const ticks = page.getByRole('main').getByRole('checkbox', { name: 'Select link' });
  await expect(ticks.first()).toBeInViewport({ ratio: 1 });
  await expect(ticks.nth(SELECTED_ROWS.at(-1) ?? 0)).toBeInViewport({ ratio: 1 });
  await settleList(page);
}

// The sync row in Settings → Data, for the figure on /docs/sync-and-devices —
// the one place the web app spells sync status out (the links page shows a dot,
// and only once something is wrong).
//
// ⚠ ITS SECOND LINE IS A CLOCK. `formatSyncedAt` prints "just now" for the first
// minute and "N min ago" after it, so the line depends on how long this launch
// has been open — which is how many scenes ran before this one. Pressing Sync
// now is what pins it: the row goes to the spinner and comes back to "just now"
// with a minute in hand.
function syncRow(page: Page): Locator {
  return page
    .locator('div.rounded-lg')
    .filter({ has: page.getByRole('button', { name: 'Sync now' }) });
}

async function syncNow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sync now' }).click();
}

async function syncedJustNow(page: Page): Promise<void> {
  await expect(syncRow(page).getByText('Last synced just now')).toBeVisible({ timeout: 60_000 });
  // A button that has just been pressed keeps the focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
}

// The import's over-limit question, for the figure on /docs/import. It is asked
// of a FREE account only (Plus has no link cap), so this is the one scene on a
// dev account rather than the shot one: `free-full`, 190 links of the plan's
// 200, which is what makes the arithmetic in the picture an ordinary one — a
// nearly full library and a bookmarks file that does not fit.
//
// ⚠ NOTHING IS IMPORTED. The run is suspended on the question and has written
// nothing when it is asked (docs/data-lifecycle.md, _the import's quota gate_);
// the capture is of the question, and closing the browser is the same as never
// having answered. Press "Import 10 links" here and the next run photographs an
// account with no room at all.
const OVER_LIMIT_FILE = join(SHOT_OUTPUT, 'import-over-limit.html');
const OVER_LIMIT_LINKS = 40;

function importQuestion(page: Page): Locator {
  return page.locator('div.rounded-lg').filter({ hasText: 'Nothing has been imported yet' });
}

async function importTooManyLinks(page: Page): Promise<void> {
  await writeOverCapBookmarks(OVER_LIMIT_FILE, 'bookmarks', OVER_LIMIT_LINKS);
  await page.getByRole('button', { name: 'Import data' }).click();
  await expect(page.getByRole('button', { name: 'Choose a file' })).toBeVisible();
  // The picker's `<input>` is hidden and the button only clicks it, so the file
  // goes to the input — the one step here a person does through a system dialog.
  await page.locator('input[type="file"]').setInputFiles(OVER_LIMIT_FILE);
}

async function importAsked(page: Page): Promise<void> {
  await expect(importQuestion(page)).toBeVisible({ timeout: 60_000 });
  await expect(
    importQuestion(page).getByText(`This file has ${OVER_LIMIT_LINKS} new links.`),
  ).toBeVisible();
  await page.mouse.move(0, 0);
}

// The Edit link dialog, for the figure on /docs/what-a-saved-link-includes —
// the one screen where "your details" and "fetched details" are told apart on
// sight. The title box edits YOUR title; this link has none, so the box is empty
// and wears the fetched page title as its placeholder, over an image that also
// came from the page. The list, the tags and the empty note are the link's own.
//
// The first row, because it is the library's most filled-in link (three tags,
// a fetched title and cover) and the specimen every other picture leads with.
// Nothing is typed and nothing is saved: the dialog is closed with the browser.
function editLinkDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'Edit link' });
}

async function openEditLink(page: Page): Promise<void> {
  await settleMyList(page);
  await page.getByRole('button', { name: 'Link options' }).first().click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
}

// ⚠ THE PREVIEW IS READ FROM LOCAL BYTES ONLY (`readFileBytes`), so the dialog
// can be open and complete-looking with an empty plate where the image goes.
// And, as with the Advanced search panel, a dialog taller than its viewport
// scrolls inside itself with the footer pinned, which photographs as whole.
async function editLinkWhole(page: Page): Promise<void> {
  const dialog = editLinkDialog(page);
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.getAnimations().every((a) => a.playState !== 'running')),
    )
    .toBe(true);
  await expect
    .poll(() =>
      dialog
        .locator('img')
        .evaluateAll(
          (images) =>
            images.length > 0 &&
            images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);

  const overflowing = await dialog.evaluate((element) =>
    [element, ...element.querySelectorAll('*')].some(
      (box) =>
        box.scrollHeight > box.clientHeight + 1 &&
        ['auto', 'scroll'].includes(getComputedStyle(box).overflowY),
    ),
  );
  if (overflowing) {
    throw new Error(
      'the Edit link dialog does not fit its viewport, so the capture would be cut off. ' +
        'Raise `edit-link`’s viewport height.',
    );
  }
  // The dialog opens with a field focused, and a ring round one input says the
  // picture is about that input.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
}

// Create-account's recovery step, for the figure on /docs/create-an-account —
// the step that page asks a reader not to skip.
//
// ⚠ NO ACCOUNT IS MADE, and the code in the picture opens nothing. The client
// mints the code when the step mounts and the server hears of neither it nor
// the username until one of the step's two buttons is pressed
// (`fillCredentialSteps`); the scene presses neither. So the string a reader
// sees is the right SHAPE and belongs to no account — which is the only kind
// of recovery code a public page should print. Do not "finish" this ceremony
// to tidy the run: that is what would make it a real one.
function recoveryStep(page: Page): Locator {
  // The auth card, whole: the step is not a `<form>` of its own, and the consent
  // line and the way back to Sign in under it are part of what this screen says.
  return page.locator('[data-slot="card"]').filter({ has: page.getByLabel('Your recovery code') });
}

async function reachRecoveryStep(page: Page): Promise<void> {
  await fillCredentialSteps(page, newCredentials());
}

async function recoveryCodeShown(page: Page): Promise<void> {
  await expect(page.getByLabel('Your recovery code')).not.toBeEmpty();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
}

export const SCENES: Scene[] = [
  {
    // ⚠ THE LANDING PAGE'S FIGURE. Three numbers hang together and
    // nothing checks them against each other — `docs/e2e.md`, _the marketing
    // screenshot_, has the table of what breaks when one moves.
    //
    // 1000 CSS sets the type size in the figure (it is displayed at 1088/1000 ≈
    // 1.09x, so the app's 14px row title lands at the site's own `text-body`)
    // AND the air between a title and the date column, which grows straight with
    // width. 760 is counted, not chosen: `56 + 6*107 + 62` puts six whole rows in
    // frame and cuts the seventh past its host line and before its tags. And
    // `aspect-[25/19]` in `apps/bracemark-site/src/app/page.tsx` is this ratio,
    // so `object-cover` crops nothing.
    //
    // `scale: 3` is the odd one out and is NOT a design number:
    // `make-image-variants.sh` refuses to upscale and the site ships a 2200px
    // variant, so a 1000px-wide capture has to be rastered at 3x to feed it.
    id: 'library-list',
    what: 'the landing page’s figure — My List, list layout, six rows and a bit',
    viewport: { width: 1000, height: 760 },
    scale: 3,
    // The seven links this frame can show live in the default inbox, so the title
    // and every visible row describe the same real My List state.
    goto: '/links',
    settle: settleMyList,
  },
  {
    // ⚠ PWA `narrow`. 390x844 CSS at DPR 3 = 1170x2532 = 2.164:1, which must
    // equal `profiles.pwaNarrow` exactly or the composer refuses the capture.
    // The ratio is the number to watch: Chrome drops a screenshot set whose long
    // side exceeds 2.3x the short one, and reports nothing when it does.
    //
    // Below `md`, so there is no rail: the topbar's title is the drawer's door
    // and the four actions are icon-only. Which means this picture carries NO
    // wordmark and no mark — see the `inputKeys` note wherever it is placed.
    id: 'library-narrow',
    what: 'the library as it opens on a phone — no rail, the title is the door',
    viewport: { width: 390, height: 844 },
    scale: 3,
    goto: '/links',
    settle: settleMyList,
  },
  {
    // The phone's search: below `md` the box is not in the bar at all — it is a
    // summoned row under it, revealed because a committed search makes
    // `searchVisible` true (view-state-provider). Landing on the URL is what
    // summons it, so there is nothing to click.
    id: 'search-narrow',
    what: 'a committed search on a phone — the summoned row over its results',
    viewport: { width: 390, height: 844 },
    scale: 3,
    goto: `/links?text=${SEARCH_WORD}`,
    settle: searchCommitted,
  },
  {
    // ⚠ PWA `wide`, and a wide screenshot is a DESKTOP one: 1280x800 CSS at DPR
    // 2 = 2560x1600 = 16:10, the median laptop viewport. Must equal
    // `profiles.pwaWide` exactly. (The v1 files were 4:3, which read as a
    // landscape tablet.)
    //
    // At this width the rail is present, so this picture DOES carry the wordmark
    // and the mark — `BrandLockup` at the rail's head.
    id: 'library-wide',
    what: 'the library on a laptop — the rail, the tree and the list together',
    viewport: { width: 1280, height: 800 },
    scale: 2,
    goto: '/links',
    settle: settleMyList,
  },
  {
    // The same search on a laptop, where the box lives in the topbar and the rail
    // stays put with NOTHING highlighted — a text search projects to
    // `selection.kind === 'none'`, so the sidebar cannot claim you are in a list
    // while the pane shows global results. That honesty is the picture.
    id: 'search-wide',
    what: 'a committed search on a laptop — no rail highlight, results only',
    viewport: { width: 1280, height: 800 },
    scale: 2,
    goto: `/links?text=${SEARCH_WORD}`,
    settle: searchCommitted,
  },
  {
    // ⚠ THE STORE LEG'S ONE bracemark-web SCENE, and its width is a contract with
    // a canvas rather than a design choice. The browser-extension listings show
    // where a saved tab lands, drawn inside a browser window the compositor
    // draws; 1152 is that window's content width — the 1280 canvas less its two
    // 64px gutters — so the capture lands at 1:1 and nothing resamples the app's
    // type. Retune it there and here together or the picture is rescaled
    // silently.
    //
    // 720 tall is deliberately MORE than the frame shows: the window runs off the
    // bottom of the canvas, the way the card's pane does, so the list reads as
    // continuing past the picture rather than stopping in it. What the extra
    // rows buy is room for that cut to land wherever the caption above leaves it.
    //
    // DPR 2 and not 3: this one is composed at 1:1 into a 1x canvas, so a third
    // raster would be thrown away. (`library-list` asks for 3 because
    // make-image-variants.sh refuses to upscale — a different constraint, one
    // step further downstream.)
    id: 'library-window',
    what: 'the library in a laptop window — the source for the store listings',
    viewport: { width: 1152, height: 720 },
    scale: 2,
    goto: '/links',
    settle: settleMyList,
  },
  {
    // ⚠ A DOCS FIGURE, and its contract is with `advanced-search` in
    // `apps/bracemark-site/src/content/figures.ts`: the entry there declares
    // the size this capture comes out at, and `figures.spec.ts` beside it fails
    // when the committed files disagree. The frame is the panel — `w-80`, so
    // 320 CSS px — and the page shows it at that width and no wider: a figure
    // in a docs page is read for its labels, and a phone's column is about
    // this wide.
    //
    // 1400 tall is room, not design: the panel is capped at 70vh, and 980px is
    // what holds all of it with the two checklists at their own cap. A laptop
    // shows the same panel scrolling; this is the one a tall window shows.
    // `advancedSearchWhole` fails the run if a new field outgrows it.
    //
    // `scale: 3` so a 320px figure has a 960px source for a DPR-3 phone.
    id: 'search-advanced',
    what: 'the docs figure on /docs/search — the Advanced search panel, whole',
    viewport: { width: 1280, height: 1400 },
    scale: 3,
    goto: '/links',
    prepare: buildAdvancedSearch,
    settle: advancedSearchWhole,
    frame: advancedSearchPanel,
  },
  {
    // ⚠ A DOCS FIGURE — `select-links` in the site's content/figures.ts. The
    // WHOLE viewport is the picture, so both numbers are the figure's: 390 is a
    // phone's width, where the web app is one column and the bar takes the
    // search row's slot; 420 is counted off THIS library's first three rows at
    // that width — `56 + 48 + 127 + 107`, the title bar, the selection bar and
    // two whole rows (the first title wraps to two lines), then 82 of the third:
    // past its host line and before its tags, the cut the landing figure makes.
    // A different first three links in `library.ts` wrap differently and move
    // the cut; nothing fails, the frame just ends mid-row somewhere worse.
    id: 'select-links',
    what: 'a docs figure — selection mode on a phone-width web app, two links ticked',
    viewport: { width: 390, height: 420 },
    scale: 3,
    goto: '/links',
    prepare: selectSomeLinks,
    settle: linksSelected,
  },
  {
    // ⚠ A DOCS FIGURE — `sync-status`. Framed on the row, so the viewport is
    // only what sets the row's width: 390 less the settings pane's gutters.
    id: 'sync-status',
    what: 'a docs figure — the Sync row in Settings → Data, settled',
    viewport: { width: 390, height: 844 },
    scale: 3,
    goto: '/settings/data',
    prepare: syncNow,
    settle: syncedJustNow,
    frame: syncRow,
  },
  {
    // ⚠ A DOCS FIGURE — `import-over-limit`, and the one scene on another
    // account (see `importTooManyLinks`). Framed on the question itself.
    id: 'import-over-limit',
    what: 'a docs figure — the import asking what to do with a file that does not fit',
    viewport: { width: 390, height: 844 },
    scale: 3,
    goto: '/settings/data',
    prepare: importTooManyLinks,
    settle: importAsked,
    frame: importQuestion,
    account: 'free-full',
  },
  {
    // ⚠ A DOCS FIGURE — `edit-link`. Framed on the dialog; 390 wide so the
    // dialog is the width a phone gives it, and tall enough that it does not
    // scroll (`editLinkWhole` fails the run when it would).
    id: 'edit-link',
    what: 'a docs figure — the Edit link dialog on a link with a fetched title and image',
    viewport: { width: 390, height: 1100 },
    scale: 3,
    goto: '/links',
    prepare: openEditLink,
    settle: editLinkWhole,
    frame: editLinkDialog,
  },
  {
    // ⚠ A DOCS FIGURE — `recovery-code`, and the one scene with nobody signed
    // in (see `recoveryStep`). `goto` is where `fillCredentialSteps` starts.
    id: 'recovery-code',
    what: 'a docs figure — create-account’s recovery step, before either button',
    viewport: { width: 390, height: 844 },
    scale: 3,
    goto: '/create-account',
    prepare: reachRecoveryStep,
    settle: recoveryCodeShown,
    frame: recoveryStep,
    // The card's top-right corner is the brand's fold, not a radius, so the
    // picture carries the card's whole edge on a margin of the page it sits on.
    bleed: 16,
    account: SIGNED_OUT,
  },
];

/**
 * Scenes by id, in CATALOG order rather than argv order, so a run's output does
 * not depend on how the ids were typed. No ids = every scene.
 */
export function selectScenes(ids: string[]): Scene[] {
  if (ids.length === 0) return SCENES;

  const wanted = new Set(ids);
  for (const id of wanted) {
    if (!SCENES.some((scene) => scene.id === id)) {
      throw new Error(`no scene \`${id}\`. Known: ${SCENES.map((scene) => scene.id).join(', ')}`);
    }
  }
  return SCENES.filter((scene) => wanted.has(scene.id));
}

/** One `launchApp`: a pixel density and the account signed in at it. */
export interface Launch {
  scale: number;
  /** A `seed/catalog.ts` key or `SIGNED_OUT`; undefined is the shot account. */
  account: string | undefined;
  scenes: Scene[];
}

/**
 * Scenes grouped by launch, each group in scene order, the groups in the order
 * their pair first appears. ⚠ This grouping is not a convenience —
 * `deviceScaleFactor` is fixed per browser context and so is the session, so a
 * group is exactly one `launchApp`.
 */
export function groupByLaunch(scenes: Scene[]): Launch[] {
  const groups: Launch[] = [];
  for (const scene of scenes) {
    const group = groups.find(
      (candidate) => candidate.scale === scene.scale && candidate.account === scene.account,
    );
    if (group) group.scenes.push(scene);
    else groups.push({ scale: scene.scale, account: scene.account, scenes: [scene] });
  }
  return groups;
}
