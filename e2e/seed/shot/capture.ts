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
import { groupByScale, type Scene, selectScenes } from './scenes';

// Every screenshot we publish of bracemark-web, made by driving the product.
//
//   npm run dev              # api + web + extractor
//   npm run shot:preflight   # check the URL list first — see ./preflight.ts
//   npm run shot             # every scene
//   npm run shot -- library-narrow search-narrow   # some
//   npm run shot -- --fresh  # wipe the account's data first (see below)
//
// What comes out: one PNG per scene in `e2e/.artifacts/shot/`. WHAT the scenes
// are — viewport, URL, and what "finished" means on that screen — is `scenes.ts`;
// this file is the apparatus every one of them needs. `library-list` is the
// marketing site's figure and is handed to `tools/scripts/make-image-variants.sh`
// (the run prints the exact command); the rest are consumed by the compositor
// that places the PWA install-dialog screenshots.
//
// ⚠ ONE LAUNCH PER DPR, and it is the trap this file exists to hold shut.
// `deviceScaleFactor` is a browser-CONTEXT option, so scenes at different scales
// cannot share a launch — and setting it per page does not fail, it just
// photographs everything at the first context's density. `groupByScale` is what
// the loop below iterates, and the account setup happens on the FIRST group only;
// later groups sign back into the same account and let it sync.
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

// The first pass over 26 links: one batched extract request (the server fans the
// URLs out), then an image per link pulled through the proxy at a small
// concurrency. Minutes, not seconds, and it is bounded by real sites.
const DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

// How long to chase the stragglers before capturing anyway. Sized for ONE
// backoff round: a transiently-failed facet cools for `backoff(attempts)` — ten
// minutes on the first failure, doubling, capped at a day (shared
// `sync/extraction.ts`) — so fifteen minutes buys the first retry and no more.
// Waiting for the second and third rounds was tried and is not worth it: the
// links still missing at that point are, by construction, below the fold of every
// frame we photograph, and a scene's own `settle` is what decides whether the
// picture is good.
const RETRY_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const scenes = selectScenes(argv.filter((arg) => !arg.startsWith('--')));
  const groups = groupByScale(scenes);
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

  console.log(
    `scenes: ${scenes.map((scene) => scene.id).join(', ')} — ` +
      `${groups.length} launch(es), one per DPR`,
  );

  // The account is set up ONCE, on the first group, and every later group signs
  // back into it. The setup is the expensive half — an import, a real-network
  // extraction drain, minutes of it — and none of it is DPR-dependent, so paying
  // it per density would double a ten-minute run for nothing.
  let prepared = false;
  const captured: string[] = [];

  for (const group of groups) {
    // A profile dir PER DPR, because `launchApp` wipes the one it is given (a
    // profile left by an earlier run holds a session for an account nobody has
    // the password for). Sharing one dir across groups would work — each launch
    // would just re-sign-in — but naming them apart keeps a failed run's state
    // readable afterwards.
    const app = await launchApp(profileDir(`shot-${group.scale}x`), {
      ...(existingId || prepared ? { existing: credentials } : { create: credentials }),
      deviceScaleFactor: group.scale,
    });

    try {
      const { page } = app;

      if (!prepared) {
        await prepareAccount(page, { existingId, archivePath, fresh });
        prepared = true;
      } else {
        // A fresh profile has an empty local store, so this launch is waiting for
        // the PULL rather than for a push: the links, the extraction records and
        // the preview blobs all come back down from the server before anything is
        // worth photographing. The scene's own `settle` is the real gate — it
        // fails loudly if the covers never arrive — but waiting here first turns
        // "the pictures are empty" into "the sync did not finish".
        await waitForSync(page);
      }

      for (const scene of group.scenes) captured.push(await shoot(page, scene));
    } finally {
      await app.close();
    }
  }

  console.log(`\ncaptured ${captured.length} scene(s):`);
  for (const path of captured) console.log(`  ${path}`);

  // The site's figure is the one capture with a downstream step attached; the
  // rest are read by the compositor, which is told where to look rather than
  // being handed a path here.
  const figure = captured.find((path) => path.endsWith('library-list.png'));
  if (figure) {
    console.log('\nNext, for the marketing site’s figure:');
    console.log(
      `  tools/scripts/make-image-variants.sh ${figure} \\\n` +
        `    apps/bracemark-site/public/screenshots/library-list`,
    );
    console.log(
      '  then check SCREENSHOT in apps/bracemark-site/src/app/page.tsx: `widths` is what\n' +
        '  the script prints, and the frame ratio must still match the scene’s viewport.',
    );
  }
}

/**
 * Everything that has to be true of the ACCOUNT before any scene is worth
 * photographing. Runs on one launch only — every step it takes is either
 * server-side (the plan grant, the import) or a synced setting, so a second
 * context sees all of it after a sync.
 */
async function prepareAccount(
  page: Page,
  options: { existingId: string | null; archivePath: string; fresh: boolean },
): Promise<void> {
  const userId = options.existingId ?? (await findUserId(SHOT_USER.username));
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
  if (options.fresh) await deleteAllData(page);

  await importArchive(page, options.archivePath);
  await waitForSync(page);

  await enableServerExtraction(page);
  await fillPreviews(page);
  await useListLayout(page);
  // The drain wrote an `extractions/` record and a `files/` blob per link, all
  // of which are pending ops. Not strictly needed for the photograph — the
  // rendering reads Dexie, not the server — but this account is meant to be
  // signed back into, and the NEXT DPR group reads its library back off the
  // server, so leaving it half-pushed would photograph a partial library.
  await waitForSync(page);
}

/**
 * One scene, one PNG. The viewport is set per scene (fine — only the DPR is fixed
 * per context), and `scale: 'device'` is what makes the output `viewport × scale`
 * rather than CSS pixels.
 */
async function shoot(page: Page, scene: Scene): Promise<string> {
  console.log(`\nscene ${scene.id} — ${scene.what}`);
  await page.setViewportSize(scene.viewport);
  await page.goto(scene.goto);
  if (scene.prepare) await scene.prepare(page);
  await scene.settle(page);

  await mkdir(SHOT_OUTPUT, { recursive: true });
  const path = join(SHOT_OUTPUT, `${scene.id}.png`);
  await page.screenshot({ path, scale: 'device' });
  const { width, height } = scene.viewport;
  console.log(`  ${width * scene.scale}x${height * scene.scale} → ${path}`);
  return path;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
