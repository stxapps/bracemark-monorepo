/**
 * @jest-environment node
 *
 * A `<video>` whose file is missing is a grey box on a published post, and
 * nothing else says so: `public/` is copied, never compiled.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEMO_CLIP } from './mdx-components';

const ROOT = join(__dirname, '../../../..');
const STAMP: { assets: Record<string, { pixels: string } | undefined> } = JSON.parse(
  readFileSync(join(ROOT, 'assets.stamp.json'), 'utf8'),
);

describe('<DemoClip />', () => {
  // The stamp is the join, not the file: `npm run check:assets` holds each
  // stamped file to the tree and to the strings it was drawn from, so a path
  // that is stamped is a path that exists and is current. A clip renamed in
  // `public/` without this component following it fails here.
  it.each(['src', 'poster'] as const)(
    'plays a stamped file, at the size it reserves — %s',
    (key) => {
      const asset = STAMP.assets[`apps/bracemark-site/public${DEMO_CLIP[key]}`];
      expect(asset?.pixels).toBe(`${DEMO_CLIP.width}x${DEMO_CLIP.height}`);
    },
  );
});
