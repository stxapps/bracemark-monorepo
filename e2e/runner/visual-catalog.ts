import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { E2E_ROOT } from '../paths';
import type { E2ECase } from './registry';
import type { E2EWidth } from './width';

// The named visual checkpoints (e2e/visual.json) and the captures each one
// owes a run (docs/e2e.md, _visual checkpoints_). Like cases.json it organizes
// execution and never supplies an expectation: what a checkpoint must LOOK like
// is only ever the accepted baseline, never something this file says.

export type VisualPlatform = 'web' | 'ios' | 'android';
export type Appearance = 'light' | 'dark';
export type WebLayout = 'wide' | 'narrow';
export type MaskKind = 'relative-time' | 'username' | 'sync-time' | 'keyboard';

export const WEB_LAYOUTS: WebLayout[] = ['wide', 'narrow'];

export interface VisualCheckpoint {
  id: string;
  title: string;
  // The registry case that captures it, on every platform listed.
  case: string;
  platforms: VisualPlatform[];
  appearances: Appearance[];
  // Captured with the device's text size raised (VISUAL-004); native only.
  fontScale?: 'large';
  masks: MaskKind[];
  // A blocking comparison rather than review-only. Only with an owner, and only
  // after the history shows the capture is deterministic (VISUAL-006).
  gate: boolean;
  owner?: string;
}

export interface VisualCatalog {
  profiles: {
    web: { layouts: Record<WebLayout, { width: number; height: number }> };
    ios: { largeContentSize: string };
    android: { largeFontScale: string };
  };
  masks: Record<MaskKind, string>;
  comparison: {
    // Per-channel difference, 0–255, below which two pixels are the same.
    channelTolerance: number;
    // Share of differing pixels above which a capture has changed.
    changedRatio: number;
    // Consecutive same-as-baseline runs the report calls enough to promote.
    promotionStreak: number;
  };
  checkpoints: VisualCheckpoint[];
}

export interface CaptureVariant {
  layout?: WebLayout;
  appearance: Appearance;
}

export interface ExpectedCapture {
  key: string;
  checkpoint: VisualCheckpoint;
  variant: CaptureVariant;
}

const CATALOG_PATH = join(E2E_ROOT, 'visual.json');
const CHECKPOINT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function readVisualCatalog(): VisualCatalog {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as VisualCatalog;
}

export function checkpointById(id: string, catalog = readVisualCatalog()): VisualCheckpoint {
  const found = catalog.checkpoints.find((checkpoint) => checkpoint.id === id);
  if (!found) throw new Error(`unknown visual checkpoint: ${id} (e2e/visual.json)`);
  return found;
}

// One file per checkpoint per variant: `populated-list.narrow.dark` on web,
// `populated-list.dark` on a device.
export function captureKey(id: string, variant: CaptureVariant): string {
  return [id, variant.layout, variant.appearance].filter(Boolean).join('.');
}

// The checkpoints photographed inside the iOS share extension, which no Maestro
// run can reach on an iPad: there the system share sheet is a popover and the
// extension a card that neither shows in the tree — under Safari's app id, the
// extension's, or SpringBoard's — so a flow can neither press Bracemark's row
// nor see that the extension arrived (docs/app-drivers.md, _the iPad
// simulator_). A wide iOS run skips the steps that open them
// (runner/visual-native.ts) and owes none of their captures. The Android
// tablet's share activity is in its tree, and keeps them.
export const IOS_SHARE_CHECKPOINTS = new Set(['share-editor', 'share-no-url', 'large-font-share']);

export function capturedAt(
  checkpointId: string,
  platform: VisualPlatform,
  width: E2EWidth | undefined,
): boolean {
  return !(platform === 'ios' && width === 'wide' && IOS_SHARE_CHECKPOINTS.has(checkpointId));
}

