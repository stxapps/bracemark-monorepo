import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, type Page } from '@playwright/test';

import { profileDir, SEED_ARCHIVES, SHOT_OUTPUT } from '../../paths';
import { waitForApi } from '../../runner/lib';
import { launchApp } from '../../web/fixtures/launch';
import { buildBackupArchive } from '../archive';
import { seedPassword } from '../catalog';
import { findUserId, grantPlan, readGrantedPlan } from '../plan';
import { importArchive, waitForSync } from '../seed';
import { buildShotLibrary, SHOT_USER } from './library';

// The marketing site's one screenshot, made by driving the product.
//
//   npm run dev              # api + web + extractor
//   npm run shot:preflight   # check the URL list first — see ./preflight.ts
//   npm run shot
//   npm run shot -- --fresh  # wipe the account's data first (see below)
//
// What comes out: `e2e/.artifacts/shot/library-list.png`, a 3000x2280 capture of
// the LIST layout, which is then handed to `tools/scripts/make-image-variants.sh`
// (the last lines below print the exact command). The site's `SCREENSHOT` const in
// apps/bracemark-site/src/app/page.tsx carries the rest of the hand-off.
//
// WHY THE LIST AND NOT THE CARD GRID. It photographed the cards first, and the
// argument for the swap is two-sided. It is the DEFAULT — `_panes/main.tsx`
// resolves `LAYOUTS[linksLayout] ?? ListLayout` — so the grid was advertising a
// mode a visitor has to go and turn on. And a wall of twelve full-bleed
// photographs is the loudest thing on a page whose whole design is achromatic
// except for one petrol accent (page.tsx's design note): the covers read as
// somebody else's brand colours stacked twelve high, and the band under them
// went quiet. A list renders the same covers at 64x40 — present, still doing the
// "these are real pages" job — and spends the rest of the frame on the type and
// the rules, which are the page's own material.
//
// THE POINT OF DOING IT THIS WAY. The band this picture sits in claims that a
// private library is still a library, and the placeholder it replaces is a
// labelled box precisely because the alternative — a convincing mock grid — is
// the trap the site has already fallen into once (the hero's hand-typed
// ciphertext). So nothing in the finished image is authored: the archive carries
// bare URLs, `bracemark-extractor` fetches the titles and the covers, the client
// decrypts and lays them out, and the capture is of whatever that produced. If a
// page has no og:image the row's slot is a monogram, and the honest fix is a
// different URL rather than a different screenshot.
//
// It is a SEPARATE ENTRY POINT from `npm run seed`, not a fifth account in it.
// The four seeded accounts are a 2x2 that a dev session wants filled and this one
// is not part of that shape: it exists for one asset, its library is a hand-typed
// list rather than the generator, and — unlike every other thing in e2e/ — it
// deliberately fetches real, public URLs off the machine it runs on.

// The capture geometry, and every number in it is load-bearing. It is also the
// figure's own ratio — `aspect-[25/19]` on the frame and the `width`/`height` on
// the <img> — so `object-cover` crops nothing and what is framed here is exactly
// what ships.
//
// THE WIDTH SETS THE TYPE SIZE. The figure is 1088 CSS px at the desktop cap
// (make-image-variants.sh derives that from `Band`'s max-w-6xl inside lg:px-8), so
// a capture W CSS px wide is displayed at 1088/W. At 1000 that is 1.09x — the
// app's 14px row title lands at ~15px, which is the site's own `text-body`, and
// the screenshot reads as continuous with the prose around it rather than as a
// thumbnail of a different document. The card grid was captured at 1600 and
// therefore displayed at 0.68x, which a grid of photographs survives and a list of
// 14px type does not.
//
// THE WIDTH ALSO SETS THE DEAD SPACE. The row is `flex`: the text column takes
// `flex-1` and the date column is `shrink-0` against the right edge, so every
// pixel of pane width past the title's own ink becomes air between the two. The
// sidebar is a fixed 240 and the date column's right edge sits ~121 in, so the gap
// after a short title ("Belém Tower - Wikipedia" is ~166px of ink) grows straight
// with W: ~38% of the frame at 1000, ~44% at 1100, ~52% at 1280. 1000 is the
// narrowest setting that still keeps the date column at all — it is gated on the
// PANE reaching `@xl` (576px), and 1000 - 240 = 760 clears it with room. Below
// ~816 the column vanishes and the picture stops showing the sorted field.
//
// THE HEIGHT IS COUNTED, NOT CHOSEN. The header is 56 and every row in this
// library measures exactly 107 (14 + title 20 + 2 + host 20 + 12 + one chip line
// 24 + 14 + 1 — the four shapes are enumerated in list-layout.tsx; these links all
// have tags and none wraps to a second title line at this width). So
//
//   56 + 6*107 + 62 = 760
//
// puts six whole rows in the frame and cuts the seventh 62px in — past its
// thumbnail (40, ending at 56), its title and its host line, and before its tag
// strip. A partial row is wanted: it is what says the library continues. WHERE it
// is cut is the part worth keeping — land in the first 14 and the frame ends on an
// empty sliver of padding, land at 20-34 and it slices a line of type in half.
// Re-derive this if the row ever changes shape.
const SHOT_WIDTH = 1000;
const SHOT_HEIGHT = 760;

