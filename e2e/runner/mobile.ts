import { join } from 'node:path';

import { expect } from '@playwright/test';

import { profileDir } from '../paths';
import { forgetSessions } from '../seed/sessions';
import { importArchive, waitForSync } from '../seed/steps';
import { type Credentials, newCredentials } from '../web/fixtures/account';
import { unique, unresolvableUrl } from '../web/fixtures/data';
import { writeSmallDataArchive } from '../web/fixtures/data-lifecycle';
import { API_URL } from '../web/fixtures/env';
import {
  knownPage,
  type PendingExtractionLibrary,
  writePendingExtractionLibrary,
} from '../web/fixtures/extraction';
import { launchApp, type LaunchedApp } from '../web/fixtures/launch';
import { writePagedLibrary } from '../web/fixtures/library';
import { addLink, chooseRowMenuItem, displayUrl, linkRow } from '../web/fixtures/links';
import { grantPlus, grantPlusAndLoad } from '../web/fixtures/plan';
import { type ScaleLibrary, writeScaleLibrary } from '../web/fixtures/scale-library';
import { syncAndWait } from '../web/fixtures/sync';
import { createInSettings } from '../web/fixtures/taxonomy';
import { startFaultApi } from './api-fault';
import { type ApiControl, controlApi } from './api-pause';
import { parseNativeCli } from './cli';
import {
  countAppRows,
  readExportFile,
  scanAppSandbox,
  stageDocumentPickerFile,
} from './device-files';
import { cycleAppearance } from './device-look';
import { E2E_ENVIRONMENT, IS_STAGING } from './environment';
import {
  type Box,
  boxById,
  boxOf,
  centerOf,
  findNodes,
  formatBox,
  type HierarchyNode,
  isInside,
  onlyNode,
  parseHierarchy,
  rowBoxByText,
  sameRow,
  screenBox,
  writeDragFlow,
  writeTapFlow,
} from './hierarchy';
import { keyboardFrame } from './keyboard';
import { provisionAccount, writeJson } from './lib';
import { type CaseStep, type CaseStepContext, prepareNativeRun } from './native-run';
import { inkShare, screenshot } from './pixels';
import { adbShell, capture } from './process';
import { selectCasesForPlatform, validateCaseRegistry } from './registry';
import {
  assertMainAppStopped,
  mainAppPid,
  openSystemShare,
  startPlainTextShareSource,
} from './share';

// Cases whose subject is a Plus lever get the existing `manual` grant before the
// device signs in, so the sign-in's entitlement read already carries it
// (web/fixtures/plan.ts).
const PLUS_CASES = new Set([
  'TAXONOMY-DND-002',
  'SEARCH-002',
  'LOCK-APP-002',
  'LOCK-LIST-001',
  'LOCK-AUTORELOCK-001',
]);

// Cases that need the generated 1,000-link library (web/fixtures/scale-library.ts)
// rather than the 60-link paged one. A thousand links is past the free cap, so
// they take the same `manual` Plus grant.
const SCALE_LIBRARY_CASES = new Set(['SCALE-IOS-001', 'SCALE-ANDROID-001', 'SKELETON-NATIVE-001']);

// The least share of a row's box a painted row covers in ink (text, thumbnail,
// chips) — a blank recycled cell is one flat colour, ~0. Measured on the paged
// library's rows: ~0.08–0.15 on both devices.
const PAINTED_ROW_INK = 0.02;

// expo's lock provider relocks after 60s in the background (AUTO_RELOCK_AFTER_MS,
// expo-react lock-provider.tsx); the case waits past it by a margin that absorbs
// the Home press and Maestro's own start-up on either side.
const AUTO_RELOCK_WAIT_MS = 75_000;

// Enough `.invalid` rows above EXTRACT-NATIVE-ALL-001's targets to keep them
// below the fold on a phone, where the displayed-scoped drain at `all` cannot see
// them — so only Generate all can settle them (mobile/flows/extract-all.yaml).
const EXTRACTION_FILLERS = 24;

// A settings row's grip, found beside the rename field that carries the name.
async function listGrip(context: CaseStepContext, name: string) {
  const root = parseHierarchy(await context.hierarchy());
  const field = boxOf(onlyNode(root, 'List name', name, `"${name}" rename field`));
  return { root, field, grip: sameRow(root, field, 'Drag to reorder', `"${name}" grip`) };
}

// Another client's write: a separate web profile signs in, saves `url`, and
// pushes it, so the device can only learn of it by pulling.
async function writeFromWeb(label: string, credentials: Credentials, url: string): Promise<void> {
  const app = await launchApp(profileDir(label), { existing: credentials });
  try {
    await app.page.goto('/links');
    await addLink(app.page, url);
    await syncAndWait(app.page);
  } finally {
    await app.close();
  }
}

// The reader is a distinct persistent profile. It performs an explicit pull and
// must see exactly one row, so a local native write or a duplicated upload cannot
// satisfy the cross-client claim.
async function readSharedLinkFromWeb(
  label: string,
  credentials: Credentials,
  url: string,
): Promise<void> {
  const app = await launchApp(profileDir(label), { existing: credentials });
  try {
    await app.page.goto('/links');
    await syncAndWait(app.page);
    await expect(linkRow(app.page, url)).toHaveCount(1);
  } finally {
    await app.close();
  }
}

// The list's box and one row's, read off the screen as it is now.
async function rowInList(context: CaseStepContext, url: string) {
  const root = parseHierarchy(await context.hierarchy());
  return { root, list: boxById(root, 'links-list'), row: rowBoxByText(root, displayUrl(url)) };
}

// The row is painted inside the list and leads it: its top within one row's
// height of the list's top edge, and `below` (the previous first row) under it.
function assertLeadsList(list: Box, row: Box | null, below: Box | null, what: string): void {
  if (!row) throw new Error(`${what}: the row is not mounted`);
  if (!isInside(row, list)) {
    throw new Error(`${what}: row ${formatBox(row)} is outside the list ${formatBox(list)}`);
  }
  if (row.top - list.top >= row.bottom - row.top) {
    throw new Error(`${what}: row ${formatBox(row)} is not at the top of ${formatBox(list)}`);
  }
  if (below && below.top < row.bottom - 1) {
    throw new Error(`${what}: the previous first row ${formatBox(below)} is not below it`);
  }
}

// Take an Android device off the local api, or put it back, without touching the
// app: the emulator reaches :8787 only through this reverse mapping, and Metro
// (:8081) keeps its own (docs/e2e.md, _driving the native apps_).
// Take one local origin off an Android device, or put it back, by its adb
// reverse mapping — 8787 is the api, 8788 bracemark-extractor. The emulator
// reaches this Mac's servers only through these, so removing one is a real
// network cut for the app and nothing else.
async function setPortReachable(deviceId: string, port: number, reachable: boolean) {
  const args = reachable
    ? ['reverse', `tcp:${port}`, `tcp:${port}`]
    : ['reverse', '--remove', `tcp:${port}`];
  await capture('adb', ['-s', deviceId, ...args], { allowFailure: !reachable });
}

async function setApiReachable(deviceId: string, reachable: boolean): Promise<void> {
  await setPortReachable(deviceId, 8787, reachable);
}

// Point an Android device's api route at another host port — a stand-in that
// answers wrongly (runner/api-fault.ts) — without touching the app, which still
// calls localhost:8787. `setApiReachable(…, true)` points it back.
async function routeApiTo(deviceId: string, hostPort: number): Promise<void> {
  await capture('adb', ['-s', deviceId, 'reverse', 'tcp:8787', `tcp:${hostPort}`]);
}

// The file an export left in the app's cache, as text, required to hold every
// URL in `urls`. Plain text is URL-per-line, so containment is the whole check.
async function assertExported(context: CaseStepContext, urls: string[]): Promise<void> {
  const text = await readExportFile({
    platform: context.platform,
    deviceId: context.deviceId,
    prefix: 'Bracemark links ',
  });
  for (const url of urls) {
    if (!text.includes(url)) throw new Error(`the exported file does not hold ${url}`);
  }
}

// Synced entities plus the unpushed queue: what the sign-out teardown must take
// with the session (docs/data-lifecycle.md, _the sign-out teardown_).
async function localRows(context: CaseStepContext, label: string): Promise<number> {
  return countAppRows({
    platform: context.platform,
    deviceId: context.deviceId,
    tables: ['items', 'pending_ops'],
    workDir: join(context.caseDir, `${context.index}-${label}`),
  });
}

// Which files in the app's sandbox hold which of `markers`, with the full file
// list written beside the case's other artifacts: the hits decide the case, and
// the list is what a reader checks them against — everything the app had on
// disk at that moment, including what no marker could flag.
async function sandboxHits(context: CaseStepContext, label: string, markers: string[]) {
  const scan = await scanAppSandbox({
    platform: context.platform,
    deviceId: context.deviceId,
    markers,
    workDir: join(context.caseDir, `${context.index}-${label}-copy`),
  });
  await writeJson(join(context.caseDir, `${context.index}-${label}.json`), scan);
  return scan.hits;
}

