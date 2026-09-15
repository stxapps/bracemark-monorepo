import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type BrowserContext, chromium, expect, type Page } from '@playwright/test';

import { E2E_ROOT, profileDir, SHOT_OUTPUT, SHOT_STAGED_EXTENSION } from '../paths';
import { waitForApi } from '../runner/lib';
import { seedPassword } from '../seed/catalog';
import { findUserId } from '../seed/plan';
import { SHOT_USER } from './library';

// The browser extension's popup, photographed for the Chrome Web Store and AMO.
//
//   npm run dev            # api + web + extractor
//   npm run shot:account      # ONCE, first — this leg photographs that account
//   npm run shot:ext       # the three popup scenes
//   npm run shot:ext -- ext-sync           # a subset (the flow still runs whole)
//
// What comes out: `ext-*.png` in `e2e/.artifacts/shot/`, 360 CSS px wide at DPR 2,
// each one the popup's whole document. They are SOURCES, not assets — the store
// pictures are 1280x800, and the compositor draws the caption and the browser
// chrome around these. Nothing here is a finished size, which is why these scenes
// are not in `scenes.ts`'s table and why nothing asserts them against a profile.
//
// ── WHY THIS IS A SEPARATE FILE FROM web.ts ──────────────────────────────────
//
// Three things differ, and each of them is a browser-CONTEXT decision, so they
// could not have shared a launch even if the table had fitted:
//
//   1. THE BROWSER. Google Chrome will not load an unpacked extension from the
//      command line and says nothing when it declines — the launch succeeds,
//      `chrome://extensions` is empty, no service worker ever appears. So this is
//      the one thing in `e2e/` that does NOT go through `CHROME_PATH`: it launches
//      Playwright's own Chromium (`npx playwright install chromium`, the one
//      sanctioned use — docs/e2e.md, _the browser this repo drives_).
//   2. THE ORIGIN. Every other scene is a URL under `WEB_URL`; these are
//      `chrome-extension://<id>/popup.html`, and the id is minted at load time and
//      read off the service worker.
//   3. THE ACCOUNT. The popup keeps its own encryption key in its own browser
//      profile, so it signs in through its own form rather than inheriting a
//      profile `launchApp` prepared.
//
// ── THE POPUP IS PHOTOGRAPHED AS A TAB, AND THE REAL WINDOW CANNOT BE ────────
//
// `chrome.action.openPopup()` opens a window that never appears in
// `context.pages()` and fires no `page` event, so it can be neither evaluated nor
// screenshotted; the OS route fails too (`screencapture` → "could not create image
// from display" without screen-recording permission). A tab at 360 CSS px lays out
// and paints exactly as the real popup does — the browser sizes that window to the
// document, so 360 is the whole viewport either way — which is what makes this
// leg possible at all. See `.claude/skills/verify/SKILL.md`, the extension section.
//
// ⚠ ...AND A TAB CANNOT READ THE TAB BEHIND IT. THE ONE TRAP HERE. `SaveFlow`
// asks `browser.tabs.query({ active: true, currentWindow: true })` for the page it
// is acting on and rejects anything not http(s). The manifest is `activeTab`-only
// on purpose — a broad host grant is the scariest install warning there is, and
// `docs/link-extraction.md` argues the whole design around not having one — and
// `activeTab` is granted BY THE CLICK on the toolbar action. There is no click
// here, so the real `tabs.query` comes back with the tab's `url` and `title`
// stripped, `SaveFlow` sees no saveable page, and what gets photographed is
// "Nothing to save here": a correct render of the wrong state.
//
// So this stages a COPY of the build with `tabs` added to its permissions, and
// loads that. Measured: with it, the popup tab reads the real active tab's real
// url, title and favicon; without it, `{ active: true }` and nothing else.
//
// Why this and not an `addInitScript` that fakes `tabs.query`: the fake would be
// the harness AUTHORING the one thing the picture is of — the page being saved —
// and `web.ts` exists on the principle that nothing in a finished image is
// authored. Here every string in the specimen is the browser's own answer about a
// page that is genuinely open, fetched by the product's own code path. The only
// difference from production is HOW the extension came to have access to that
// tab: by manifest in the staging copy, by the user's click in the shipped one.
//
// It is a copy, in `.artifacts/`, built from the real output every run. Nothing
// patches `.output/`, nothing patches the source, and no store ever sees it.
//
// ⚠ AND IT MUST BE THE DEVELOPMENT BUILD. `nx build` is `wxt build`, i.e.
// production, i.e. `api.bracemark.com` — which knows nothing about the local
// seeded account, so the popup would sign in against production or not at all.
// `build:development` is the same bundle pointed at `localhost:8787`
// (apps/bracemark-extension/.env.development); only `WXT_PUBLIC_API_URL` differs,
// so the pixels are the production build's.