// Raster density, and NOT a design choice — see `deviceScaleFactor` in
// web/fixtures/launch.ts. make-image-variants.sh never upscales and the site's
// widest variant is 2200, so at the default 2 a 1000px-wide capture (2000 device
// px) could not produce one. 3 hands it 3000x2280 and every variant is a
// downscale.
const SHOT_SCALE = 3;

// The first pass over 26 links: one batched extract request (the server fans the
// URLs out), then an image per link pulled through the proxy at a small
// concurrency. Minutes, not seconds, and it is bounded by real sites.
const DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

// How long to chase the stragglers before capturing anyway. Sized for ONE
// backoff round: a transiently-failed facet cools for `backoff(attempts)` — ten
// minutes on the first failure, doubling, capped at a day (shared
// `sync/extraction.ts`) — so fifteen minutes buys the first retry and no more.
// Waiting for the second and third rounds was tried and is not worth it: the
// links still missing at that point are, by construction, below the fold of a
// six-and-a-bit-row frame, and `capture()` is what decides whether the picture is
// good.
const RETRY_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const fresh = process.argv.slice(2).includes('--fresh');
  await waitForApi();

  const now = Date.now();
  const library = buildShotLibrary(now);
  await mkdir(SEED_ARCHIVES, { recursive: true });
  const archivePath = join(SEED_ARCHIVES, 'shot.zip');
  await writeFile(archivePath, buildBackupArchive(library));
  console.log(
    `archive: ${library.counts.links} links, ${library.counts.lists} lists, ` +
      `${library.counts.tags} tags, no extractions → ${archivePath}`,
  );

  const credentials = {
    username: SHOT_USER.username,
    password: seedPassword(SHOT_USER.key),
  };
  const existingId = await findUserId(SHOT_USER.username);
  console.log(existingId ? 'account exists — signing in' : 'creating account (Argon2id, ~seconds)');

  const app = await launchApp(profileDir('shot'), {
    ...(existingId ? { existing: credentials } : { create: credentials }),
    deviceScaleFactor: SHOT_SCALE,
  });

  try {
    const { page } = app;

    const userId = existingId ?? (await findUserId(SHOT_USER.username));
    if (!userId) throw new Error(`no user id for ${SHOT_USER.username} after create-account`);
    await grantPlan(userId, SHOT_USER.plan);
    if ((await readGrantedPlan(userId)) !== SHOT_USER.plan) {
      throw new Error('plan grant did not land');
    }
    await page.reload();

    // `--fresh` — wipe the account's data before importing, and reach for it
    // whenever the fixture itself has changed.
    //
    // A Bracemark backup merges SKIP-EXISTING BY PATH (docs/data-lifecycle.md),
    // so re-running against an account that already has these ids imports
    // nothing: edit a URL in shot/library.ts, re-run, and you photograph the OLD
    // library while the log cheerfully reports a clean import. The big seed
    // carries the same caveat and answers it with "delete all data by hand
    // first"; this run does it through the same two controls, because it is the
    // difference between a screenshot that reflects the list and one that does
    // not.
    //
    // It is also the way out of a stuck drain. A link that keeps failing
    // transiently climbs `backoff(attempts)` — 10 minutes, then 20, then 40 —
    // and the ladder is stored on the facet, so it survives re-runs and a run
    // started late in it can spend its whole budget waiting for a single retry
    // window. A wipe drops the facets with everything else and the next import
    // starts the ladder from zero.
    if (fresh) await deleteAllData(page);

    await importArchive(page, archivePath);
    await waitForSync(page);

    await enableServerExtraction(page);
    await fillPreviews(page);
    await useListLayout(page);
    // The drain wrote an `extractions/` record and a `files/` blob per link, all
    // of which are pending ops. Not strictly needed for the photograph — the
    // rendering reads Dexie, not the server — but this account is meant to be
    // signed back into, and leaving it half-pushed is the failure seed.ts's own
    // wait exists to prevent.
    await waitForSync(page);

    const path = await capture(page);
    console.log(`\ncaptured ${path}`);
    console.log('\nNext:');
    console.log(
      `  tools/scripts/make-image-variants.sh ${path} \\\n` +
        `    apps/bracemark-site/public/screenshots/library-list`,
    );
    console.log(
      '  then check SCREENSHOT in apps/bracemark-site/src/app/page.tsx: `widths` is what\n' +
        '  the script prints, and the frame ratio must still match SHOT_WIDTH/SHOT_HEIGHT.',
    );
  } finally {
    await app.close();
  }
}

