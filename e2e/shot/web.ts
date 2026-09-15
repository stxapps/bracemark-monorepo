import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, type Page } from '@playwright/test';

import { profileDir, SHOT_OUTPUT } from '../paths';
import { waitForApi } from '../runner/lib';
import { seedPassword } from '../seed/catalog';
import { findUserId } from '../seed/plan';
import { waitForSync } from '../seed/steps';
import { launchApp } from '../web/fixtures/launch';
import { SHOT_USER } from './library';
import { groupByScale, type Scene, selectScenes } from './scenes';

// Every screenshot we publish of bracemark-web, made by driving the product.
//
//   npm run dev              # api + web + extractor
//   npm run shot:account        # ONCE, first — this leg photographs that account
//   npm run shot:web         # every scene
//   npm run shot:web -- library-narrow search-narrow   # some
//
// What comes out: one PNG per scene in `e2e/.artifacts/shot/`. WHAT the scenes
// are — viewport, URL, and what "finished" means on that screen — is `scenes.ts`;
// this file is the apparatus every one of them needs. `library-list` is the
// marketing site's figure and is handed to `tools/scripts/make-image-variants.sh`
// (the run prints the exact command); the rest are consumed by the compositor
// that places the PWA install-dialog screenshots.
//
// IT BUILDS NOTHING. The account, its library, the plan, the extraction drain and
// the synced settings are `./account.ts`'s — `npm run shot:account` — and this leg
// only signs in. So a scene that comes out wrong is re-shot in the time the
// screenshot takes rather than the ten minutes the drain does, and the same
// account answers `shot:ext` and `shot:mobile` without being rebuilt for either.
// An account that does not exist is a missing PREREQUISITE, not something to
// create quietly and photograph half-filled.
//
// ⚠ ONE LAUNCH PER DPR, and it is the trap this file exists to hold shut.
// `deviceScaleFactor` is a browser-CONTEXT option, so scenes at different scales
// cannot share a launch — and setting it per page does not fail, it just
// photographs everything at the first context's density. `groupByScale` is what
// the loop below iterates: one launch per density, each signing into the same
// account and waiting for the pull before it photographs anything.
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

async function main(): Promise<void> {
  const scenes = selectScenes(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));
  const groups = groupByScale(scenes);
  await waitForApi();

  if (!(await findUserId(SHOT_USER.username))) {
    throw new Error(
      `no \`${SHOT_USER.username}\` account on the local api — run \`npm run shot:account\` first.\n` +
        '    This leg photographs that account: the scenes are its library, its lists and its tags.',
    );
  }

  const credentials = {
    username: SHOT_USER.username,
    password: seedPassword(SHOT_USER.key),
  };
  console.log(
    `scenes: ${scenes.map((scene) => scene.id).join(', ')} — ` +
      `${groups.length} launch(es), one per DPR`,
  );

  const captured: string[] = [];
  for (const group of groups) {
    // A profile dir PER DPR, because `launchApp` wipes the one it is given (a
    // profile left by an earlier run holds a session for an account nobody has
    // the password for). Sharing one dir across groups would work — each launch
    // would just re-sign-in — but naming them apart keeps a failed run's state
    // readable afterwards.
    const app = await launchApp(profileDir(`shot-${group.scale}x`), {
      existing: credentials,
      deviceScaleFactor: group.scale,
    });

    try {
      const { page } = app;

      // A fresh profile has an empty local store, so this launch is waiting for
      // the PULL: the links, the extraction records and the preview blobs all come
      // back down from the server before anything is worth photographing. The
      // scene's own `settle` is the real gate — it fails loudly if the covers
      // never arrive — but waiting here first turns "the pictures are empty" into
      // "the sync did not finish".
      await waitForSync(page);
      await assertListLayout(page);

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
    console.log('\nNext, for the marketing site\u2019s figure:');
    console.log(
      `  tools/scripts/make-image-variants.sh ${figure} \\\n` +
        `    apps/bracemark-site/public/screenshots/library-list`,
    );
    console.log(
      '  then check SCREENSHOT in apps/bracemark-site/src/app/page.tsx: `widths` is what\n' +
        '  the script prints, and the frame ratio must still match the scene\u2019s viewport.',
    );
  }
}

/**
 * The one thing `shot:account` established that a HUMAN can undo between the seeding
 * and the capture, checked rather than re-applied.
 *
 * `linksLayout` SYNCS: one click in Settings → Misc, in the app or on any other
 * device signed into this fixture, is persisted and restored on the next sign-in
 * — and card layout photographs a wall of full-bleed covers where the site's band
 * expects a list. Before the split this was re-asserted in the same run as the
 * capture; keeping a read-only check here keeps that guarantee across the split,
 * for one page load. Everything else the seeder does is either server state or is
 * gated by a scene's own `settle`.
 */
async function assertListLayout(page: Page): Promise<void> {
  await page.goto('/settings/misc');
  const list = page.getByRole('radio', { name: 'List' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('data-state')) === 'checked') return;
  throw new Error(
    'this account is on the CARD layout, so the scenes would photograph the wrong screen. ' +
      'Re-run `npm run shot:account` (it sets the layout through the real radio), or set ' +
      'Settings → Misc → Layout → List by hand.',
  );
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
