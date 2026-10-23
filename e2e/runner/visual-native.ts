import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { profileDir as browserProfileDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { type Credentials } from '../web/fixtures/account';
import { API_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { type VisualLibrary, writeVisualLibrary } from '../web/fixtures/visual-library';
import { type DeviceLook, setAppearance, setTextSize } from './device-look';
import {
  type Box,
  boxOf,
  centerOf,
  findNodes,
  type HierarchyNode,
  isInside,
  onlyNode,
  parseHierarchy,
  sameRow,
  screenBox,
  writeTapFlow,
} from './hierarchy';
import { keyboardFrame } from './keyboard';
import { provisionAccount } from './lib';
import { type CaseStep, type CaseStepContext, type NativeRun } from './native-run';
import { diffRasters, encodePng, fillBox, type Raster, screenshot } from './pixels';
import { capture } from './process';
import { type E2ECase } from './registry';
import { openSystemShare, startPlainTextShareSource } from './share';
import { freezeStatusBar } from './status-bar';
import { capturedAt, captureKey, checkpointById, readVisualCatalog } from './visual-catalog';
import { capturesDir } from './visual-compare';

// The visual checkpoint cases on a device (docs/e2e.md, _visual checkpoints_):
// committed flows drive to each state, and a host step between them photographs
// the screen in every appearance the catalog lists. The step flips the SYSTEM
// appearance — a fresh account's theme is `system` — and the app follows it the
// way it follows a person's Control Centre toggle (runner/device-look.ts).

// Frames a checkpoint may take to hold still, and how still is still: two
// consecutive frames differing in under half the catalog's `changedRatio` —
// a blinking caret is ~400 device pixels on the iPhone, well inside it.
const MAX_FRAMES = 12;

const LOCK_PASSWORD = 'visual-lock-password';

const SETTINGS_SECTIONS = ['account', 'data', 'extraction', 'lists', 'tags', 'misc', 'about'];

interface Mask {
  kind: string;
  box: Box;
}

// The innermost nodes matching — a container whose name folds a match in is
// the whole section, and masking it would mask the checkpoint.
function innermost(root: HierarchyNode, match: (text: string) => boolean): Box[] {
  const boxes = findNodes(root, (attributes) =>
    [attributes.text, attributes.accessibilityText].some((value) => value && match(value)),
  ).map(boxOf);
  return boxes.filter(
    (box) =>
      !boxes.some((other) => other !== box && isInside(other, box) && area(other) < area(box)),
  );
}

function area(box: Box): number {
  return (box.right - box.left) * (box.bottom - box.top);
}

async function resolveMasks(
  context: CaseStepContext,
  root: HierarchyNode,
  kinds: string[],
  username: string,
): Promise<Mask[]> {
  const masks: Mask[] = [];
  for (const kind of kinds) {
    if (kind === 'keyboard') {
      const keyboard = await keyboardFrame(context, root);
      if (keyboard) masks.push({ kind, box: keyboard });
    } else if (kind === 'username') {
      for (const box of innermost(root, (text) => text === username)) masks.push({ kind, box });
    } else if (kind === 'sync-time') {
      for (const box of innermost(root, (text) => /^Last synced/.test(text))) {
        masks.push({ kind, box });
      }
    } else if (kind === 'relative-time') {
      // A phone-width row never prints its date (link-row.tsx,
      // RELATIVE_TIME_MIN_ROW_WIDTH, 576); a tablet's does, and it moves with
      // the wall clock — the library's dates are fixed, "now" is not. It has no
      // node to find: the date folds into the row's composite name. So the mask
      // is the strip it is drawn in, the row being `items-center` with the date
      // then `gap-3` then the ⋯: level with each ⋯, and to its left by more than
      // twice its width (36 + 36 + 8 covers the gap and "Mar 2009" in text-xs).
      // Sized off the ⋯, it is the same strip in iOS points and Android pixels.
      for (const node of findNodes(
        root,
        (attributes) => attributes['resource-id'] === 'link-options',
      )) {
        const options = boxOf(node);
        const width = options.right - options.left;
        masks.push({
          kind,
          box: {
            ...options,
            left: Math.max(0, options.left - Math.round(width * 2.2)),
            right: options.left,
          },
        });
      }
    }
  }
  return masks;
}

// A screenshot, masked, once two in a row agree. With `unlike`, frames that
// still match it are skipped first: right after an appearance flip the screen
// holds perfectly still in the OLD appearance for a frame or two, and a
// stability check alone would photograph that as the new one.
async function settledCapture(
  context: CaseStepContext,
  path: string,
  masks: Mask[],
  screenWidth: number,
  unlike?: Raster,
): Promise<Raster> {
  const { channelTolerance, changedRatio } = readVisualCatalog().comparison;
  let previous: Raster | undefined;
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const raster = await screenshot(context.platform, context.deviceId, path);
    for (const mask of masks) fillBox(raster, mask.box, screenWidth);
    const stillOld =
      unlike !== undefined &&
      (diffRasters(unlike, raster, channelTolerance)?.ratio ?? 1) <= changedRatio;
    if (!stillOld) {
      const drift = previous ? diffRasters(previous, raster, channelTolerance)?.ratio : undefined;
      if (drift !== undefined && drift <= changedRatio / 2) {
        await writeFile(path, encodePng(raster));
        return raster;
      }
      previous = raster;
    }
  }
  throw new Error(`${path}: the screen never held still for two frames`);
}

// A host step photographing one checkpoint in each of its appearances, ending
// the device back on light for whatever the next part does.
function checkpoint(id: string, runDir: string, username: string) {
  return async (context: CaseStepContext): Promise<null> => {
    const entry = checkpointById(id);
    if (!entry.platforms.includes(context.platform)) {
      throw new Error(`${id} is not a ${context.platform} checkpoint`);
    }
    const dir = capturesDir(runDir);
    await mkdir(dir, { recursive: true });

    // Masks are read off the tree once, before the first frame: the covered
    // regions do not move with the appearance.
    let masks: Mask[] = [];
    let screenWidth = 0;
    if (entry.masks.length > 0) {
      const root = parseHierarchy(await context.hierarchy());
      screenWidth = screenBox(root).right;
      masks = await resolveMasks(context, root, entry.masks, username);
    }

    let previous: Raster | undefined;
    for (const appearance of entry.appearances) {
      await setAppearance(context.platform, context.deviceId, appearance);
      const key = captureKey(id, { appearance });
      previous = await settledCapture(
        context,
        join(dir, `${key}.png`),
        masks,
        screenWidth,
        previous,
      );
      await writeFile(
        join(dir, `${key}.json`),
        `${JSON.stringify({ checkpoint: id, appearance, masks }, null, 2)}\n`,
      );
    }
    await setAppearance(context.platform, context.deviceId, 'light');
    return null;
  };
}

// The visual library, imported by a separate web profile and pushed, so the
// device can only have it by pulling.
async function importFromWeb(label: string, credentials: Credentials, archivePath: string) {
  const app = await launchApp(browserProfileDir(label), { existing: credentials });
  try {
    await importArchive(app.page, archivePath);
    await waitForSync(app.page);
  } finally {
    await app.close();
  }
}

function libraryEnv(library: VisualLibrary): Record<string, string> {
  return {
    LANDED_TITLE: library.landedTitle,
    SEARCH_WORD: library.searchWord,
    SEARCH_HIT: library.searchHit,
    SELECT_A: library.selectTitles[0],
    SELECT_B: library.selectTitles[1],
    PRIVATE_LIST: library.privateList,
    DRAFT_URL: library.draftUrl,
    LOCK_PASSWORD,
  };
}

// The page a share starts from, fixed so the surface shows the same words every
// run: on iOS a page Safari can open (the api's own health route), on Android a
// link carried by the ACTION_SEND itself.
function shareSource(platform: 'ios' | 'android') {
  const url =
    platform === 'ios'
      ? `${API_URL}/health?share=visual`
      : 'https://visual-share.invalid/a-page-worth-keeping';
  return { url, title: platform === 'ios' ? undefined : 'A page worth keeping' };
}

// `found` is the device's look as the run found it, which the large-font case
// puts its text size back to.
export async function runVisualNativeCase(
  run: NativeRun,
  testCase: E2ECase,
  found: DeviceLook,
): Promise<void> {
  // False on a wide iOS run, which cannot cross the share sheet at all
  // (visual-catalog.ts, IOS_SHARE_CHECKPOINTS): its steps are left out, and the
  // share case, all of whose checkpoints are inside it, does not run.
  const shareReachable = capturedAt('share-editor', run.platform, run.width);
  if (testCase.id === 'VISUAL-SHARE-001' && !shareReachable) {
    console.log(
      `${testCase.id}: skipped on a wide iOS run — the iPad’s share sheet and ` +
        'extension are not in the tree (visual-catalog.ts, IOS_SHARE_CHECKPOINTS)',
    );
    return;
  }
  const caseDir = join(run.runDir, 'cases', testCase.id);
  const library = await writeVisualLibrary(join(caseDir, 'fixture', 'visual.zip'));
  const plus = testCase.id === 'VISUAL-LOCK-001';
  const account = await provisionAccount(`${run.runId}-${testCase.id}`, {
    prepare: async (app) => {
      if (plus) {
        // Imported before the device signs in, so its first pull is the library.
        await grantPlusAndLoad(app.page, app.credentials.username);
        await importArchive(app.page, library.archivePath);
        await waitForSync(app.page);
      }
    },
  });
  const credentials: Credentials = { username: account.username, password: account.password };
  const shot = (id: string) => checkpoint(id, run.runDir, account.username);
  const source = shareSource(run.platform);
  const env: Record<string, string> = {
    USERNAME: account.username,
    PASSWORD: account.password,
    ...libraryEnv(library),
    SHARE_SOURCE_TEXT: '.*status.*ok.*',
  };
  const openShare = async () => {
    await openSystemShare({
      platform: run.platform,
      deviceId: run.deviceId,
      sourceUrl: source.url,
      title: source.title,
    });
    return null;
  };
  const shareEditor: CaseStep = {
    flow: 'mobile/flows/parts/visual-share-open.yaml',
    env: { SHARE_STATE_ID: 'share-add' },
  };

  const cleanup: Array<() => Promise<void>> = [];
  let steps: CaseStep[];

  if (testCase.id === 'VISUAL-APP-001') {
    steps = [
      testCase.path,
      shot('signed-out'),
      'mobile/flows/parts/visual-signed-in.yaml',
      shot('empty'),
      async () => {
        await importFromWeb(
          `${run.runId}-${testCase.id}-importer`,
          credentials,
          library.archivePath,
        );
        return null;
      },
      'mobile/flows/parts/visual-pulled.yaml',
      shot('populated-list'),
      { flow: 'mobile/flows/parts/visual-layout.yaml', env: { LAYOUT: 'Card' } },
      shot('populated-cards'),
      { flow: 'mobile/flows/parts/visual-layout.yaml', env: { LAYOUT: 'List' } },
      'mobile/flows/parts/visual-search.yaml',
      shot('search'),
      'mobile/flows/parts/visual-search-closed.yaml',
      'mobile/flows/parts/visual-add.yaml',
      shot('add'),
      'mobile/flows/parts/visual-add-cancel.yaml',
      'mobile/flows/parts/visual-edit.yaml',
      shot('edit'),
      'mobile/flows/parts/visual-edit-cancel.yaml',
      'mobile/flows/parts/visual-bulk.yaml',
      shot('bulk-mode'),
      'mobile/flows/parts/visual-bulk-exit.yaml',
      ...SETTINGS_SECTIONS.flatMap((section): CaseStep[] => [
        { flow: 'mobile/flows/parts/visual-settings.yaml', env: { SECTION: section } },
        shot(`settings-${section}`),
      ]),
      'mobile/flows/parts/visual-delete-all.yaml',
      shot('delete-receipt'),
    ];
  } else if (testCase.id === 'VISUAL-LOCK-001') {
    steps = [
      testCase.path,
      'mobile/flows/parts/visual-list-lock-open.yaml',
      // The private list's own ⋯, found on the row whose rename field holds
      // its name — no selector a flow can write reaches it (the part says why).
      async (context) => {
        const root = parseHierarchy(await context.hierarchy());
        const name = boxOf(onlyNode(root, 'List name', library.privateList, 'private list'));
        const actions = sameRow(root, name, 'List actions', 'private list actions');
        return writeTapFlow(context, 'private-list-actions', centerOf(actions));
      },
      'mobile/flows/parts/visual-list-lock.yaml',
      shot('list-lock'),
      'mobile/flows/parts/visual-app-lock-dialog.yaml',
      shot('app-lock-dialog'),
      'mobile/flows/parts/visual-app-lock-gate.yaml',
      shot('app-lock'),
    ];
  } else if (testCase.id === 'VISUAL-SHARE-001') {
    steps = [
      testCase.path,
      openShare,
      shareEditor,
      shot('share-editor'),
      'mobile/flows/parts/visual-share-close.yaml',
      async () => {
        // The same no-link source SHARE-BOUNDARY-001 uses: a page that shares
        // plain text on iOS, the text itself as an ACTION_SEND on Android.
        let sourceUrl = source.url;
        if (run.platform === 'ios') {
          const plain = await startPlainTextShareSource();
          cleanup.push(plain.close);
          sourceUrl = plain.url;
        }
        await openSystemShare({
          platform: run.platform,
          deviceId: run.deviceId,
          sourceUrl,
          sharedText: 'Plain text without a link',
          title: 'Plain text fixture',
        });
        return null;
      },
      'mobile/flows/parts/visual-share-no-url.yaml',
      shot('share-no-url'),
      'mobile/flows/parts/visual-share-no-url-close.yaml',
    ];
  } else if (testCase.id === 'VISUAL-FONT-001') {
    // Raised before the case's cold launch and put back after it, whatever
    // happens: on Android the write recreates the activity, so it cannot happen
    // mid-flow — and every write is a configuration change the frozen status
    // bar has to be re-entered after (runner/status-bar.ts).
    const catalog = readVisualCatalog();
    const large =
      run.platform === 'ios'
        ? catalog.profiles.ios.largeContentSize
        : catalog.profiles.android.largeFontScale;
    await setTextSize(run.platform, run.deviceId, large);
    await freezeStatusBar(run.platform, run.deviceId);
    cleanup.push(async () => {
      await setTextSize(run.platform, run.deviceId, found.textSize);
      await freezeStatusBar(run.platform, run.deviceId);
    });
    steps = [
      testCase.path,
      shot('large-font-sign-in'),
      'mobile/flows/parts/visual-font-signed-in.yaml',
      'mobile/flows/parts/visual-add.yaml',
      shot('large-font-add'),
      'mobile/flows/parts/visual-add-save.yaml',
      'mobile/flows/parts/visual-edit.yaml',
      shot('large-font-edit'),
      'mobile/flows/parts/visual-edit-cancel.yaml',
      'mobile/flows/parts/visual-paywall.yaml',
      shot('large-font-dialog'),
      'mobile/flows/parts/visual-paywall-dismiss.yaml',
      // The surfaces with the most fixed-height controls — tab strips, table
      // rows, checklists — photographed with the library in them. It lands
      // HERE, after the four above, so their baselines never saw it; the share
      // sheet below opens over the last of these sections (About), which is
      // its backdrop now, not the links page it once had. The
      // budget arithmetic itself is a spec (bracemark-expo's
      // components/ui/line-budget.spec.tsx); these catch what arithmetic can't.
      async () => {
        await importFromWeb(
          `${run.runId}-${testCase.id}-importer`,
          credentials,
          library.archivePath,
        );
        return null;
      },
      'mobile/flows/parts/visual-pulled.yaml',
      'mobile/flows/parts/visual-advanced-search.yaml',
      shot('large-font-advanced-search'),
      'mobile/flows/parts/visual-advanced-search-close.yaml',
      ...SETTINGS_SECTIONS.flatMap((section): CaseStep[] => [
        { flow: 'mobile/flows/parts/visual-settings.yaml', env: { SECTION: section } },
        shot(`large-font-settings-${section}`),
      ]),
      ...(shareReachable
        ? [
            openShare,
            shareEditor,
            shot('large-font-share'),
            'mobile/flows/parts/visual-share-close.yaml',
          ]
        : []),
    ];
  } else {
    throw new Error(`no visual runner owns ${testCase.id}`);
  }

  // iOS stamps "◀ Safari" into the status bar of an app opened while Safari is
  // in front, and the frozen status bar does not cover it. The share cases end
  // in Safari, so the next cold launch — the following case's, or the next
  // run's first — would photograph the breadcrumb. Launched from SpringBoard it
  // is never drawn. Exits non-zero when Safari is not running.
  if (run.platform === 'ios') {
    await capture('xcrun', ['simctl', 'terminate', run.deviceId, 'com.apple.mobilesafari'], {
      allowFailure: true,
    });
  }

  try {
    await run.runCase(testCase, env, [account.password], steps);
  } finally {
    for (const undo of cleanup.reverse()) await undo();
  }
}