// Settings → Data → Delete all data, through the checkbox gate and the button it
// arms. Destructive by definition, which is why it is behind a flag and never the
// default — but the account it destroys is a local, throwaway fixture whose
// password is derived from its key, so there is nothing here to lose that
// `npm run shot` does not rebuild in the next ten minutes.
async function deleteAllData(page: Page): Promise<void> {
  await page.goto('/settings/data');
  // Two controls named "Delete all data", one after the other: the Data pane's
  // drill-down ROW (SettingsRow with an `onClick` renders the whole row as a
  // button) and then the destructive button inside the view it opens. They are
  // never on screen together — the view replaces the pane — so the same query
  // run twice is unambiguous each time, and it is what a person's two clicks are.
  await page.getByRole('button', { name: 'Delete all data' }).click();
  await page.getByRole('checkbox', { name: /absolutely sure/ }).click();
  await page.getByRole('button', { name: 'Delete all data' }).click();
  // Both receipts, because an empty account is a legitimate state to run this
  // from — a first `--fresh` run, or a re-run after one that died mid-import.
  // Waiting only for the "deleted N items" half would hang on exactly the case
  // where there was nothing to do.
  await expect(
    page.getByText(/^(All your data has been deleted|There was no data to delete)/),
  ).toBeVisible({ timeout: 5 * 60 * 1000 });
  console.log('deleted all data');
}

// The privacy-load-bearing opt-in, taken through the real Switch.
//
// It could have been set in the archive's settings blob — `serverExtraction` is
// an ordinary field on `settings/general` and the import would land it. Doing it
// here instead buys a check worth more than the click costs: a FREE account is
// shown "Upgrade to Plus" where this switch would be, so a plan grant that
// reached D1 but not the client fails here, loudly, with the toggle missing —
// rather than thirty seconds later as a wall of monograms that looks like a bad
// URL list.
async function enableServerExtraction(page: Page): Promise<void> {
  await page.goto('/settings/extraction');
  const toggle = page.getByRole('switch', { name: 'Server-side previews' });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('data-state')) !== 'checked') await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'checked');
  console.log('server extraction on');
}

// Settings → Misc → Layout → List, taken through the real radio for the same
// reason `enableServerExtraction` takes the real Switch: a value written straight
// into the archive's settings blob would land silently, and a picture of the wrong
// layout is not something the run could then notice.
//
// It is asserted rather than assumed even though `list` is already the default
// (`DEFAULT_LINKS_LAYOUT`, and `_panes/main.tsx` falls back to `ListLayout`),
// because the account is REUSED across runs and `linksLayout` SYNCS: one manual
// click in the app — or on any other device signed into this fixture — is
// persisted, restored on the next sign-in, and would silently photograph cards.
//
// The synced setting is the one to write, not the device-local override: the
// device tab only takes effect while `linksLayoutSource` is `local`
// (use-settings.ts), and this account has never set that, so the sync tab is what
// the page is actually reading. Nothing here touches the source toggle.
async function useListLayout(page: Page): Promise<void> {
  await page.goto('/settings/misc');
  const list = page.getByRole('radio', { name: 'List' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('data-state')) !== 'checked') await list.click();
  await expect(list).toHaveAttribute('data-state', 'checked');
  console.log('list layout on');
}

