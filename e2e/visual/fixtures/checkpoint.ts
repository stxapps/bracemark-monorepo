import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { runArtifactDir } from '../../paths';
import {
  type Appearance,
  captureKey,
  checkpointById,
  type MaskKind,
  readVisualCatalog,
  type WebLayout,
} from '../../runner/visual-catalog';
import { capturesDir } from '../../runner/visual-compare';

// Photograph one named checkpoint (e2e/visual.json) in every appearance it
// lists, at this project's layout, into the run's captures — docs/e2e.md,
// _visual checkpoints_. The spec drives the app to the state; this only looks.
//
// The appearance is the SYSTEM's (`prefers-color-scheme`): a fresh account's
// theme is `system`, so the app follows the emulated media the way it follows a
// person's OS setting (docs/theme.md). The `.dark` class on <html> is the
// settled signal that it did.

// Consecutive identical frames that count as settled, and the most frames a
// checkpoint may take to get there. `animations: 'disabled'` already
// fast-forwards CSS transitions; what is left is data arriving and layout.
const STABLE_FRAMES = 2;
const MAX_FRAMES = 12;

export interface CheckpointContext {
  // The run's throwaway username, for the `username` mask.
  username?: string;
}

export function layoutOf(): WebLayout {
  const name = test.info().project.name;
  if (name !== 'wide' && name !== 'narrow') {
    throw new Error(`visual project must be "wide" or "narrow", got ${name}`);
  }
  return name;
}

// Size the page for this project's layout. Called once, before the first
// navigation, so every surface is opened the way a person at that width opens
// it — the add surface is a popover when wide and a sheet when narrow, and a
// resize with it open would photograph something nobody sees.
export async function useLayout(page: Page): Promise<void> {
  await page.setViewportSize(readVisualCatalog().profiles.web.layouts[layoutOf()]);
}

function masksFor(page: Page, kinds: MaskKind[], context: CheckpointContext): Locator[] {
  return kinds.flatMap((kind) => {
    switch (kind) {
      case 'relative-time':
        return [page.locator('main time')];
      case 'username':
        if (!context.username) throw new Error('the username mask needs the username');
        return [page.getByText(context.username, { exact: true })];
      case 'sync-time':
        return [page.getByText(/^Last synced/)];
      case 'keyboard':
        return [];
    }
  });
}

async function settledScreenshot(page: Page, mask: Locator[]): Promise<Buffer> {
  let previous: Buffer | undefined;
  let same = 0;
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const shot = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      mask,
      maskColor: '#FF00FF',
    });
    same = previous && shot.equals(previous) ? same + 1 : 0;
    if (same >= STABLE_FRAMES - 1) return shot;
    previous = shot;
  }
  throw new Error(`the page never held still for ${STABLE_FRAMES} frames`);
}

async function applyAppearance(page: Page, appearance: Appearance): Promise<void> {
  await page.emulateMedia({ colorScheme: appearance });
  const html = page.locator('html');
  if (appearance === 'dark') await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

export async function checkpoint(
  page: Page,
  id: string,
  context: CheckpointContext = {},
): Promise<void> {
  const entry = checkpointById(id);
  if (!entry.platforms.includes('web')) throw new Error(`${id} is not a web checkpoint`);
  const layout = layoutOf();
  const runId = process.env.E2E_RUN_ID;
  if (!runId) throw new Error('E2E_RUN_ID is unset; run through runner/visual.ts');
  const dir = capturesDir(process.env.E2E_RUN_DIR ?? runArtifactDir(runId));
  await mkdir(dir, { recursive: true });

  await test.step(`checkpoint ${id} (${layout})`, async () => {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const appearance of entry.appearances) {
      await applyAppearance(page, appearance);
      const shot = await settledScreenshot(page, masksFor(page, entry.masks, context));
      await writeFile(join(dir, `${captureKey(id, { layout, appearance })}.png`), shot);
    }
    await applyAppearance(page, 'light');
  });
}