// Off E2E_ROOT rather than off this file: `dirname(import.meta.url)` plus a count
// of `..` is a path that breaks SILENTLY when the file moves — it did, when the
// shot legs came out of `seed/shot/` and the count went stale by one. Nothing
// types it, nothing lints it, and the symptom is `nx build` running in a
// directory that is not this repo. ../paths.ts resolves the same anchor once.
const REPO_ROOT = join(E2E_ROOT, '..');
const EXT_PROJECT = '@stxapps/bracemark-extension';
const BUILT = join(REPO_ROOT, 'apps', 'bracemark-extension', '.output', 'chrome-mv3-dev');
const STAGED = SHOT_STAGED_EXTENSION;
const EXT_PROFILE = profileDir('shot-extension');

// ⚠ THE POPUP'S OWN WIDTH, and a contract with the compositor rather than a
// choice made here. `popup/Shell.tsx` declares `w-90` — 360px — and a toolbar
// popup has no viewport to be responsive to, so that div IS the window. The
// canvas that composes these scales one number by one factor; a capture at
// another width would be silently rescaled into the same frame and land the
// popup's type at a size nothing intended. `assertPopupWidth` is the check.
const POPUP_WIDTH = 360;

// Tall enough that no scene's document reaches it, because a document taller than
// the viewport paints a scrollbar and the popup deliberately opts OUT of the
// scrollbar gutter (`data-no-scrollbar-gutter`) — 15px of the right edge would
// simply not be drawn. The screenshots are `fullPage`, so this height is never in
// the output; it only has to be a ceiling.
const POPUP_VIEWPORT_HEIGHT = 1_000;

// DPR 2, and it is the compositor's number: the canvas draws these larger than
// life (a 360px popup in a 1280px frame is otherwise 28% of the width and its
// 14px type is illegible in a carousel), so the source has to carry the pixels
// that enlargement spends. 2 is also what `launchApp` uses everywhere else.
const SCALE = 2;