// Fill in every preview slot, and keep at it until they ARE every slot. Two phases, and
// each one exists because the other cannot do its half — the comments inside say
// which failure taught us that.
async function fillPreviews(page: Page): Promise<void> {
  const total = SHOT_USER.links;
  await page.goto('/settings/extraction');

  // PHASE 1 — the extract-all job, watched WITHOUT navigating.
  //
  // `extractAll()` is client state on the provider, so a full page load ENDS it.
  // That matters more than it sounds: an earlier version of this function polled
  // by re-visiting `/settings/extraction` every thirty seconds, which cancelled
  // the job on every pass and restarted nothing — it sat at 0 of 24 while the
  // log looked like a slow network. So this phase stays on the page it started
  // on and watches the section's own controls change under it; everything here
  // is a liveQuery, so nothing needs a reload to update.
  //
  // The signal that the job is over is the Pause button going away: the slot
  // renders Pause while `isExtractingAll`, and reverts to "Generate all" when the
  // cursor walk reaches the end of the library and clears extract-all mode.
  const generateAll = page.getByRole('button', { name: 'Generate all' });
  await expect(generateAll).toBeVisible();

  // READ THE COUNTS BEFORE READING THE BUTTON, which is the opposite of the
  // obvious order and the reason this ran for several captures doing half its
  // job. "Generate all" is `disabled={pendingCount === 0}`, and `pendingCount`
  // comes from `useExtractionCounts` — an on-demand liveQuery that has no result
  // for the first moment after the section mounts. So immediately after an
  // import the button is momentarily disabled because the count is *unknown*,
  // not because there is nothing to do; sampling `isEnabled()` there skipped the
  // click altogether, extract-all never started, and the whole library got
  // dragged in by phase two's scrolling instead. It still finished, which is
  // exactly why nobody would look: the only symptom was `previewed 0/25` logged
  // between two phases that both appeared to work.
  //
  // Waiting for the progress line is waiting for that query to answer, so the
  // button's state means something by the time it is read.
  let progress = await readSettledCount(page);

  if (!isComplete(progress, total)) {
    await expect(generateAll).toBeEnabled({ timeout: 60_000 });
    await generateAll.click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    // Both halves, in this order, and the first one is not redundant.
    // `toBeHidden` is satisfied by the very first poll, and right after Confirm
    // that poll can land before React has swapped the button slot — so waiting
    // only for Pause to GO AWAY returns instantly, before the job has started.
    // Waiting for Pause to appear first is safe because the job cannot finish
    // inside the window — it is a fetch per link against real sites — so a Pause
    // that never shows means the press did not take, which is worth failing on.
    const pause = page.getByRole('button', { name: /Pause/ });
    await expect(pause).toBeVisible({ timeout: 30_000 });
    await expect(pause).toBeHidden({ timeout: DRAIN_TIMEOUT_MS });

    // Let the counts SETTLE before reporting them. They are still being written
    // as the job ends, so the reading available the instant Pause disappears is
    // a stale one.
    progress = await readSettledCount(page);
  }

  let lastReport = report(progress, total);
  console.log(`previewed ${lastReport}`);
  if (isComplete(progress, total)) return;

  // PHASE 2 — the stragglers, which need a different mechanism entirely.
  //
  // A link whose fetch failed TRANSIENTLY (a slow site against the extractor's
  // 8s per-hop timeout, or a 429 from its own per-IP cap during the image pass)
  // has a `failed` facet. That leaves the pending bucket immediately, so the
  // screen now reads Pending 0 with Generate all DISABLED — it gates on the
  // pending count — while two rows have no cover. There is no button to press.
  //
  // The auto drain is what retries it, once `backoff(attempts)` has elapsed: ten
  // minutes, doubling. But the auto drain is DISPLAYED-scoped
  // (`reportDisplayedLinkPaths`) and the list is virtualized, so it only
  // ever looks at the rows near the viewport — and a failure below the fold is
  // never re-scanned while a run parks at the top of the page. That is exactly
  // where this stuck the first time, at 22 of 24, looking for all the world like
  // a bad URL. So phase 2 WALKS THE LIST, which is the gesture the provider's
  // cost model is built around and the only thing that reaches those rows.
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A PERMANENT failure is not something to wait out — it is settled on every
    // device forever, so the loop would spin to its deadline and then report a
    // timeout for what is really a bad URL. The section renders this paragraph
    // only when the count is non-zero, which makes it the cheapest true reading.
    const permanent = page.getByText(/^Won’t retry means the page gave us nothing/);
    if (await permanent.isVisible()) {
      throw new Error(
        `a link settled as permanent — it will never get a cover. Run ` +
          `\`npm run shot:preflight\` and replace it in seed/shot/library.ts.`,
      );
    }

    await page.goto('/links?list=all');
    await scrollThroughList(page);

    await page.goto('/settings/extraction');
    progress = await readPreviewedCount(page);
    const line = report(progress, total);
    if (line !== lastReport) {
      console.log(`previewed ${line}`);
      lastReport = line;
    }
    if (isComplete(progress, total)) return;
  }
  // Running out of budget is a WARNING here, not a failure, and the split is
  // deliberate: this function is about the whole library, and the photograph is
  // not. The frame holds six rows and a bit over a virtualized list, so what ships
  // is the top seven links — and `capture()` below hard-fails if any row IN THE
  // PICTURE is wearing a monogram. Gating on all 24 instead would spend forty
  // minutes waiting for rows nobody will ever see, and then throw away a perfectly
  // good capture over them.
  //
  // The shortfall is still worth saying out loud, because it is the honest
  // reading of the library the account is left holding.
  console.warn(
    `\nWARNING: ${lastReport} previewed after ${RETRY_TIMEOUT_MS / 60_000} minutes. The rest ` +
      `are cooling off after a transient failure — a slow site against the extractor’s 8s ` +
      `per-hop timeout, or its per-IP cap during the image pass. The backoff ladder is ` +
      `stored on the facet, so a plain re-run resumes ` +
      `mid-ladder; \`npm run shot -- --fresh\` starts the attempt counts at zero.`,
  );
  console.warn('Capturing anyway — the frame is gated on the rows it actually shows.\n');
}