export function expectedCaptures(
  caseIds: string[],
  platform: VisualPlatform,
  catalog = readVisualCatalog(),
  width?: E2EWidth,
): ExpectedCapture[] {
  const layouts: (WebLayout | undefined)[] = platform === 'web' ? WEB_LAYOUTS : [undefined];
  return catalog.checkpoints
    .filter((checkpoint) => caseIds.includes(checkpoint.case))
    .filter((checkpoint) => checkpoint.platforms.includes(platform))
    .filter((checkpoint) => capturedAt(checkpoint.id, platform, width))
    .flatMap((checkpoint) =>
      layouts.flatMap((layout) =>
        checkpoint.appearances.map((appearance) => {
          const variant = { layout, appearance };
          return { key: captureKey(checkpoint.id, variant), checkpoint, variant };
        }),
      ),
    );
}

// Held to the case registry by `npm run check:registry`, which calls this. Every
// checkpoint names a visual case that runs on each of its platforms, and every
// visual case owns at least one checkpoint there — so a checkpoint cannot sit in
// the catalog with nothing to capture it, and a capture cannot be taken for a
// name the catalog does not define (the capture helpers look it up and throw).
export function validateVisualCatalog(cases: E2ECase[], catalog = readVisualCatalog()): void {
  const maskKinds = new Set(Object.keys(catalog.masks));
  const ids = new Set<string>();
  const visualCases = cases.filter((testCase) => testCase.traits.includes('baseline'));

  const caseFor = (id: string, platform: VisualPlatform) =>
    visualCases.find(
      (testCase) =>
        testCase.id === id &&
        (platform === 'web'
          ? testCase.surface === 'web'
          : testCase.surface === 'native' && testCase.traits.includes(platform)),
    );

  for (const checkpoint of catalog.checkpoints) {
    if (!CHECKPOINT_ID.test(checkpoint.id)) {
      throw new Error(`invalid visual checkpoint id: ${checkpoint.id}`);
    }
    if (ids.has(checkpoint.id)) throw new Error(`duplicate visual checkpoint: ${checkpoint.id}`);
    ids.add(checkpoint.id);
    if (checkpoint.platforms.length === 0 || checkpoint.appearances.length === 0) {
      throw new Error(`${checkpoint.id}: needs at least one platform and one appearance`);
    }
    for (const appearance of checkpoint.appearances) {
      if (appearance !== 'light' && appearance !== 'dark') {
        throw new Error(`${checkpoint.id}: invalid appearance ${appearance}`);
      }
    }
    for (const mask of checkpoint.masks) {
      if (!maskKinds.has(mask)) throw new Error(`${checkpoint.id}: unknown mask ${mask}`);
    }
    if (checkpoint.fontScale !== undefined) {
      if (checkpoint.fontScale !== 'large' || checkpoint.platforms.includes('web')) {
        throw new Error(`${checkpoint.id}: fontScale is "large" and native-only`);
      }
    }
    if (checkpoint.gate && !checkpoint.owner?.trim()) {
      throw new Error(`${checkpoint.id}: a gated checkpoint must name its owner`);
    }
    for (const platform of checkpoint.platforms) {
      if (!['web', 'ios', 'android'].includes(platform)) {
        throw new Error(`${checkpoint.id}: invalid platform ${platform}`);
      }
      const testCase = caseFor(checkpoint.case, platform);
      if (!testCase) {
        throw new Error(
          `${checkpoint.id}: no visual ${platform} case ${checkpoint.case} in cases.json`,
        );
      }
    }
  }

  for (const testCase of visualCases) {
    const platforms: VisualPlatform[] =
      testCase.surface === 'web'
        ? ['web']
        : (['ios', 'android'] as const).filter((platform) => testCase.traits.includes(platform));
    for (const platform of platforms) {
      const owned = catalog.checkpoints.some(
        (checkpoint) => checkpoint.case === testCase.id && checkpoint.platforms.includes(platform),
      );
      if (!owned) {
        throw new Error(`${testCase.id}: a visual ${platform} case with no checkpoint to capture`);
      }
    }
  }
}