// ⚠ THE TWO PAGES THE POPUP IS STANDING ON, and the one third-party thing in
// these pictures. A page is drawn INSIDE the specimen — its title, its host, its
// favicon, its cover — so choosing them is the listing-safe-library decision in
// miniature, and a store screenshot crops harder than any figure on the site.
//
// The rule `library.ts` follows is "our own pages, public-domain and
// openly-licensed material, things whose cover art is a photograph rather than a
// masthead". A Wikipedia article is all three, and so is a Wikivoyage one (same
// CC BY-SA, same absence of a house style to infringe) — and both are the kind of
// page a bookmark manager is photographed saving.
//
// Neither is one of OURS. The temptation is to save bracemark.com and dodge the
// question entirely — but `library.ts`'s persona note rules that out for a reason
// that applies here too: a link implies an ACT, and saving our own pitch implies
// nothing. These two continue the library's own story instead. It already holds a
// `Lisbon` list, nested under `Weekends`, with a weekend in it.
//
// ⚠ AND THE SPLIT IS WHAT MAKES THIS RUN REPEATABLE. The obvious script is one
// page: open the editor, press Save, photograph the receipt. It works exactly
// once. Saving writes a link to the account, so the SECOND run opens on
// `Complete` — `SaveFlow` skips the editor for a page already in the store — and
// scene one silently becomes scene two, which is the same class of defect as
// `account.ts`'s `--fresh` trap and just as invisible in the output. Undoing it
// afterwards means deleting the link AND emptying the trash through bracemark-web,
// in a second browser, to leave an account exactly as it was found.
//
// So nothing is saved. `UNSAVED_URL` is a page the library does not hold, which is
// the editor; `SAVED_URL` is a page it does, which is the receipt — reached by the
// revisit path rather than the save path, and it is the SAME `Complete` component
// with the same content either way (App.tsx renders it straight from the live
// query). The picture is better for it, too: a link that has been through
// extraction has its real cover, where a just-saved one still wears the tab's
// favicon while the extractor catches up.
//
// TWO COSTS, both measured rather than guessed, because the second one decided
// what these pictures look like.
//
// The set shows two pages rather than one page twice, so it reads as two moments
// of a trip rather than as one gesture in two frames. Both are in the `Lisbon`
// list, which is what holds them together.
//
// ⚠ AND THE RECEIPT'S TILE IS A FAVICON, NOT A COVER — on this path it cannot be
// anything else, which is worth knowing before someone tries to "fix" it.
// `Complete` prefers the extracted preview image, and its own comment describes
// the tile being "quietly upgraded" to it a beat after a save. That upgrade
// belongs to the SAVE path: the extension extracts the active tab itself and
// writes the bytes into its own file store. A link saved on another device
// carries an `imageId` the extension has no bytes for — `sync-runner.ts`
// materializes `files/` lazily — so `readFileBytes` comes back empty and the
// specimen falls to the live tab's favicon. Waited two minutes for it; it does
// not arrive, and it is not meant to.
//
// Both scenes therefore show a favicon in the 64x40 slot, which is a third
// party's mark and is accepted here for two reasons: it is letterboxed at
// `size-6` on the slot's own plate rather than filling it, which is the
// difference §5.7 is actually about; and the editor — the scene that sells the
// product — could never show anything else, since nothing has been extracted at
// the moment it is photographed. A set where one tile is a photograph and the
// other a mark would be less consistent, not more honest.
//
// The way to a real cover, if one is ever wanted, is the save path plus
// `<all_urls>` on the staged copy (the click grants that too) plus deleting the
// link and emptying the trash afterwards — three moving parts to change one tile.
// ⚠ `SAVED_URL` MUST BE A URL `library.ts` STILL HOLDS, and nothing here checks
// it. When the library was made listing-safe this pointed at
// `en.wikipedia.org/wiki/Lisbon`, which left the list — and the failure is not a
// missing link but a WRONG PICTURE waiting 60s to become an error: the revisit
// path never triggers, `Complete` never renders, and the run dies on a
// `getByText('Saved')` that describes a popup showing "Save this page". If this
// throws there, check this constant against the list before anything else.
const UNSAVED_URL = 'https://en.wikipedia.org/wiki/Alfama';
const SAVED_URL = 'https://en.wikivoyage.org/wiki/Sintra';

// What the person does to the unsaved one, driven through the real controls
// rather than prefilled: the list the trip is already filed under, and two tags
// that exist in the library. The caption this sits under names both, so an empty
// picker under that line would be the caption claiming what the picture does not
// show.
//
// `Lisbon` is nested under `Weekends`, so the trigger prints `Weekends / Lisbon` —
// the ancestors are part of what the picture says, not noise in it.
const TAB_LIST = 'Lisbon';
const TAB_TAGS = ['lisbon', 'weekend'];

interface ExtScene {
  /** `.artifacts/shot/<id>.png`, and what `npm run shot:ext -- <id>` selects. */
  id: string;
  /** One line, for the run's own listing. */
  what: string;
}