// Walk the list top to bottom and back, pausing at each step so the newly mounted
// rows are reported as displayed and the drain gets a turn at them. The step is a
// viewport at a time; the pauses are what make the pass useful rather than a
// scrollbar animation.
async function scrollThroughList(page: Page): Promise<void> {
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    await page.evaluate((fraction) => {
      const doc = document.scrollingElement ?? document.documentElement;
      // The list may scroll in its own pane rather than the document, so move
      // whichever one actually has overflow.
      const pane = [...document.querySelectorAll('*')].find(
        (element) => element.scrollHeight > element.clientHeight + 40,
      );
      const target = pane ?? doc;
      target.scrollTop = (target.scrollHeight - target.clientHeight) * fraction;
    }, i / steps);
    await page.waitForTimeout(4_000);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

// The section's own progress line — "N of M links previewed." — which is what a
// person watches, and the one reading that means what this run needs. The Pending
// stat does NOT: it reaches zero while transiently-failed links sit in backoff
// with no cover, so a wait on it returns early with holes in the wall.
//
// BOTH numbers are read, and the second one is the subtle part. `M` is the
// section's OWN total — `done + pending + failedTransient + failedPermanent`,
// counted off the facets — so it is not `SHOT_USER.links` by definition, and it
// is briefly smaller than it while the import's rows are still landing. Matching
// the line against a hard-coded 24 therefore misses it entirely on an early poll
// and the run reports `?/24` for a library that is fine. Read what the line says,
// and let the caller decide whether it says enough.
interface PreviewProgress {
  done: number;
  total: number;
}

async function readPreviewedCount(page: Page): Promise<PreviewProgress | null> {
  // Poll rather than read once. The line is fed by `useExtractionCounts`, an
  // ON-DEMAND liveQuery mounted with the section, so for a second or two after
  // every navigation it has no result and the section renders "No links to
  // preview yet." instead — which matches nothing here. A single read therefore
  // returned null on roughly every other pass and printed `?/25` for a library
  // that was fine, turning a progress log into noise nobody could act on.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = page.getByText(/^\d+ of \d+ links? previewed\.$/);
    if (await line.isVisible()) {
      const match = (await line.innerText()).match(/^(\d+) of (\d+)/);
      if (match) return { done: Number(match[1]), total: Number(match[2]) };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(1_000);
  }
}

// Read the progress line repeatedly until it stops moving — the counts are still
// being written when the drain ends, so the first reading is never the final one.
async function readSettledCount(page: Page): Promise<PreviewProgress | null> {
  let previous: PreviewProgress | null = null;
  let stable = 0;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const current = await readPreviewedCount(page);
    stable = current && previous && current.done === previous.done ? stable + 1 : 0;
    previous = current;
    if (stable >= 2 || Date.now() >= deadline) return current;
    await page.waitForTimeout(2_000);
  }
}

