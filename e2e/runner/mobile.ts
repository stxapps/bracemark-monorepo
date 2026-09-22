import { join } from 'node:path';

import { expect } from '@playwright/test';

import { profileDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { type Credentials } from '../web/fixtures/account';
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
import { grantPlus } from '../web/fixtures/plan';
import { syncAndWait } from '../web/fixtures/sync';
import { createInSettings } from '../web/fixtures/taxonomy';
import { parseNativeCli } from './cli';
import { stageDocumentPickerFile } from './device-files';
import {
  type Box,
  boxById,
  boxOf,
  centerOf,
  formatBox,
  isInside,
  onlyNode,
  parseHierarchy,
  rowBoxByText,
  sameRow,
  writeDragFlow,
} from './hierarchy';
import { provisionAccount } from './lib';
import { type CaseStep, type CaseStepContext, prepareNativeRun } from './native-run';
import { capture } from './process';
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

// Standalone native journeys. Platform and device are deliberately mandatory:
// a result that does not say which runtime it exercised is not a baseline.
async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseNativeCli();
  const selected = selectCasesForPlatform('native', options.platform, options);
  const run = await prepareNativeRun('mobile', options, selected);

  try {
    for (const testCase of selected) {
      // Every flow gets a fresh account. This makes destructive and ordering-
      // sensitive cases independent, and keeps a failed flow from poisoning the
      // state observed by the next one.
      const withRecovery = testCase.id === 'NATIVE-ACCOUNT-002';
      let pagedUrls: string[] = [];
      const conflictUrl = unresolvableUrl(`${run.runId}-conflict`);
      const shareListName = unique('E2E share list');
      const shareTagName = unique('e2e-share-tag');
      const shareCreatedListName = unique('E2E shared list');
      const shareCreatedTagName = unique('e2e-shared-tag');
      const importFixture = testCase.id.startsWith('DATA-IMPORT-NATIVE-')
        ? await writeSmallDataArchive(
            join(run.runDir, 'cases', testCase.id, 'fixture', 'small-bracemark.zip'),
            unique('E2E data'),
          )
        : undefined;
      let extractionLibrary: PendingExtractionLibrary | undefined;
      const account = await provisionAccount(`${run.runId}-${testCase.id}`, {
        withRecovery,
        prepare: async (app) => {
          if (PLUS_CASES.has(testCase.id)) await grantPlus(app.credentials.username);
          if (testCase.fixture === 'scale') {
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
      if (testCase.id.startsWith('EXTRACT-NATIVE-') && run.platform === 'android') {
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
        env.SHARE_SOURCE_TEXT = '.*status.*ok.*';
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