// ⚠ THESE ARE STATES OF ONE SESSION, not independent scenes with a `goto` each.
// One browser, one sign-in, two tabs; the sync panel is behind the footer pill on
// the screen the second one leaves you on. So selecting a subset still walks the
// whole flow and only writes the PNGs asked for — the flow IS the setup.
export const EXT_SCENES: ExtScene[] = [
  { id: 'ext-save', what: 'the popup on a page — list and tags chosen, Save unpressed' },
  { id: 'ext-saved', what: 'a page the library already holds — the corner cut, the list named' },
  { id: 'ext-sync', what: 'the sync panel — status, pending changes, last sync' },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wanted = new Set(argv.filter((arg) => !arg.startsWith('--')));
  for (const id of wanted) {
    if (!EXT_SCENES.some((scene) => scene.id === id)) {
      throw new Error(`no scene \`${id}\` — have ${EXT_SCENES.map((s) => s.id).join(', ')}`);
    }
  }
  const shooting = (id: string) => wanted.size === 0 || wanted.has(id);

  await waitForApi();

  // The account is `npm run shot:account`'s to make: it imports the library, grants the
  // plan, turns server extraction on and drains it, and none of that is repeated
  // here. This leg only signs in — so an account that does not exist is a missing
  // PREREQUISITE, not something to create quietly and photograph half-filled.
  if (!(await findUserId(SHOT_USER.username))) {
    throw new Error(
      `no \`${SHOT_USER.username}\` account on the local api — run \`npm run shot:account\` first.\n` +
        '    This leg photographs that account: the popup shows its lists and its tags.',
    );
  }

  const extension = await stageExtension();
  const context = await launch(extension);

  try {
    const id = await extensionId(context);
    console.log(`extension ${id} — from ${extension}`);

    // The page under the popup, and it is opened FIRST and left in front. Every
    // mount of `SaveFlow` reads whatever is active at that moment, so the order
    // here is load-bearing rather than incidental — a popup that is itself the
    // active tab reads a `chrome-extension://` URL, fails the http(s) test, and
    // renders "Nothing to save here".
    const tab = context.pages()[0] ?? (await context.newPage());
    await tab.goto(UNSAVED_URL, { waitUntil: 'load' });
    console.log(`tab: ${await tab.title()}`);

    const popup = await openPopup(context, id, tab);
    await signIn(popup);
    await assertPopupWidth(popup);

    // ⚠ WAIT FOR THE LIBRARY, NOT FOR A TIMEOUT. This profile is wiped every run,
    // so the extension signs in to an empty local store and pulls everything —
    // and both scenes below depend on that landing. The editor's list picker is
    // empty until the tree arrives, and `SAVED_URL` does not read as saved until
    // its link does. The pill going quiet is the product's own answer to "the
    // library is here", which is the same state the third scene photographs.
    await waitForSyncedPill(popup);

    await assertTileIdentifiesPage(popup);
    await fillEditor(popup);
    if (shooting('ext-save')) await shoot(popup, EXT_SCENES[0]);

    // Scene two, on its own tab: a page the library already holds. Nothing is
    // saved by this run — see the note above SAVED_URL for why that is the
    // difference between a leg that works once and one that works every time.
    await tab.goto(SAVED_URL, { waitUntil: 'load' });
    const revisit = await openPopup(context, id, tab);
    await expect(revisit.getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    // `In <list>`, not the bare list name: this page's TITLE is "Lisbon -
    // Wikipedia", so the name alone matches the specimen as well as the row, and
    // the row is the thing the caption under this picture is about.
    await expect(revisit.getByText(`In ${TAB_LIST}`)).toBeVisible({ timeout: 30_000 });
    await assertTileIdentifiesPage(revisit);
    if (shooting('ext-saved')) await shoot(revisit, EXT_SCENES[1]);

    await openSync(revisit);
    if (shooting('ext-sync')) await shoot(revisit, EXT_SCENES[2]);
  } finally {
    await context.close();
  }
}

/**
 * Build the extension, then copy it and add `tabs` to the copy's manifest.
 *
 * The build runs every time (it is cached and takes about a second) rather than
 * being asserted-and-explained, because the failure it prevents is silent: a stale
 * `.output/` photographs a popup that no longer exists in the source, and nothing
 * about the picture says so.
 */
async function stageExtension(): Promise<string> {
  console.log(`building ${EXT_PROJECT} (development — the api is localhost)`);
  execFileSync('npx', ['nx', 'build:development', EXT_PROJECT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  await rm(STAGED, { recursive: true, force: true });
  await mkdir(dirname(STAGED), { recursive: true });
  await cp(BUILT, STAGED, { recursive: true });

  const manifestPath = join(STAGED, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    permissions: string[];
  };
  // Added to the COPY, and named here rather than spread over the file so the one
  // difference between what is photographed and what ships is a single line.
  manifest.permissions = [...manifest.permissions, 'tabs'];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return STAGED;
}

/**
 * ⚠ BOTH ARGS, AND PLAYWRIGHT'S OWN CHROMIUM. `--load-extension` alone silently
 * loads nothing, and no `executablePath` is passed on purpose — see the header.
 *
 * Headed, because headless Chrome renders zero-width scrollbars and this popup's
 * whole right edge is a scrollbar-gutter question (docs/safe-area.md). Nothing in
 * these scenes should scroll, but "nothing scrolls" is the thing being
 * photographed, not an assumption to render under.
 */
async function launch(extension: string): Promise<BrowserContext> {
  await rm(EXT_PROFILE, { recursive: true, force: true });
  return chromium.launchPersistentContext(EXT_PROFILE, {
    headless: false,
    deviceScaleFactor: SCALE,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
}

/** The id is minted at load time; the background service worker's URL carries it. */
async function extensionId(context: BrowserContext): Promise<string> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  return new URL(worker.url()).host;
}

/**
 * The popup's own sign-in — not `launchApp`'s. "Signing in here is separate from
 * the web app", as the form itself says: the extension holds its own key in this
 * browser profile, which is wiped on every run.
 *
 * Slow on purpose: the KDF is Argon2id on the main thread (`setArgon2Runner('main')`
 * in popup/main.tsx, because a cross-origin module worker crashes the popup), so
 * this is seconds of real work rather than a round trip.
 */
async function signIn(popup: Page): Promise<void> {
  // `textbox`, not `getByLabel`: the password field ships a "Show password"
  // toggle inside its own label's scope, so a label query matches two elements.
  await popup.getByRole('textbox', { name: 'Username' }).fill(SHOT_USER.username);
  await popup.getByRole('textbox', { name: 'Password' }).fill(seedPassword(SHOT_USER.key));
  await popup.getByRole('button', { name: 'Sign in' }).click();
  await expect(popup.getByText('Save this page')).toBeVisible({ timeout: 120_000 });

  // The specimen carries the live tab's own title, which is the proof that the
  // `tabs` grant landed and the popup is standing on the page rather than on
  // itself. Without it the popup renders "Nothing to save here" — a correct
  // picture of the wrong state, and the failure this run exists to make loud.
  await expect(popup.getByText('Nothing to save here')).toHaveCount(0);
}

/**
 * ⚠ 360, and the compositor is what breaks if it is not. See POPUP_WIDTH.
 */
async function assertPopupWidth(popup: Page): Promise<void> {
  const width = await popup.evaluate(() => document.documentElement.scrollWidth);
  if (width !== POPUP_WIDTH) {
    throw new Error(
      `the popup laid out at ${width}px, not ${POPUP_WIDTH} — either popup/Shell.tsx’s ` +
        '`w-90` moved, or something inside it is overflowing. The canvas that composes ' +
        'these scales one number by one factor and would rescale the difference silently.',
    );
  }
}

/** The user's two choices, through the real controls. */
async function fillEditor(popup: Page): Promise<void> {
  await popup.getByRole('combobox', { name: 'List' }).click();
  await popup.getByRole('option', { name: TAB_LIST, exact: true }).click();

  for (const tag of TAB_TAGS) {
    await popup.getByRole('combobox', { name: 'Tags' }).click();
    await popup.getByRole('option', { name: tag, exact: true }).click();
    await popup.keyboard.press('Escape');
  }

  // ⚠ WAIT FOR THE PICKERS TO BE GONE, NOT MERELY CLOSED. Both are Radix
  // popovers, which animate out — they keep `data-state="closed"` and stay in the
  // DOM for the length of the transition, then unmount. Escape returns
  // immediately, so a shot taken on the next line catches the panel mid-fade: a
  // ghost of "Search or create tags…" and the tag list, at maybe 15% opacity,
  // printed straight through the Note field and the Save button.
  //
  // It is the exact defect this whole arrangement exists to catch — invisible in
  // a diff, invisible in the run's log, obvious in the picture — and it was found
  // by looking at one. Detachment is the only condition that means the animation
  // finished; `toBeHidden` is satisfied while it is still painting.
  await expect(popup.getByPlaceholder('Search or create tags…')).toHaveCount(0);
  await expect(popup.getByPlaceholder(/^Search .*lists/)).toHaveCount(0);

  // Contains, not equals: `Lisbon` is nested under `Weekends` in this library and
  // the trigger prints the ancestors — so what the picture actually shows is
  // `Weekends / Lisbon`, which is the nesting doing its job rather than a mismatch.
  await expect(popup.getByRole('combobox', { name: 'List' })).toContainText(TAB_LIST);
}

/**
 * A popup tab, mounted against the page that is currently in front.
 *
 * The reload is the whole function. `SaveFlow` queries the active tab once, in a
 * mount effect, so the popup has to be brought up while the PAGE is in front —
 * and a tab that was opened before the page was navigated is holding an answer
 * about the wrong URL. Opening, focusing the page, then reloading is the order
 * that makes the query resolve against what this scene is about.
 */
async function openPopup(context: BrowserContext, id: string, tab: Page): Promise<Page> {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: POPUP_WIDTH, height: POPUP_VIEWPORT_HEIGHT });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await tab.bringToFront();
  await popup.reload();
  return popup;
}

/**
 * The footer pill at rest — "Synced <when>", the phase the sync panel calls
 * `idle`. It is the one condition that means the pull finished: `lastSyncAt` is
 * set and no cycle is in flight.
 *
 * Generous, because this is a first sync of a whole library into an empty store
 * over a local api — and it is the only slow step in the run.
 */
async function waitForSyncedPill(popup: Page): Promise<void> {
  await expect(popup.getByRole('button', { name: /^Synced/ })).toBeVisible({ timeout: 180_000 });
}

/**
 * ⚠ THE TILE MUST IDENTIFY THE PAGE — the same rule `scenes.ts` states as "no row
 * may be wearing a monogram", one surface over and with more riding on it.
 *
 * `PageSpecimen` escalates: the extracted preview image, else the live tab's
 * favicon, else `HostMonogram`. The first two are a picture of the page and are
 * both fine here (see the note above SAVED_URL for why the favicon is what these
 * scenes actually get). The third is the failure — a letter on a coloured field is
 * what the product draws when it knows nothing about the page, and it is the one
 * outcome that makes the popup look broken in a listing.
 *
 * Told apart by the component's own distinction rather than one invented here: the
 * first two are `<img>`, the monogram is an inline `<svg>`.
 */
async function assertTileIdentifiesPage(popup: Page): Promise<void> {
  const tile = popup.locator('.h-10.w-16');
  await expect(tile.locator('img')).toBeVisible({ timeout: 30_000 });
}

/** The footer pill swaps the whole popup for the sync panel — a local view toggle. */
async function openSync(popup: Page): Promise<void> {
  await popup
    .getByRole('button', { name: /^(Synced|Not synced yet|Checking|Syncing|Setting up)/ })
    .click();
  await expect(popup.getByText('Pending changes')).toBeVisible({ timeout: 30_000 });
}

/**
 * One scene, one PNG — of the SHELL ELEMENT, not of the page.
 *
 * Which is the difference between the popup and a picture of the popup on a big
 * white field: every screen here is a different height, `fullPage` floors at the
 * viewport, and the viewport has to be a ceiling nothing reaches (see
 * POPUP_VIEWPORT_HEIGHT). `popup/Shell.tsx`'s outer div IS the window — the
 * browser sizes the real popup to exactly this box — so photographing that box is
 * photographing the window.
 */
async function shoot(popup: Page, scene: ExtScene): Promise<void> {
  await mkdir(SHOT_OUTPUT, { recursive: true });
  const path = join(SHOT_OUTPUT, `${scene.id}.png`);

  const shell = popup.locator('[data-no-scrollbar-gutter]');
  const box = await shell.boundingBox();
  if (!box) throw new Error(`${scene.id}: the popup shell has no box to photograph`);

  // ⚠ 600 IS CHROME'S, NOT OURS. Past it the real popup stops growing and starts
  // scrolling the document (measured: the window widens to 375 and paints the
  // scrollbar outside the shell). A capture taller than that is a picture of a
  // screen no user ever sees whole, composed into a store listing as if they did —
  // and nothing else would say so, because the tab this is photographed in has all
  // the room in the world.
  if (box.height > 600) {
    throw new Error(
      `${scene.id} is ${Math.round(box.height)} CSS px tall; Chrome stops growing the ` +
        'popup at 600 and scrolls it from there, so this screen does not fit the window ' +
        'it ships in. Shorten the screen, or photograph it scrolled the way a user meets it.',
    );
  }

  await shell.screenshot({ path, scale: 'device' });
  console.log(`\nscene ${scene.id} — ${scene.what}`);
  console.log(
    `  ${Math.round(box.width * SCALE)}x${Math.round(box.height * SCALE)} ` +
      `(${Math.round(box.width)}x${Math.round(box.height)} CSS) → ${path}`,
  );
}

await main();
