import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, type Page } from '@playwright/test';

import { profileDir, SHOT_ARCHIVE } from '../paths';
import { waitForApi } from '../runner/lib';
import { buildBackupArchive } from '../seed/archive';
import { seedPassword } from '../seed/catalog';
import { findUserId, grantPlan, readGrantedPlan } from '../seed/plan';
import { deleteAllData, importArchive, waitForSync } from '../seed/steps';
import { launchApp } from '../web/fixtures/launch';
import { buildShotLibrary, SHOT_USER } from './library';

// THE ACCOUNT every published screenshot is taken of — built once, photographed
// by three separate legs.
//
//   npm run dev              # api + web + extractor (the extractor is the point)
//   npm run shot:preflight   # check the URL list first — seconds, no browser
//   npm run shot:account        # this: account → plan → import → extract → sync
//   npm run shot:account -- --fresh   # …wiping the account's data first (see below)
//
// Then the three consumers, in any order and as often as you like:
// `npm run shot:web`, `npm run shot:ext`, `npm run shot:mobile -- ios|android`.
// Each one signs in and photographs what it finds; none of them builds anything,
// and each fails with a pointer back here if the account is missing.
//
// THE SPLIT IS THE POINT. This half is minutes of real network — a batched
// extract over 26 live sites, then an image per link through the proxy — and it
// is the same work whatever is being photographed. Re-running a capture because a
// viewport moved by 40px should not re-run any of it, and before the split it
// did: one entry point meant every re-capture re-walked the whole drain, and the
// only way to photograph the web scenes was to rebuild the account first.
//
// It is a SEPARATE FIXTURE from `npm run seed:accounts`, not a fifth account in
// it. The four seeded accounts are a 2x2 that a dev session wants filled and this
// one is not part of that shape: it exists for one asset, its library is a
// hand-typed list rather than the generator, and — unlike every other thing in
// e2e/ — it deliberately fetches real, public URLs off the machine it runs on.
//
// WHAT IT LEAVES BEHIND, and why each step is here rather than in the archive.
// The plan grant is server state (../plan.ts). The import is the only way links
// can exist at all — they are E2E encrypted, so a signed-in client is the only
// writer there is. `serverExtraction` and `linksLayout` are ordinary synced
// settings that the archive COULD carry, and are taken through the real controls
// anyway: each click doubles as a check that something upstream landed, and the
// comments on those two functions say which failure taught us that.

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
  const fresh = process.argv.slice(2).includes('--fresh');
  await waitForApi();

  // Regenerated every run, exactly as `seed:accounts` regenerates its four: the
  // archive is derived from ./library.ts and costs milliseconds, so a stale one on
  // disk is a trap with no upside. What it does NOT do is re-import itself over an
  // account that already holds these ids — see `--fresh` on `prepareAccount`.
  const now = Date.now();
  const library = buildShotLibrary(now);
  await mkdir(dirname(SHOT_ARCHIVE), { recursive: true });
  await writeFile(SHOT_ARCHIVE, buildBackupArchive(library));
  console.log(
    `archive: ${library.counts.links} links, ${library.counts.lists} lists, ` +
      `${library.counts.tags} tags, no extractions → ${SHOT_ARCHIVE}`,
  );

  const credentials = {
    username: SHOT_USER.username,
    password: seedPassword(SHOT_USER.key),
  };
  const existingId = await findUserId(SHOT_USER.username);
  console.log(existingId ? 'account exists — signing in' : 'creating account (Argon2id, ~seconds)');

  // One launch, one profile, and it is closed on the way out — `launchApp` wipes
  // the directory it is given, so the session for an account whose password is
  // derived rather than recorded never outlives the run (../../paths.ts).
  const app = await launchApp(profileDir('shot-seed'), {
    ...(existingId ? { existing: credentials } : { create: credentials }),
  });
  try {
    await prepareAccount(app.page, { existingId, fresh });
  } finally {
    await app.close();
  }

  console.log(`\n${SHOT_USER.username} is ready.`);
  console.log('  npm run shot:web                 # the site figure + the PWA install dialog');
  console.log('  npm run shot:ext                 # the browser extension popup');
  console.log('  npm run shot:mobile -- ios       # the native store captures');
}

/**
 * Everything that has to be true of the ACCOUNT before any scene is worth
 * photographing. Every step is either server-side (the plan grant, the import) or
 * a SYNCED setting, which is what makes the split safe: the three capture legs
 * sign in on their own fresh profiles and pull all of it back down.
 */
async function prepareAccount(
  page: Page,
  options: { existingId: string | null; fresh: boolean },
): Promise<void> {
  const userId = options.existingId ?? (await findUserId(SHOT_USER.username));
  if (!userId) throw new Error(`no user id for ${SHOT_USER.username} after create-account`);
  await grantPlan(userId, SHOT_USER.plan);
  if ((await readGrantedPlan(userId)) !== SHOT_USER.plan) {
    throw new Error('plan grant did not land');
  }
  await page.reload();

  // `--fresh` — wipe the account's data before importing, and reach for it
  // whenever the fixture itself has changed. It belongs to THIS step and no
  // longer to the capture: wiping is something done to an account, and the legs
  // that photograph one have no business doing it.
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

  await importArchive(page, SHOT_ARCHIVE);
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

  // ⚠ A DISABLED `Generate all` IS NOT A FAILURE HERE — it is PHASE TWO'S CASE
  // ARRIVING EARLY, and this used to throw on it. The button is
  // `disabled={pendingCount === 0}`, and a link whose fetch failed transiently
  // leaves the pending bucket at once (phase two's comment below has the whole
  // mechanism), so an account that is part-way previewed shows Pending 0 with the
  // button dead and rows still uncovered. `expect(...).toBeEnabled()` then spent
  // 60s and threw — killing the run BEFORE phase two, which is the code written to
  // handle exactly this. It cost three separate runs before it was worth fixing.
  //
  // The wait itself has to stay generous rather than sampling `isEnabled()`, for
  // the reason recorded above: right after an import the button is disabled
  // because `pendingCount` is UNKNOWN, and falling through then would skip
  // extract-all and let phase two drag the whole library in by scrolling — which
  // still finishes, which is why nobody would look. So: wait the full minute, and
  // treat the timeout as a branch rather than an error.
  if (!isComplete(progress, total)) {
    const startable = await generateAll
      .waitFor({ state: 'visible' })
      .then(() => expect(generateAll).toBeEnabled({ timeout: 60_000 }))
      .then(
        () => true,
        () => false,
      );

    if (!startable) {
      console.log(
        `previewed ${report(progress, total)} — \`Generate all\` is disabled with the ` +
          `library incomplete, so the pending bucket is empty and the stragglers are ` +
          `sitting on a backoff. Nothing to press; falling through to the auto-drain.`,
      );
    } else {
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
          `\`npm run shot:preflight\` and replace it in shot/library.ts.`,
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
  // is the top seven links — and a scene's own `settle` (scenes.ts) hard-fails if
  // any row IN THE PICTURE is wearing a monogram. Gating on all 24 instead would spend forty
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
      `mid-ladder; \`npm run shot:account -- --fresh\` starts the attempt counts at zero.`,
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