// Revoke every OTHER session of the account — the device's — from a separate
// web profile, the way a user does it: Settings → Account → Sign out other
// devices. No test hook: the api's answer to the device's token is then a real
// 401.
async function revokeOtherSessions(label: string, credentials: Credentials): Promise<void> {
  const app = await launchApp(profileDir(label), { existing: credentials });
  try {
    await app.page.goto('/settings/account');
    await app.page.getByRole('button', { name: /^Sign out other devices/ }).click();
    await app.page.getByRole('button', { name: 'Sign out other devices', exact: true }).click();
    await expect(app.page.getByText(/^Your other devices have been signed out\./)).toBeVisible();
  } finally {
    await app.close();
  }
}

// Change the account's password from a separate web profile — the other device.
// Its own session stays; every other session, the device's included, is EXPIRED and
// never revoked (apps/bracemark-api/src/services/account.ts, changePasswordDoor).
async function changePasswordElsewhere(
  label: string,
  credentials: Credentials,
  newPassword: string,
): Promise<void> {
  const app = await launchApp(profileDir(label), { existing: credentials });
  try {
    await app.page.goto('/settings/account');
    await app.page.getByRole('button', { name: /^Change password/ }).click();
    await app.page.locator('#cp-current').fill(credentials.password);
    await app.page.getByRole('button', { name: /choose my own/i }).click();
    await app.page.locator('#cp-new-password').fill(newPassword);
    await app.page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(app.page.getByText(/^Your password has been changed\./)).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await app.close();
  }
}

// A drag on Android as explicit touch events: down, eight moves, up. Not `input
// swipe`, which injects each event and waits for the app to finish it, then
// spends what is left of its duration on moves — so a touch-down the app is
// slow to finish (hundreds of ms on the dev build) leaves no time for any, and
// the gesture reaches the app as a DOWN and an UP far apart. No view saw a move,
// so no ScrollView took the gesture, and RN's Pressable, which checks the press
// rect only on moves, fires `onPress` on that release. Here every step is its
// own injection, so a slow app only slows the drag down.
async function androidDrag(
  deviceId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const steps = 8;
  const at = (i: number) => [
    String(Math.round(from.x + ((to.x - from.x) * i) / steps)),
    String(Math.round(from.y + ((to.y - from.y) * i) / steps)),
  ];
  await adbShell(deviceId, ['input', 'motionevent', 'DOWN', ...at(0)]);
  for (let i = 1; i <= steps; i++) {
    await adbShell(deviceId, ['input', 'motionevent', 'MOVE', ...at(i)]);
  }
  await adbShell(deviceId, ['input', 'motionevent', 'UP', ...at(steps)]);
}

