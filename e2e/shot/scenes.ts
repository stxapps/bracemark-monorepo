import { expect, type Page } from '@playwright/test';

// WHAT to photograph. `web.ts` is the HOW, and the split is the point: the
// account, the import, the extraction drain and the waits are one apparatus that
// every picture needs, and the only thing that varies between pictures is a
// viewport, a URL and what "finished" means on that screen.
//
// One scene = one PNG at `e2e/.artifacts/shot/<id>.png`, at `viewport × scale`
// device pixels. Nothing here knows where a picture ends up — the marketing
// site's figure and the PWA install dialog's screenshots are both just scenes,
// and the mapping from scene to destination lives with the compositor.
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
   * groups on this field and launches once per group. Getting that wrong does not
   * throw; it silently photographs everything at the first group's DPR.
   */
  scale: number;
  /** Path after `WEB_URL`. */
  goto: string;
  /** Clicks before the shot. Omit when the URL alone puts the app in the state. */
  prepare?: (page: Page) => Promise<void>;
  /** The wait that means "finished". Never `waitForTimeout` — see below. */
  settle: (page: Page) => Promise<void>;
}

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
// is 26 links across 10 lists, so every filter lands 2–5 rows and leaves air
// under them — Show All is the only view that fills a screen. Look at it in
// `--preview`: if the air reads as an empty product rather than as a narrowed
// one, the fix is a longer library in `library.ts`, not a broader search word.
async function searchCommitted(page: Page): Promise<void> {
  // The box is `value={text}`, seeded from the committed query, so this asserts
  // the URL actually reached the UI — a parse regression would otherwise
  // photograph an empty box over a filtered list and look like a design choice.
  // `textbox`, not `searchbox`: the field is web-ui's `Input` with no `type`, so
  // it is a plain text input inside a `role="search"` form.
  await expect(page.getByRole('textbox', { name: 'Search links' })).toHaveValue(SEARCH_WORD);
  await settleList(page);
}

export const SCENES: Scene[] = [
  {
    // ⚠ THE MARKETING SITE'S ONLY SCREENSHOT. Three numbers hang together and
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
    what: 'the marketing site’s figure — Show All, list layout, six rows and a bit',
    viewport: { width: 1000, height: 760 },
    scale: 3,
    // Show All rather than the default My List: every link in this library is
    // filed in one of the ten named lists, so the inbox is genuinely empty, and
    // Show All is the only view that spans them — which is also the one the
    // figure's alt text describes.
    goto: '/links?list=all',
    settle: settleList,
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
    goto: '/links?list=all',
    settle: settleList,
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
    goto: '/links?list=all',
    settle: settleList,
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
    goto: '/links?list=all',
    settle: settleList,
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

/**
 * Scenes grouped by DPR, each group in scene order, the groups in the order their
 * scale first appears. ⚠ This grouping is not a convenience — `deviceScaleFactor`
 * is fixed per browser context, so a group is exactly one `launchApp`.
 */
export function groupByScale(scenes: Scene[]): { scale: number; scenes: Scene[] }[] {
  const groups: { scale: number; scenes: Scene[] }[] = [];
  for (const scene of scenes) {
    const group = groups.find((candidate) => candidate.scale === scene.scale);
    if (group) group.scenes.push(scene);
    else groups.push({ scale: scene.scale, scenes: [scene] });
  }
  return groups;
}