// Is every link in the library previewed? Both halves matter: the section can
// truthfully say "18 of 18" while six of this fixture's links have not been
// counted yet, and that reads as finished.
function isComplete(progress: PreviewProgress | null, links: number): boolean {
  return progress !== null && progress.total === links && progress.done === links;
}

function report(progress: PreviewProgress | null, links: number): string {
  return progress ? `${progress.done}/${progress.total}` : `?/${links}`;
}

// The photograph. Show All (`?list=all`) rather than the default My List: every
// link in this library is filed in one of the ten named lists, so the default
// view is genuinely empty, and Show All is the only view that spans them — which
// is also the one the figure's alt text describes ("one row per link … beside a
// sidebar of lists and tags").
async function capture(page: Page): Promise<string> {
  await page.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
  await page.goto('/links?list=all');

  // The two things that have to be true of the picture, and neither is what
  // "wait for the images" first looks like.
  //
  // FIRST: no row may be wearing a MONOGRAM. `LinkPreviewImage` renders an
  // `<img>` only once the bytes are in hand; with no image it renders
  // `PreviewFallbackIcon`/`PreviewFallbackPanel`, a `<div>` — so "every img has
  // loaded" is satisfied vacuously by a column of monograms, the exact picture
  // this run exists to avoid, passing the check meant to catch it. Every branch
  // takes the SLOT's own `h-10 w-16` (list-layout.tsx sizes the box and
  // link-media.tsx passes that className straight through all three), so counting
  // the slots and counting the `<img>`s among them is the reading that means
  // something.
  //
  // Matching on the two size classes rather than on one distinctive one, because
  // there isn't one: the card grid had `aspect-12/7`, which nothing else on the
  // page wore, where `h-10` and `w-16` are ordinary utilities that are only this
  // slot IN COMBINATION. `PreviewFallbackIcon` nests a second `<img>` inside the
  // slot for the favicon it escalates through — that one is `size-4`, so it is not
  // caught here, and a row showing it is correctly counted as a slot with no
  // cover.
  //
  // SECOND: every one of those images DECODED. The list pulls each preview out of
  // `files/` as its row mounts (rows are virtualized, so mounted = displayed),
  // which means an `<img>` can be attached and on screen with nothing in it yet.
  // `naturalWidth` is the only reading that says the bytes arrived.
  //
  // Both are scoped to what is MOUNTED rather than to all 26 links, and that is
  // correct rather than a compromise: the virtualizer only builds the rows near
  // the viewport, and the rows near the viewport are precisely what gets
  // photographed.
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

  // THIRD: let the FAVICONS land. They are fetched per host through the same
  // extractor, one `GET /v1/image` each, bounded to `MAX_IN_FLIGHT` with a
  // stagger so they never compete with the previews (web-react's
  // FaviconProvider) — which means they are still arriving for several seconds
  // after every cover has decoded. Capturing on the covers alone caught the page
  // mid-fill: every row correct, and a column of empty grey plates where the site
  // marks go, which reads as a half-loaded page rather than as a product. The
  // list layout prints the host as TEXT beside each one, so a missing mark is more
  // conspicuous here than it was in the grid, not less.
  //
  // Located positively, on the host line's own `size-3.5`, rather than as "every
  // img that is not a cover" — that negation was written when the cover carried a
  // class nothing else did, and against `h-10 w-16` it would also sweep in
  // `PreviewFallbackIcon`'s nested favicon and count it twice.
  //
  // This waits for the count to STOP CHANGING rather than for some number of
  // them, and that is deliberate: a host that serves no `/favicon.ico` records
  // `none` and `Favicon` renders its quiet plate forever, which is a correct final
  // state and not something to wait out. Quiescence is the only condition that is
  // true of both outcomes. Three of this library's hosts land there.
  const favicons = page.getByRole('main').locator('img[class~="size-3.5"]');
  let settled = 0;
  let previous = -1;
  while (settled < 3) {
    await page.waitForTimeout(2_000);
    const count = await favicons.count();
    settled = count === previous ? settled + 1 : 0;
    previous = count;
  }

  await mkdir(SHOT_OUTPUT, { recursive: true });
  const path = join(SHOT_OUTPUT, 'library-list.png');
  await page.screenshot({ path, scale: 'device' });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