// A web profile's view of the account after an explicit pull: exactly one row
// for `url`, carrying `text` when given. Pulled again until it is — a device
// that has only just been given the api back may still be pushing.
async function readFromWeb(
  label: string,
  credentials: Credentials,
  expectations: Array<{ url: string; text?: string }>,
): Promise<void> {
  const app = await launchApp(profileDir(label), { existing: credentials });
  try {
    await app.page.goto('/links');
    await expect
      .poll(
        async () => {
          await syncAndWait(app.page);
          for (const { url, text } of expectations) {
            const row = linkRow(app.page, url);
            if ((await row.count()) !== 1) return false;
            if (text && !(await row.innerText()).includes(text)) return false;
          }
          return true;
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBe(true);
  } finally {
    await app.close();
  }
}

// The list as the device shows it now: every paged-library row painted wholly
// inside it — by bounds AND by pixels — and the row the scroll position is
// anchored on, the one crossing the list's top edge (else the first below it).
// Anything less than a screenful of painted rows, or a row inside the list that
// drew nothing, fails here.
async function paintedRows(context: CaseStepContext, urls: string[], label: string) {
  const root = parseHierarchy(await context.hierarchy());
  const list = boxById(root, 'links-list');
  const raster = await screenshot(
    context.platform,
    context.deviceId,
    join(context.caseDir, `${context.index}-${label}.png`),
  );
  const screenWidth = screenBox(root).right;
  const mounted: Array<{ url: string; box: Box }> = [];
  for (const url of urls) {
    const box = rowBoxByText(root, displayUrl(url));
    if (!box || box.bottom <= list.top || box.top >= list.bottom) continue;
    mounted.push({ url, box });
  }
  // Wholly inside, at full height. Android reports bounds clipped to the
  // scroller, so a sliver of a row at an edge still reads as "inside" — and
  // may hold nothing but its border.
  const heights = mounted.map(({ box }) => box.bottom - box.top).sort((a, b) => a - b);
  const fullHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  let painted = 0;
  for (const { url, box } of mounted) {
    if (!isInside(box, list) || box.bottom - box.top < fullHeight * 0.8) continue;
    const ink = inkShare(raster, box, screenWidth);
    if (ink < PAINTED_ROW_INK) {
      throw new Error(`${label}: row ${url} at ${formatBox(box)} is in the list but painted blank`);
    }
    painted += 1;
  }
  if (painted < 3) throw new Error(`${label}: only ${painted} rows are painted in the list`);
  mounted.sort((a, b) => a.box.top - b.box.top);
  return { list, anchor: mounted[0] };
}

// The tree and the keyboard's frame once the keyboard is in the state the step
// expects, read up to four times a second apart. One read is not enough: with
// the machine loaded, an iOS hierarchy read came back without the keyboard's
// node while the checkpoint taken just before it showed the keys up.
async function settledKeyboard(context: CaseStepContext, expectUp: boolean) {
  for (let attempt = 1; ; attempt++) {
    const root = parseHierarchy(await context.hierarchy());
    const keyboard = await keyboardFrame(context, root);
    if (Boolean(keyboard) === expectUp || attempt === 4) return { root, keyboard };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Each named element is on screen and wholly above the soft keyboard — which
// must be up — and so reachable by a finger. Returns what it read, so a step can
// go on to aim a gesture from the same frame.
async function clearOfKeyboard(
  context: CaseStepContext,
  label: string,
  elements:
    | Array<{ what: string; box: Box }>
    | ((root: HierarchyNode) => Array<{ what: string; box: Box }>),
) {
  const { root, keyboard } = await settledKeyboard(context, true);
  if (!keyboard) throw new Error(`${label}: no soft keyboard is up`);
  const screen = screenBox(root);
  for (const { what, box } of typeof elements === 'function' ? elements(root) : elements) {
    if (!isInside(box, screen) || box.bottom > keyboard.top) {
      throw new Error(
        `${label}: ${what} at ${formatBox(box)} is not clear of the keyboard at ${formatBox(keyboard)}`,
      );
    }
  }
  return { root, keyboard, screen };
}

function requireBox(box: Box | null, what: string): Box {
  if (!box) throw new Error(`${what} is not on screen`);
  return box;
}

const byIds =
  (...ids: string[]) =>
  (root: HierarchyNode) =>
    ids.map((id) => ({ what: `#${id}`, box: boxById(root, id) }));

// The keyboard is down AND the surface that had it is still the one on
// screen — a keyboard also "goes" when a stray tap sends the app to the
// background, which is how a drag misread as a row press once passed here.
async function keyboardGone(
  context: CaseStepContext,
  label: string,
  stillShowing: string,
): Promise<null> {
  const { root, keyboard } = await settledKeyboard(context, false);
  if (keyboard) throw new Error(`${label}: the keyboard is still up at ${formatBox(keyboard)}`);
  if (findNodes(root, (attributes) => attributes['resource-id'] === stillShowing).length !== 1) {
    throw new Error(
      `${label}: #${stillShowing} is gone — the gesture did more than put the keyboard away ` +
        '(a drag that reached the app as a tap opens a row — docs/app-drivers.md, ' +
        '_`input swipe` can arrive as a tap_)',
    );
  }
  return null;
}

// Maestro matches text as a (case-insensitive) regex against the whole
// accessible name, so a fixture value is escaped before it becomes a selector.
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// How a flow and a host step find one row of the scale library. A row prints
// its title, or its address when it has none (the generated titles repeat
// every 24 links, so only an address is unique alone); a title is paired with
// the host the row prints under it, which no mounted neighbour shares.
function scaleRow(library: ScaleLibrary, url: string) {
  const display = library.display.get(url);
  if (!display) throw new Error(`${url} is not a shown row of the scale library`);
  const host = new URL(url).host;
  const unique = [...library.display.values()].filter((value) => value === display).length === 1;
  const texts = unique ? [display] : [display, host];
  return {
    texts,
    match: `.*${texts.map(escapeRegex).join('.*')}.*`,
    unique,
  };
}

// The two pins the native flows page past: deep ones whose row above is a
// unique address, which `scrollUntilVisible` can stop on without meeting a
// namesake first.
function nativeDeepPins(library: ScaleLibrary) {
  const pins = library.deepPins.filter((pin) => scaleRow(library, pin.before).unique);
  if (pins.length < 2) throw new Error('the scale library has too few addressable deep pins');
  return [pins[0], pins[pins.length - 1]];
}

// The overlay held for `pin`: the rows dated either side of it are painted
// back to back inside the list, and the pin itself is mounted nowhere near.
function assertClosedOver(
  library: ScaleLibrary,
  pin: { url: string; before: string; after: string },
) {
  return async (context: CaseStepContext): Promise<null> => {
    const root = parseHierarchy(await context.hierarchy());
    const list = boxById(root, 'links-list');
    const before = rowBoxByText(root, scaleRow(library, pin.before).texts);
    const after = rowBoxByText(root, scaleRow(library, pin.after).texts);
    if (!before || !after) throw new Error(`the rows around ${pin.url} are not both mounted`);
    for (const box of [before, after]) {
      if (!isInside(box, list)) {
        throw new Error(`row ${formatBox(box)} is outside the list ${formatBox(list)}`);
      }
    }
    if (Math.abs(after.top - before.bottom) > 2) {
      throw new Error(
        `something sits between the rows around ${pin.url}: ${formatBox(before)} then ${formatBox(after)}`,
      );
    }
    if (rowBoxByText(root, scaleRow(library, pin.url).texts)) {
      throw new Error(`pinned ${pin.url} is mounted in the rest of the list`);
    }
    return null;
  };
}

// Standalone native journeys. Platform and device are deliberately mandatory:
// a result that does not say which runtime it exercised is not a baseline.
async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseNativeCli();
  const selected = selectCasesForPlatform('native', options.platform, {
    ...options,
    environment: E2E_ENVIRONMENT,
  });
  const run = await prepareNativeRun('mobile', options, selected);

  try {
    for (const testCase of selected) {
      // Every flow gets a fresh account. This makes destructive and ordering-
      // sensitive cases independent, and keeps a failed flow from poisoning the
      // state observed by the next one.
      const withRecovery = testCase.id === 'NATIVE-ACCOUNT-002';
      let pagedUrls: string[] = [];
      const conflictUrl = unresolvableUrl(`${run.runId}-conflict`);
      const offlineUrl = unresolvableUrl(`${run.runId}-offline-edited`);
      const shareListName = unique('E2E share list');
      const shareTagName = unique('e2e-share-tag');
      const shareCreatedListName = unique('E2E shared list');
      const shareCreatedTagName = unique('e2e-shared-tag');
      const residueListName = unique('E2E residue list');
      const importFixture = testCase.id.startsWith('DATA-IMPORT-NATIVE-')
        ? await writeSmallDataArchive(
            join(run.runDir, 'cases', testCase.id, 'fixture', 'small-bracemark.zip'),
            unique('E2E data'),
          )
        : undefined;
      let extractionLibrary: PendingExtractionLibrary | undefined;
      let scaleLibrary: ScaleLibrary | undefined;
      const account = await provisionAccount(`${run.runId}-${testCase.id}`, {
        withRecovery,
        prepare: async (app) => {
          if (PLUS_CASES.has(testCase.id)) await grantPlus(app.credentials.username);
          if (SCALE_LIBRARY_CASES.has(testCase.id)) {
            // This browser imports past the free cap, so IT must hold Plus, not
            // only the server (docs/e2e.md, _granting Plus is two steps_). The
            // whole library reaches the server before the device signs in, so
            // the device's first pull is a thousand links.
            await grantPlusAndLoad(app.page, app.credentials.username);
            scaleLibrary = await writeScaleLibrary(
              join(run.runDir, 'cases', testCase.id, 'fixture', 'scale.zip'),
            );
            await importArchive(app.page, scaleLibrary.archivePath);
            await waitForSync(app.page);
          } else if (testCase.fixture === 'scale') {
            // The paged library goes in through the web app and reaches the
            // server before the device signs in and pulls it.
            const library = await writePagedLibrary(
              join(run.runDir, 'cases', testCase.id, 'fixture', 'paged.zip'),
              {
                // SHARE-BOUNDARY-001 needs the public create gate exactly at
                // the free tier's 200-link cap. Other scale cases need only the
                // first paging boundary and retain their smaller fixture.
                count: testCase.id === 'SHARE-BOUNDARY-001' ? 200 : 60,
                label: testCase.id === 'SHARE-BOUNDARY-001' ? 'e2e-share-cap' : 'e2e-paged',
              },
            );
            await importArchive(app.page, library.archivePath);
            await waitForSync(app.page);
            pagedUrls = library.urls;
          }
          if (['SHARE-ANDROID-001', 'SHARE-IOS-001'].includes(testCase.id)) {
            await createInSettings(app.page, 'list', shareListName);
            await createInSettings(app.page, 'tag', shareTagName);
            await app.page.goto('/links');
            await syncAndWait(app.page);
          }
          if (testCase.id === 'EXTRACT-NATIVE-ALL-001') {
            // Imported on the web and synced down, so the device meets these as
            // links it never saved — the residual only `all` covers.
            extractionLibrary = await writePendingExtractionLibrary(
              join(run.runDir, 'cases', testCase.id, 'fixture', 'pending-extraction.zip'),
              { label: 'e2e-device-all', fillers: EXTRACTION_FILLERS },
            );
            await importArchive(app.page, extractionLibrary.archivePath);
            await waitForSync(app.page);
          }
          if (testCase.id === 'SYNC-CONFLICT-001') {
            // The one link both clients edit, on the server before either does.
            await app.page.goto('/links');
            await addLink(app.page, conflictUrl);
            await syncAndWait(app.page);
          }
          if (testCase.id === 'SIGN-OUT-RESIDUE-NATIVE-001') {
            // A list beside the link below: its name is the taxonomy's plaintext,
            // which on iOS is also mirrored into the App Group container.
            await createInSettings(app.page, 'list', residueListName);
          }
          if (
            testCase.id.startsWith('OFFLINE-') ||
            testCase.id === 'SIGN-OUT-RESIDUE-NATIVE-001' ||
            testCase.id === 'SESSION-INVALID-NATIVE-001' ||
            testCase.id === 'SESSION-EXPIRED-NATIVE-001' ||
            testCase.id === 'SESSION-UNKNOWN-NATIVE-001'
          ) {
            // What the device must still read once the api is gone — or, for
            // the revoked session, what the teardown must take and the return
            // must bring back.
            await app.page.goto('/links');
            await addLink(app.page, offlineUrl);
            await syncAndWait(app.page);
          }
        },
      });
      if (withRecovery && !account.recoveryCode) {
        throw new Error(`${testCase.id}: provisioning returned no recovery code`);
      }

      const env: Record<string, string> = {
        USERNAME: account.username,
        PASSWORD: account.password,
      };
      if (account.recoveryCode) env.RECOVERY_CODE = account.recoveryCode;

      if (testCase.id === 'NATIVE-LINK-001') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-first-on-device`);
        env.LINK_URL_2 = unresolvableUrl(`${run.runId}-second-on-device`);
      }
      if (testCase.id === 'LINK-EDITOR-002') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-editor`);
        env.LIST_NAME = unique('E2E list');
        env.MOVED_LIST_NAME = unique('E2E moved list');
        env.KEPT_TAG = unique('e2e-kept');
        env.DROPPED_TAG = unique('e2e-dropped');
        env.ADDED_TAG = unique('e2e-added');
        env.NOTE = unique('E2E note');
        env.TITLE = unique('E2E title');
        env.EDITED_NOTE = unique('E2E edited note');
      }
      if (testCase.id === 'LINK-CLOSE-001') {
        env.ANCHOR_URL = unresolvableUrl(`${run.runId}-close-anchor`);
        env.DISCARDED_URL = unresolvableUrl(`${run.runId}-close-discarded`);
        env.DRAFT_NOTE = unique('E2E draft note');
      }
      if (testCase.id === 'LINK-LIFECYCLE-002') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-lifecycle`);
        env.ANCHOR_URL = unresolvableUrl(`${run.runId}-trash-anchor`);
      }
      if (testCase.id === 'LINK-MOVE-001') {
        env.ROW_URL = unresolvableUrl(`${run.runId}-move-row`);
        env.BULK_ONE_URL = unresolvableUrl(`${run.runId}-move-bulk-one`);
        env.BULK_TWO_URL = unresolvableUrl(`${run.runId}-move-bulk-two`);
        env.KEEP_URL = unresolvableUrl(`${run.runId}-move-keep`);
        env.ROW_LIST = unique('E2E move row');
        env.BULK_LIST = unique('E2E move bulk');
      }
      if (testCase.id === 'TAXONOMY-EDITOR-002') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-taxonomy`);
        env.LIST_NAME = unique('E2E list');
        env.RENAMED_LIST = unique('E2E renamed list');
        env.TAG_NAME = unique('e2e-tag');
        env.RENAMED_TAG = unique('e2e-renamed-tag');
      }
      let steps: CaseStep[] | undefined;
      if (testCase.id === 'TAXONOMY-DND-002') {
        env.LIST_A = unique('E2E dnd A');
        env.LIST_B = unique('E2E dnd B');
        env.LIST_C = unique('E2E dnd C');
        steps = [
          testCase.path,
          // A (third) into C's slot (first): same x, C's row centre.
          async (context) => {
            const { root, grip } = await listGrip(context, env.LIST_A);
            const target = boxOf(onlyNode(root, 'List name', env.LIST_C, 'C rename field'));
            const from = centerOf(grip);
            return writeDragFlow(context, 'reorder', from, { x: from.x, y: centerOf(target).y });
          },
          'mobile/flows/parts/taxonomy-dnd-reordered.yaml',
          // B (third, under C) straight to the right: no vertical travel keeps
          // its slot, and two grips' width of horizontal travel projects it one
          // level deeper than the row above — the deepest it may go.
          async (context) => {
            const { grip } = await listGrip(context, env.LIST_B);
            const from = centerOf(grip);
            const width = grip.right - grip.left;
            return writeDragFlow(context, 'reparent', from, { x: from.x + 2 * width, y: from.y });
          },
          'mobile/flows/parts/taxonomy-dnd-nested.yaml',
        ];
      }
      if (testCase.id === 'FILTER-001') {
        env.FILED_URL = unresolvableUrl(`${run.runId}-filter-filed`);
        env.INBOX_URL = unresolvableUrl(`${run.runId}-filter-inbox`);
        env.ARCHIVED_URL = unresolvableUrl(`${run.runId}-filter-archived`);
        env.TRASHED_URL = unresolvableUrl(`${run.runId}-filter-trashed`);
        env.LIST_NAME = unique('E2E filter list');
        env.TAG_NAME = unique('e2e-filter-tag');
      }
      if (testCase.id === 'SEARCH-001') {
        env.WORD = unique('findme').toLowerCase();
        env.MATCH_URL = unresolvableUrl(`${env.WORD}-match`);
        env.MISS_URL = unresolvableUrl(`${run.runId}-nomatch`);
      }
      if (testCase.id === 'SEARCH-002') {
        env.LIST_NAME = unique('E2E search list');
        env.TAG_NAME = unique('e2e-search-tag');
        env.WORD = unique('advword').toLowerCase();
        env.ALL_URL = unresolvableUrl(`${env.WORD}-all-three`);
        env.NO_WORD_URL = unresolvableUrl(`${run.runId}-no-word`);
        env.NO_TAG_URL = unresolvableUrl(`${env.WORD}-no-tag`);
        env.NO_LIST_URL = unresolvableUrl(`${env.WORD}-no-list`);
      }
      if (testCase.id === 'BULK-002') {
        env.HOST = new URL(pagedUrls[0]).host;
      }
      if (testCase.id === 'BULK-ACTIONS-001') {
        env.KEEP_URL = unresolvableUrl(`${run.runId}-bulk-keep`);
        env.PINNED_FIRST_URL = unresolvableUrl(`${run.runId}-bulk-first`);
        env.PINNED_SECOND_URL = unresolvableUrl(`${run.runId}-bulk-second`);
        env.UNPINNED_URL = unresolvableUrl(`${run.runId}-bulk-loose`);
        env.ONE_URL = unresolvableUrl(`${run.runId}-bulk-one-tag`);
        env.TWO_URL = unresolvableUrl(`${run.runId}-bulk-two-tags`);
        env.ARCHIVED_URL = unresolvableUrl(`${run.runId}-bulk-archived`);
        env.LIST_NAME = unique('E2E bulk list');
        env.SHARED_TAG = unique('e2e-bulk-shared');
        env.PARTIAL_TAG = unique('e2e-bulk-partial');
        env.ADDED_TAG = unique('e2e-bulk-added');
      }
      if (testCase.id === 'BULK-TRASH-001') {
        env.RESTORED_A = unresolvableUrl(`${run.runId}-trash-restored-a`);
        env.RESTORED_B = unresolvableUrl(`${run.runId}-trash-restored-b`);
        env.DELETED_URL = unresolvableUrl(`${run.runId}-trash-deleted`);
        env.KEPT_URL = unresolvableUrl(`${run.runId}-trash-kept`);
      }
      if (testCase.id === 'BULK-COPY-001') {
        env.OLDEST_URL = unresolvableUrl(`${run.runId}-copy-oldest`);
        env.MIDDLE_URL = unresolvableUrl(`${run.runId}-copy-middle`);
        env.NEWEST_URL = unresolvableUrl(`${run.runId}-copy-newest`);
      }
      if (['LOCK-APP-002', 'LOCK-AUTORELOCK-001'].includes(testCase.id)) {
        env.ANCHOR_URL = unresolvableUrl(`${run.runId}-lock-anchor`);
        env.LOCK_PASSWORD = unique('lock-password');
      }
      if (testCase.id === 'LOCK-APP-002') {
        const assertKeyboard = (up: boolean) => async (context: CaseStepContext) => {
          const { keyboard } = await settledKeyboard(context, up);
          expect(
            Boolean(keyboard),
            up ? 'cold-start lock asks for entry' : 'manual relock stays quiet',
          ).toBe(up);
          return null;
        };
        steps = [
          testCase.path,
          assertKeyboard(true),
          'mobile/flows/parts/lock-app-unlock-and-relock.yaml',
          assertKeyboard(false),
          'mobile/flows/parts/lock-app-reopen.yaml',
        ];
      }
      if (testCase.id === 'LOCK-AUTORELOCK-001') {
        steps = [
          testCase.path,
          async () => {
            await new Promise((resolve) => setTimeout(resolve, AUTO_RELOCK_WAIT_MS));
            return null;
          },
          'mobile/flows/parts/lock-autorelock-resume.yaml',
        ];
      }
      if (testCase.id === 'IAP-ENTITLEMENT-001') {
        // The grant lands while the device is signed in and reading Free, so
        // the only way it can learn of it is to ask again — which the part
        // does through the Subscription section's Refresh. (PLUS_CASES grant
        // BEFORE sign-in instead; this case is the one whose subject is the
        // client catching up.)
        steps = [
          testCase.path,
          async () => {
            await grantPlus(account.username);
            return null;
          },
          'mobile/flows/parts/plan-gates-plus.yaml',
        ];
      }
      if (testCase.id === 'LOCK-LIST-001') {
        env.PARENT_LIST = unique('E2E lock parent');
        env.CHILD_LIST = unique('E2E lock child');
        env.TAG_NAME = unique('e2e-lock-tag');
        env.WORD = unique('coverword').toLowerCase();
        env.COVERED_URL = unresolvableUrl(`${env.WORD}-covered`);
        env.OPEN_URL = unresolvableUrl(`${env.WORD}-open`);
        env.LOCK_PASSWORD = unique('lock-password');
      }
      if (testCase.id === 'EXTRACT-NATIVE-001') {
        const known = knownPage('e2e-device-save');
        env.LINK_URL = known.url;
        env.LINK_TITLE = known.title;
      }
      if (extractionLibrary) {
        env.LINK_TITLE = extractionLibrary.known.title;
        env.FILLER_TEXT = displayUrl(extractionLibrary.fillerUrls[0]);
        env.TOTAL = String(extractionLibrary.total);
      }
      if (testCase.id === 'DATA-DELETE-ALL-NATIVE-001') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-delete-all`);
        env.LIST_NAME = unique(`${run.runId} delete list`);
        env.TAG_NAME = unique(`${run.runId} delete tag`);
      }
      if (testCase.id.startsWith('SHARE-')) {
        const shareToken = `${run.runId}-${testCase.id.toLowerCase()}`;
        const url =
          run.platform === 'ios'
            ? `${API_URL}/health?share=${encodeURIComponent(shareToken)}`
            : unresolvableUrl(shareToken);
        env.LINK_URL = url;
        env.LINK_TEXT = displayUrl(url);
        // Safari supplies the real document title on iOS. Android receives the
        // run-scoped multi-word EXTRA_SUBJECT below.
        env.SHARE_TITLE = run.platform === 'ios' ? 'localhost' : unique('E2E shared page title');
        // Maestro text selectors are regular expressions. iOS keeps the URL's
        // regex-safe token; Android renders EXTRA_SUBJECT as the primary title,
        // so its equally unique title is the honest visible oracle.
        env.LINK_MATCH = run.platform === 'ios' ? shareToken : env.SHARE_TITLE;
        env.SHARE_SOURCE_TEXT = '.*status.*ok.*';
        env.LIST_NAME = ['SHARE-ANDROID-001', 'SHARE-IOS-001'].includes(testCase.id)
          ? shareListName
          : shareCreatedListName;
        env.TAG_NAME = ['SHARE-ANDROID-001', 'SHARE-IOS-001'].includes(testCase.id)
          ? shareTagName
          : shareCreatedTagName;
        if (testCase.id === 'SHARE-BOUNDARY-001') {
          env.CAP_HOST = new URL(pagedUrls[0]).host;
        }
        if (
          testCase.id === 'SHARE-EXTRACT-ANDROID-001' ||
          testCase.id === 'SHARE-EXTRACT-IOS-001'
        ) {
          // The share cases that share a page the device can fetch: their
          // subject is the fetch. On Android EXTRA_SUBJECT stays the run-scoped
          // title, so the row has something to change FROM. On iOS Safari is
          // the producer, so the page's own heading is what settles there and
          // its own title is what the sheet shows.
          const known = knownPage('e2e-share-extract');
          env.LINK_URL = known.url;
          env.LINK_TEXT = displayUrl(known.url);
          env.LINK_TITLE = known.title;
          if (run.platform === 'ios') {
            env.SHARE_TITLE = known.title;
            env.SHARE_SOURCE_TEXT = `.*${known.title}.*`;
          }
        }
      }

      const credentials: Credentials = { username: account.username, password: account.password };
      // Undone after the case whether it passed or not: a web profile a case
      // kept open, a device a case took off the api, or a picker fixture copied
      // into the device's Files/Downloads surface.
      const cleanupActions: Array<() => Promise<void>> = [];

      // Expo extracts on the device and never calls bracemark-extractor. On
      // Android that is made observable: the extractor's reverse mapping is gone
      // for the whole case, so a title can only have come from the device's own
      // fetch. (The iOS simulator shares this Mac's loopback; there is no
      // per-device cut to make, and the case proves the device path alone.)
      if (!IS_STAGING && testCase.id.startsWith('EXTRACT-NATIVE-') && run.platform === 'android') {
        await setPortReachable(run.deviceId, 8788, false);
        cleanupActions.push(() => setPortReachable(run.deviceId, 8788, true));
      }

      if (importFixture) {
        const fileName = `phase5-${run.runId}.zip`;
        env.IMPORT_FILE_NAME = fileName;
        env.LINK_TITLE = importFixture.linkTitle;
        env.LIST_NAME = importFixture.listName;
        env.TAG_NAME = importFixture.tagName;
        cleanupActions.push(
          await stageDocumentPickerFile({
            platform: run.platform,
            deviceId: run.deviceId,
            sourcePath: importFixture.archivePath,
            fileName,
          }),
        );
      }

      const openShare = async (options: { noUrl?: boolean } = {}) => {
        if (options.noUrl) {
          let sourceUrl = env.LINK_URL;
          if (run.platform === 'ios') {
            const source = await startPlainTextShareSource();
            cleanupActions.push(source.close);
            sourceUrl = source.url;
          }
          await openSystemShare({
            platform: run.platform,
            deviceId: run.deviceId,
            sourceUrl,
            sharedText: 'Plain text without a link',
            title: 'Plain text fixture',
          });
          return;
        }
        // Not reassigned here: a case that shares another page than the api's
        // health document has already said what Safari settles on.
        env.SHARE_SOURCE_TEXT ??= '.*status.*ok.*';
        await openSystemShare({
          platform: run.platform,
          deviceId: run.deviceId,
          sourceUrl: env.LINK_URL,
          title: env.SHARE_TITLE,
        });
      };

      if (testCase.id === 'SHARE-ANDROID-001') {
        let pidBefore: string | null = null;
        steps = [
          testCase.path,
          async () => {
            pidBefore = await mainAppPid(run.platform, run.deviceId);
            if (!pidBefore) throw new Error('main app was not running before ACTION_SEND');
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-pick.yaml',
          // A configuration change under the half-filled sheet. ShareActivity
          // must ride it out rather than be recreated, which would remount the
          // share root from the intent and hand share-save.yaml the default
          // list and no tags (docs/share-sheet.md, _the shape_).
          async () => {
            await cycleAppearance(run.platform, run.deviceId);
            return null;
          },
          'mobile/flows/parts/share-save.yaml',
          async () => {
            const pidAfter = await mainAppPid(run.platform, run.deviceId);
            if (pidAfter !== pidBefore) {
              throw new Error(`ACTION_SEND replaced the main process: ${pidBefore} -> ${pidAfter}`);
            }
            return null;
          },
          'mobile/flows/parts/share-foreground-result.yaml',
        ];
      }
      if (testCase.id === 'SHARE-IOS-001') {
        steps = [
          testCase.path,
          async () => {
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-pick.yaml',
          'mobile/flows/parts/share-save.yaml',
          'mobile/flows/parts/share-foreground-result.yaml',
        ];
      }
      if (testCase.id === 'SHARE-ANDROID-002') {
        cleanupActions.push(async () => setApiReachable(run.deviceId, true));
        steps = [
          testCase.path,
          async () => {
            await assertMainAppStopped(run.platform, run.deviceId, 'before killed-app share');
            await setApiReachable(run.deviceId, false);
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-save-default.yaml',
          async () => {
            await setApiReachable(run.deviceId, true);
            return null;
          },
          'mobile/flows/parts/share-foreground-sync.yaml',
          async () => {
            await readSharedLinkFromWeb(
              `${run.runId}-${testCase.id}-reader`,
              credentials,
              env.LINK_URL,
            );
            return null;
          },
        ];
      }
      if (testCase.id === 'SHARE-EXTRACT-ANDROID-001' || testCase.id === 'SHARE-EXTRACT-IOS-001') {
        steps = [
          testCase.path,
          async () => {
            await assertMainAppStopped(run.platform, run.deviceId, 'before killed-app share');
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-save-default.yaml',
          `mobile/flows/parts/share-extract-${run.platform}.yaml`,
        ];
      }
      if (testCase.id === 'SHARE-IOS-002') {
        steps = [
          testCase.path,
          async () => {
            await assertMainAppStopped(run.platform, run.deviceId, 'before signed-out share');
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-signed-out.yaml',
          async () => {
            await assertMainAppStopped(run.platform, run.deviceId, 'after signed-out share');
            return null;
          },
        ];
      }
      if (testCase.id === 'SHARE-IOS-003') {
        // One gesture, three screens, two outcomes. The host's own sheet answers
        // a downward drag on the share extension, and the pickers ask native to
        // hold that off while they are up (docs/share-sheet.md, _the pickers
        // hold the system's swipe off_); the simulator honours the flag. So the
        // flick that must leave each picker standing is the SAME flick that then
        // takes the compose screen away — a gesture too weak to dismiss anything
        // would pass the first half and fail the second, and a guard that never
        // lets go passes the first and fails the second too.
        //
        // The speed is the gesture, and it is set by the SHORTEST of them: the
        // pull from inside a picker's scroller has ~175pt to travel. Measured on
        // iOS 26.5 with the hold removed, that pull dismisses the sheet at 50ms
        // and at 100ms only starts the dismissal and settles back — which is a
        // step that passes with or without the guard.
        const flick =
          (label: string, start: (root: HierarchyNode) => { x: number; y: number }) =>
          async (context: CaseStepContext) => {
            const root = parseHierarchy(await context.hierarchy());
            const from = start(root);
            return writeDragFlow(
              context,
              label,
              from,
              { x: from.x, y: screenBox(root).bottom - 1 },
              50,
            );
          };
        // The header row's empty middle, on the row's top edge: beside the
        // lockup or the back control, never on one.
        const fromHeader = (control: string) => (root: HierarchyNode) => ({
          x: centerOf(screenBox(root)).x,
          y: boxById(root, control).top,
        });
        // Inside the scroller, one row under the field — the pull a thumb makes
        // on a list already at its top, which is the accident the hold is for.
        const fromScroller = (input: string) => (root: HierarchyNode) => {
          const field = boxById(root, input);
          return { x: centerOf(field).x, y: field.bottom + 40 };
        };
        const held = (input: string) => ({
          flow: 'mobile/flows/parts/share-swipe-held.yaml',
          env: { PICKER_INPUT: input },
        });
        steps = [
          testCase.path,
          async () => {
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-swipe-list.yaml',
          flick('list-pull', fromScroller('share-list-input')),
          held('share-list-input'),
          flick('list-flick', fromHeader('share-back')),
          held('share-list-input'),
          'mobile/flows/parts/share-swipe-tags.yaml',
          flick('tags-pull', fromScroller('share-tag-input')),
          held('share-tag-input'),
          flick('tags-flick', fromHeader('share-back')),
          held('share-tag-input'),
          'mobile/flows/parts/share-swipe-compose.yaml',
          flick('compose-flick', fromHeader('share-close')),
          'mobile/flows/parts/share-swipe-dismissed.yaml',
        ];
      }
      if (testCase.id === 'SHARE-BOUNDARY-001') {
        steps = [
          testCase.path,
          async () => {
            await openShare({ noUrl: true });
            return null;
          },
          'mobile/flows/parts/share-no-url.yaml',
          async () => {
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-quota.yaml',
        ];
      }
      if (testCase.id === 'SHARE-CREATE-001') {
        steps = [
          testCase.path,
          async () => {
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-create-list.yaml',
          'mobile/flows/parts/share-create-tag.yaml',
          'mobile/flows/parts/share-create-save.yaml',
          'mobile/flows/parts/share-create-list-result.yaml',
          async (context) => {
            const root = parseHierarchy(await context.hierarchy());
            onlyNode(root, 'List name', env.LIST_NAME, `shared list named ${env.LIST_NAME}`);
            return null;
          },
          'mobile/flows/parts/share-create-tag-result.yaml',
          async (context) => {
            const root = parseHierarchy(await context.hierarchy());
            onlyNode(root, 'Tag name', env.TAG_NAME, `shared tag named ${env.TAG_NAME}`);
            return null;
          },
        ];
      }
      if (testCase.id === 'SHARE-CROSS-CLIENT-001') {
        steps = [
          testCase.path,
          async () => {
            await openShare();
            return null;
          },
          'mobile/flows/parts/share-save-default.yaml',
          'mobile/flows/parts/share-foreground-sync.yaml',
          async () => {
            await readSharedLinkFromWeb(
              `${run.runId}-${testCase.id}-reader`,
              credentials,
              env.LINK_URL,
            );
            return null;
          },
        ];
      }

      if (
        testCase.id === 'SYNC-REFRESH-PILL-IOS-001' ||
        testCase.id === 'SYNC-REFRESH-PILL-ANDROID-001'
      ) {
        env.HOST = new URL(pagedUrls[0]).host;
        env.REMOTE_URL = unresolvableUrl(`${run.runId}-written-on-web`);
        let anchor: { url: string; box: Box } | undefined;
        steps = [
          testCase.path,
          // Measure the first fixture row painted wholly inside the scrolled
          // list, then have another client write.
          async (context) => {
            const root = parseHierarchy(await context.hierarchy());
            const list = boxById(root, 'links-list');
            for (const url of pagedUrls) {
              const box = rowBoxByText(root, displayUrl(url));
              if (box && isInside(box, list)) {
                anchor = { url, box };
                break;
              }
            }
            if (!anchor) throw new Error('no fixture row is painted inside the list');
            await writeFromWeb(`${run.runId}-${testCase.id}-writer`, credentials, env.REMOTE_URL);
            return null;
          },
          'mobile/flows/parts/refresh-pill-held.yaml',
          // The pull landed behind the pill: the anchor is exactly where it was,
          // and the pulled row is not mounted at all — FlashList keeps a
          // prepended row mounted above the viewport, so "not on screen" would
          // pass a promoted snapshot too.
          async (context) => {
            if (!anchor) throw new Error('the anchor was never measured');
            const { root, row } = await rowInList(context, anchor.url);
            if (!row || formatBox(row) !== formatBox(anchor.box)) {
              throw new Error(
                `the engaged list moved under a pull: ${formatBox(anchor.box)} → ${row ? formatBox(row) : 'unmounted'}`,
              );
            }
            if (rowBoxByText(root, displayUrl(env.REMOTE_URL))) {
              throw new Error('the pulled row was mounted before the refresh pill was pressed');
            }
            return null;
          },
          'mobile/flows/parts/refresh-pill-applied.yaml',
          async (context) => {
            const { root, list, row } = await rowInList(context, env.REMOTE_URL);
            const previous = rowBoxByText(root, displayUrl(pagedUrls[0]));
            assertLeadsList(list, row, previous, 'after the refresh pill');
            return null;
          },
        ];
      }
      if (testCase.id === 'SCALE-IOS-001' || testCase.id === 'SCALE-ANDROID-001') {
        const library = scaleLibrary;
        if (!library) throw new Error(`${testCase.id}: the scale library was never imported`);
        const [first, later] = nativeDeepPins(library);
        env.PIN_0 = scaleRow(library, library.pinned[0]).match;
        env.BEFORE_1 = scaleRow(library, first.before).match;
        env.AFTER_1 = scaleRow(library, first.after).match;
        env.PIN_1 = scaleRow(library, first.url).match;
        env.BEFORE_2 = scaleRow(library, later.before).match;
        env.AFTER_2 = scaleRow(library, later.after).match;
        env.PIN_2 = scaleRow(library, later.url).match;
        steps = [
          testCase.path,
          assertClosedOver(library, first),
          'mobile/flows/parts/scale-deeper.yaml',
          assertClosedOver(library, later),
        ];
      }
      if (testCase.id === 'SYNC-LOCAL-TOP-001') {
        env.HOST = new URL(pagedUrls[0]).host;
        env.LINK_URL = unresolvableUrl(`${run.runId}-local-top`);
        steps = [
          testCase.path,
          async (context) => {
            const { root, list, row } = await rowInList(context, env.LINK_URL);
            const previous = rowBoxByText(root, displayUrl(pagedUrls[0]));
            assertLeadsList(list, row, previous, 'a save at offset zero');
            return null;
          },
        ];
      }
      if (testCase.id === 'VIEWPORT-BULK-001') {
        env.HOST = new URL(pagedUrls[0]).host;
        let before: { url: string; offset: number } | undefined;
        // The row the scroll position is anchored on, and where its top edge
        // sits against the list's — the position as the reader sees it. Both
        // must hold as bulk mode comes and goes. (Rows BELOW the anchor may
        // legitimately move: bulk mode hides each row's ⋯, so a title that
        // wrapped around it can re-measure a line shorter.) Android reports a
        // node's bounds CLIPPED to its scroller, so a row crossing the top edge
        // reads as starting exactly on it and only its identity is comparable;
        // iOS reports the real frame, and its offset is compared too.
        const holdsPosition = (label: string) => async (context: CaseStepContext) => {
          const { list, anchor } = await paintedRows(context, pagedUrls, label);
          const offset = anchor.box.top - list.top;
          if (!before) {
            before = { url: anchor.url, offset };
            return null;
          }
          const moved = before.offset < 0 && Math.abs(offset - before.offset) > 2;
          if (anchor.url !== before.url || moved) {
            throw new Error(
              `${label}: the list moved — ${before.url} at ${before.offset} became ` +
                `${anchor.url} at ${offset}`,
            );
          }
          return null;
        };
        steps = [
          testCase.path,
          holdsPosition('scrolled'),
          'mobile/flows/parts/bulk-viewport-enter.yaml',
          holdsPosition('selecting'),
          'mobile/flows/parts/bulk-viewport-exit.yaml',
          holdsPosition('left'),
        ];
      }
      if (testCase.id === 'VIEWPORT-KEYBOARD-001') {
        env.HOST = new URL(pagedUrls[0]).host;
        env.LINK_URL = unresolvableUrl(`${run.runId}-keyboard`);
        // Every paged row's address says `row-…`, so the search box's list
        // stays a full, scrollable screen under the keyboard.
        env.WORD = 'row';
        // …and nothing says this, so the same box over the same library
        // leaves the pane with no row in it at all.
        env.MISS = 'zzqx';
        env.TAG_NAME = unique('e2e-keyboard-tag');
        const shareUrl = unresolvableUrl(`${run.runId}-keyboard-share`);
        // The empty pane's visible stretch — what of `links-empty` the keyboard
        // leaves showing — and a point a fraction of the way down it. The
        // message is centred in the whole pane and so sits at the keyboard's
        // edge; the upper part of the stretch is bare pane.
        const onEmptyPane = async (context: CaseStepContext, label: string) => {
          const { root, keyboard } = await clearOfKeyboard(
            context,
            label,
            byIds('links-search-input', 'links-search-clear', 'links-search-advanced'),
          );
          const pane = boxById(root, 'links-empty');
          const span = Math.min(pane.bottom, keyboard.top) - pane.top;
          if (span <= 0) throw new Error(`${label}: none of the empty pane is above the keyboard`);
          return (fraction: number) => ({
            x: centerOf(pane).x,
            y: pane.top + Math.round(span * fraction),
          });
        };
        steps = [
          testCase.path,
          async (context) => {
            await clearOfKeyboard(
              context,
              'add panel, URL',
              byIds('add-link-url', 'add-link-save'),
            );
            return null;
          },
          'mobile/flows/parts/keyboard-add-note.yaml',
          // Note clear of the keyboard; then the panel's chrome — the header's
          // empty middle, level with its ✕ (link-add-panel.tsx) — which the
          // panel claims and answers with Keyboard.dismiss.
          async (context) => {
            const { root, screen } = await clearOfKeyboard(
              context,
              'add panel, Note',
              byIds('add-link-note', 'add-link-save'),
            );
            const close = boxOf(onlyNode(root, 'Close add link', undefined, 'add panel ✕'));
            return writeTapFlow(context, 'add-panel-chrome', {
              x: Math.round(screen.right / 2),
              y: centerOf(close).y,
            });
          },
          (context) =>
            keyboardGone(context, 'add panel, after its chrome was tapped', 'add-link-note'),
          'mobile/flows/parts/keyboard-add-dismissed.yaml',
          // The box, its two controls and the first result are all above the
          // keyboard, and so is the middle of the screen, where the next part's
          // drag starts — on the list, not on the keys.
          async (context) => {
            const { root, keyboard } = await clearOfKeyboard(context, 'search', (tree) => [
              ...byIds('links-search-input', 'links-search-clear', 'links-search-advanced')(tree),
            ]);
            const list = boxById(root, 'links-list');
            const row = rowBoxByText(root, displayUrl(pagedUrls[0]));
            if (!row || row.bottom > keyboard.top || !isInside(row, list)) {
              throw new Error('search: the first result is not reachable above the keyboard');
            }
            // The drag the next step makes: from the middle of the list's
            // visible stretch toward its top — on the rows, never on the keys.
            // (Maestro's directional swipe began on the keyboard, measured on
            // iOS 26.5, and moved nothing.) On Android it is one `input
            // motionevent` per step, NOT `input swipe`: that command times its
            // moves off the clock and waits for the app to finish each event,
            // so a slow touch-down leaves no time for any move and it lifts at
            // the far end — a tap on the row, which opened the link
            // (docs/app-drivers.md, _`input swipe` can arrive as a tap_).
            const visibleBottom = Math.min(list.bottom, keyboard.top);
            const x = centerOf(list).x;
            const span = visibleBottom - list.top;
            const from = { x, y: list.top + Math.round(span * 0.5) };
            const to = { x, y: list.top + Math.round(span * 0.05) };
            if (context.platform === 'android') {
              await androidDrag(context.deviceId, from, to);
              return null;
            }
            return writeDragFlow(context, 'search-results-drag', from, to, 250);
          },
          (context) =>
            keyboardGone(context, 'search, after dragging the results', 'links-search-input'),
          'mobile/flows/parts/keyboard-search-kept.yaml',
          // The same box over a search that matched nothing: the list is gone,
          // and the empty state in its place has to answer for it — first a
          // tap on the bare pane…
          'mobile/flows/parts/keyboard-search-empty.yaml',
          async (context) => {
            const at = await onEmptyPane(context, 'search, no match');
            return writeTapFlow(context, 'empty-pane-tap', at(0.25));
          },
          (context) =>
            keyboardGone(
              context,
              'search with no match, after the empty pane was tapped',
              'links-search-input',
            ),
          'mobile/flows/parts/keyboard-search-empty-kept.yaml',
          // …then, refocused, the drag a reader makes on a list out of habit.
          // The pane has nothing to scroll, and the two platforms answer by
          // different props: iOS bounces, so it is `on-drag`'s; Android never
          // starts the drag, so it is `"handled"`'s, on release
          // (docs/soft-keyboard.md, _dismissal_, 2). Explicit touch events on
          // Android, as for the results above.
          'mobile/flows/parts/keyboard-search-empty-focus.yaml',
          async (context) => {
            const at = await onEmptyPane(context, 'search, no match, refocused');
            if (context.platform === 'android') {
              await androidDrag(context.deviceId, at(0.6), at(0.1));
              return null;
            }
            return writeDragFlow(context, 'empty-pane-drag', at(0.6), at(0.1), 250);
          },
          (context) =>
            keyboardGone(
              context,
              'search with no match, after the empty pane was dragged',
              'links-search-input',
            ),
          'mobile/flows/parts/keyboard-search-empty-kept.yaml',
        ];
        // The share sheet's text entry is only observable on Android: over the
        // iOS extension the panel leaves the accessibility tree the moment the
        // keyboard is presented (docs/soft-keyboard.md, _verifying any of this_).
        if (run.platform === 'android') {
          steps.push(
            async () => {
              await openSystemShare({
                platform: run.platform,
                deviceId: run.deviceId,
                sourceUrl: shareUrl,
                title: unique('E2E keyboard share'),
              });
              return null;
            },
            'mobile/flows/parts/keyboard-share-tags.yaml',
            // Field, Create row and Done above the keyboard; then the gap under
            // the field, which is the sheet's dismiss layer (share-kit.tsx).
            async (context) => {
              const { root } = await clearOfKeyboard(context, 'share tags', (tree) => [
                ...byIds('share-tag-input', 'share-tag-create')(tree),
                { what: 'Done', box: requireBox(rowBoxByText(tree, 'Done'), 'the Done button') },
              ]);
              const input = boxById(root, 'share-tag-input');
              return writeTapFlow(context, 'share-gap', {
                x: centerOf(input).x,
                y: Math.round(input.bottom + (input.bottom - input.top) / 4),
              });
            },
            (context) =>
              keyboardGone(context, 'share tags, after the gap was tapped', 'share-tag-input'),
            'mobile/flows/parts/keyboard-share-dismissed.yaml',
          );
        }
      }
      if (testCase.id === 'SKELETON-NATIVE-001') {
        let api: ApiControl | undefined;
        cleanupActions.push(async () => api?.resume());
        steps = [
          testCase.path,
          // A slow server from the moment of sign-in, so the first pull is
          // still running when the flow looks for it…
          async () => {
            api = await controlApi();
            api.throttle();
            return null;
          },
          'mobile/flows/parts/loading-signed-in.yaml',
          // …and then no server at all, so it stays where the flow found it.
          async () => {
            api?.pause();
            return null;
          },
          'mobile/flows/parts/loading-held.yaml',
          // Painted, not merely present: the bar sits on screen and the band
          // around it — the headline over it, the count under it — carries ink.
          async (context) => {
            const root = parseHierarchy(await context.hierarchy());
            // Android folds the bar's value into its name; iOS does not.
            const bars = findNodes(root, (attributes) =>
              /^Decrypting your links(, .*)?$/.test(attributes.accessibilityText ?? ''),
            );
            if (bars.length !== 1)
              throw new Error(`expected one first-pull progressbar, found ${bars.length}`);
            const box = boxOf(bars[0]);
            const screen = screenBox(root);
            if (!isInside(box, screen) || box.right - box.left <= 0) {
              throw new Error(`the progressbar ${formatBox(box)} is not on screen`);
            }
            const reach = Math.round((box.right - box.left) / 4);
            const band = { ...box, top: box.top - reach, bottom: box.bottom + reach };
            const raster = await screenshot(
              context.platform,
              context.deviceId,
              join(context.caseDir, `${context.index}-loading-held.png`),
            );
            if (inkShare(raster, band, screen.right) < PAINTED_ROW_INK) {
              throw new Error(`the loading state around ${formatBox(box)} is painted blank`);
            }
            api?.resume();
            return null;
          },
          'mobile/flows/parts/loading-released.yaml',
        ];
      }
      if (testCase.id === 'OFFLINE-IOS-001' || testCase.id === 'OFFLINE-ANDROID-001') {
        env.EDITED_URL = offlineUrl;
        env.ADDED_URL = unresolvableUrl(`${run.runId}-offline-added`);
        env.TITLE = unique('E2E offline title');
        let api: ApiControl | undefined;
        const reconnect = async () => {
          if (run.platform === 'android') await setApiReachable(run.deviceId, true);
          else api?.resume();
        };
        cleanupActions.push(reconnect);
        steps = [
          testCase.path,
          async () => {
            if (run.platform === 'android') {
              await setApiReachable(run.deviceId, false);
            } else {
              api = await controlApi();
              api.pause();
            }
            return null;
          },
          'mobile/flows/parts/offline-local.yaml',
          async () => {
            await reconnect();
            return null;
          },
          'mobile/flows/parts/offline-reconnect.yaml',
          async () => {
            await readFromWeb(`${run.runId}-${testCase.id}-reader`, credentials, [
              { url: env.ADDED_URL },
              { url: env.EDITED_URL, text: env.TITLE },
            ]);
            return null;
          },
        ];
      }
      if (
        testCase.id === 'OFFLINE-EXPORT-IOS-001' ||
        testCase.id === 'OFFLINE-EXPORT-ANDROID-001'
      ) {
        env.SYNCED_URL = offlineUrl;
        env.ADDED_URL = unresolvableUrl(`${run.runId}-offline-export-added`);
        // The same two cuts as OFFLINE-*-001: a refusal on Android, a hang on iOS.
        let api: ApiControl | undefined;
        cleanupActions.push(async () => {
          if (run.platform === 'android') await setApiReachable(run.deviceId, true);
          else api?.resume();
        });
        steps = [
          testCase.path,
          async () => {
            if (run.platform === 'android') {
              await setApiReachable(run.deviceId, false);
            } else {
              api = await controlApi();
              api.pause();
            }
            return null;
          },
          'mobile/flows/parts/offline-export-local.yaml',
          async (context) => {
            await assertExported(context, [env.SYNCED_URL, env.ADDED_URL]);
            return null;
          },
        ];
      }
      if (testCase.id === 'OFFLINE-API-ERROR-ANDROID-001') {
        env.EDITED_URL = offlineUrl;
        env.ADDED_URL = unresolvableUrl(`${run.runId}-api-error-added`);
        env.TITLE = unique('E2E api error title');
        const fault = await startFaultApi();
        cleanupActions.push(async () => {
          await setApiReachable(run.deviceId, true);
          await fault.close();
        });
        steps = [
          testCase.path,
          async () => {
            fault.answer(500);
            await routeApiTo(run.deviceId, fault.port);
            return null;
          },
          'mobile/flows/parts/api-error-local.yaml',
          async () => {
            fault.answer(404);
            return null;
          },
          'mobile/flows/parts/api-error-relaunch.yaml',
          async (context) => {
            await assertExported(context, [env.EDITED_URL, env.ADDED_URL]);
            await setApiReachable(run.deviceId, true);
            return null;
          },
          'mobile/flows/parts/offline-reconnect.yaml',
          async () => {
            await readFromWeb(`${run.runId}-${testCase.id}-reader`, credentials, [
              { url: env.ADDED_URL },
              { url: env.EDITED_URL, text: env.TITLE },
            ]);
            return null;
          },
        ];
      }
      if (testCase.id === 'SESSION-INVALID-NATIVE-001') {
        env.KEPT_URL = offlineUrl;
        steps = [
          testCase.path,
          async (context) => {
            // Non-empty first, or the empty count after would prove nothing.
            const before = await localRows(context, 'store-before');
            if (before === 0) throw new Error('the local store is empty before the revoke');
            await revokeOtherSessions(`${run.runId}-${testCase.id}-revoker`, credentials);
            return null;
          },
          'mobile/flows/parts/session-invalid-revoked.yaml',
          async (context) => {
            const after = await localRows(context, 'store-after');
            if (after !== 0)
              throw new Error(`${after} rows survived the revoked session’s teardown`);
            return null;
          },
          'mobile/flows/parts/session-invalid-return.yaml',
        ];
      }
      if (testCase.id === 'SIGN-OUT-RESIDUE-NATIVE-001') {
        env.KEPT_URL = offlineUrl;
        env.LIST_NAME = residueListName;
        // What marks a file as holding the account's plaintext: the saved URL's
        // host and its path, apart — a writer that escapes the slash between
        // them still matches both — and the list's name.
        const kept = new URL(offlineUrl);
        const markers = [kept.host, kept.pathname.slice(1), residueListName];
        // And the username, which is not content but is whose device this was:
        // it rode in a request URL into Android's HTTP cache, where no teardown
        // reaches, until the api marked its responses `no-store`
        // (docs/api-contracts.md, _no response is cacheable_). Android only. An
        // iOS run is a dev build, and the dev client's network inspector hands
        // every response to the URL loading system as cacheable, so the
        // simulator's URL cache holds every request whatever the api says — a
        // hit there is the harness's, and would stay red on a correct app.
        if (run.platform === 'android') markers.push(account.username);
        steps = [
          testCase.path,
          async (context) => {
            // Each marker found first, or finding none after would prove nothing.
            const hits = await sandboxHits(context, 'sandbox-before', markers);
            for (const marker of markers) {
              if (!hits.some((hit) => hit.marker === marker)) {
                throw new Error(`nothing in the sandbox holds "${marker}" before the sign-out`);
              }
            }
            return null;
          },
          'mobile/flows/parts/sign-out-residue-signed-out.yaml',
          async (context) => {
            const hits = await sandboxHits(context, 'sandbox-after', markers);
            if (hits.length > 0) {
              const where = hits.map((hit) => `"${hit.marker}" in ${hit.path}`).join('; ');
              throw new Error(`the sign-out left the account’s data on the device: ${where}`);
            }
            return null;
          },
        ];
      }
      if (testCase.id === 'SESSION-EXPIRED-NATIVE-001') {
        // docs/sessions.md: an expired session keeps everything. The device's
        // session is expired the way a user expires it — a password change on
        // another device — and the flow resumes with the new password.
        const newPassword = newCredentials().password;
        const queuedUrl = unresolvableUrl(`${run.runId}-expired-queued`);
        env.KEPT_URL = offlineUrl;
        env.QUEUED_URL = queuedUrl;
        env.RESUME_PASSWORD = newPassword;
        steps = [
          testCase.path,
          async () => {
            await changePasswordElsewhere(
              `${run.runId}-${testCase.id}-changer`,
              credentials,
              newPassword,
            );
            return null;
          },
          'mobile/flows/parts/session-expired-paused.yaml',
          async (context) => {
            const rows = await localRows(context, 'store-paused');
            if (rows === 0) throw new Error('the expired session emptied the local store');
            return null;
          },
          'mobile/flows/parts/session-expired-resume.yaml',
          async () => {
            await readFromWeb(
              `${run.runId}-${testCase.id}-reader`,
              { username: credentials.username, password: newPassword },
              [{ url: queuedUrl }],
            );
            return null;
          },
        ];
      }
      if (testCase.id === 'SESSION-UNKNOWN-NATIVE-001') {
        // docs/sessions.md: a token the server no longer knows keeps everything,
        // like an expiry. The rows go the way the cleanup takes them — deleted
        // from the api's database (seed/sessions.ts) — and the flow resumes with
        // the same password, reusing SESSION-EXPIRED-NATIVE-001's parts.
        const queuedUrl = unresolvableUrl(`${run.runId}-unknown-queued`);
        env.KEPT_URL = offlineUrl;
        env.QUEUED_URL = queuedUrl;
        env.RESUME_PASSWORD = credentials.password;
        steps = [
          testCase.path,
          async () => {
            await forgetSessions(credentials.username);
            return null;
          },
          'mobile/flows/parts/session-expired-paused.yaml',
          async (context) => {
            const rows = await localRows(context, 'store-paused');
            if (rows === 0) throw new Error('the unknown session emptied the local store');
            return null;
          },
          'mobile/flows/parts/session-expired-resume.yaml',
          async () => {
            await readFromWeb(`${run.runId}-${testCase.id}-reader`, credentials, [
              { url: queuedUrl },
            ]);
            return null;
          },
        ];
      }
      if (testCase.id === 'SYNC-CONFLICT-001') {
        env.LINK_URL = conflictUrl;
        env.WEB_TITLE = unique('E2E web title');
        env.NATIVE_TITLE = unique('E2E device title');
        let web: LaunchedApp | undefined;
        cleanupActions.push(async () => {
          await web?.close();
          await setApiReachable(run.deviceId, true);
        });
        steps = [
          testCase.path,
          // Both clients go offline and the web one retitles the link. The web
          // profile stays open across the device's steps: its unpushed edit
          // lives in this profile's Dexie and nowhere else.
          async () => {
            web = await launchApp(profileDir(`${run.runId}-conflict-web`), {
              existing: credentials,
            });
            const { page } = web;
            await page.goto('/links');
            await expect(linkRow(page, conflictUrl)).toHaveCount(1);
            await setApiReachable(run.deviceId, false);
            await web.context.setOffline(true);
            await chooseRowMenuItem(page, conflictUrl, 'Edit');
            const dialog = page.getByRole('dialog', { name: 'Edit link' });
            await dialog.getByRole('textbox', { name: 'Title' }).fill(env.WEB_TITLE);
            await dialog.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(linkRow(page, conflictUrl)).toContainText(env.WEB_TITLE);
            return null;
          },
          'mobile/flows/parts/sync-conflict-native-edit.yaml',
          // The device reconnects FIRST and pushes its title.
          async () => {
            await setApiReachable(run.deviceId, true);
            return null;
          },
          'mobile/flows/parts/sync-conflict-native-push.yaml',
          // The web profile reconnects SECOND: its reconcile finds the server
          // changed since its base and resolves local-wins, so its title is
          // pushed over the device's and survives a reload.
          async () => {
            if (!web) throw new Error('the web profile was never opened');
            const { page } = web;
            await web.context.setOffline(false);
            await syncAndWait(page);
            await page.reload();
            const row = linkRow(page, conflictUrl);
            await expect(row).toContainText(env.WEB_TITLE);
            await expect(row).not.toContainText(env.NATIVE_TITLE);
            return null;
          },
          'mobile/flows/parts/sync-conflict-native-pull.yaml',
        ];
      }

      try {
        await run.runCase(
          testCase,
          env,
          [account.password, account.recoveryCode ?? '', env.LOCK_PASSWORD ?? ''],
          steps,
        );
      } finally {
        for (const cleanup of cleanupActions.reverse()) await cleanup();
      }
    }
    await run.finish('passed');
  } catch (error) {
    await run.finish('failed');
    throw error;
  }
}

await main();
