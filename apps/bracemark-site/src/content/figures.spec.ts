/**
 * @jest-environment node
 *
 * A figure whose file is missing is a broken image on a published page, and one
 * whose file is the wrong shape is a picture stretched to a box it does not fit.
 * Neither fails anything else: `public/` is copied, never compiled, and the MDX
 * that names a figure is read by no checker.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { entitlementsOf } from '@stxapps/shared';

import {
  type DocFigure,
  type FigureName,
  FIGURES,
  figureStem,
  IMPORT_FIGURE_FREE_LINKS,
} from './figures';

const PUBLIC = join(__dirname, '../../public');
const FIGURE_FILES = readdirSync(join(PUBLIC, 'figures'));

/** Every `.mdx` under content/, as text — docs, posts and drafts alike. */
const MDX_SOURCES = (readdirSync(__dirname, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.mdx'))
  .map((file) => readFileSync(join(__dirname, file), 'utf8'));
const USED = MDX_SOURCES.flatMap((source) =>
  [...source.matchAll(/<Figure\s+name="([^"]*)"/g)].map((match) => match[1]),
);

/**
 * A WebP's width and height out of its header — no decoder, no dependency, the
 * way tools/scripts/check-assets.ts reads a PNG's. Three layouts share the
 * container: lossy (`VP8 `, what make-image-variants.sh writes), lossless
 * (`VP8L`) and extended (`VP8X`, which a capture with an alpha channel becomes).
 */
function webpPixels(buffer: Buffer): { width: number; height: number } {
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP');
  }
  switch (buffer.toString('latin1', 12, 16)) {
    case 'VP8 ':
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    case 'VP8L': {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    default:
      throw new Error('a WebP with no VP8 chunk first');
  }
}

describe('the figures', () => {
  // Both directions. The second is the one a build cannot notice: an
  // unreferenced file is not an error anywhere, it is just bytes deployed to
  // the apex for no reader.
  it('are the files in public/figures, and no others', () => {
    const declared = (Object.keys(FIGURES) as FigureName[]).flatMap((name) =>
      FIGURES[name].widths.map(
        (width) => `${figureStem(name).slice('/figures/'.length)}-${width}.webp`,
      ),
    );
    expect([...FIGURE_FILES].sort()).toEqual(declared.sort());
  });

  it('are each shown on a page, and every page names one that exists', () => {
    expect([...new Set(USED)].sort()).toEqual(Object.keys(FIGURES).sort());
  });

  // The one number a figure prints that the plan table owns. A page gets it
  // from `<FreeLinks />` and moves with the table; a picture does not, so a
  // changed cap would sit in the text above a figure still showing the old one.
  it('show the free plan’s link cap as the plan table has it', () => {
    // Retake `import-over-limit` (e2e/shot/scenes.ts), then move the constant.
    expect(entitlementsOf('free').maxLinks).toBe(IMPORT_FIGURE_FREE_LINKS);
  });
});

describe.each(Object.entries<DocFigure>(FIGURES))('<Figure name="%s" />', (name, figure) => {
  // `width`/`height` reserve the box, so a file of another ratio is drawn
  // squashed into it. One pixel of slack: the ladder is cut from one capture
  // and each rung rounds its own height.
  it.each(figure.widths)('has a %ipx file of the size it reserves', (width) => {
    const pixels = webpPixels(readFileSync(join(PUBLIC, `figures/${name}-${width}.webp`)));
    expect(pixels.width).toBe(width);
    expect(Math.abs(pixels.height - (width * figure.height) / figure.width)).toBeLessThanOrEqual(1);
  });

  // The page never shows a figure wider than `width`, so the first file is the
  // one a 1x screen draws untouched and the rest are that width at a density.
  // Anything else on the ladder is a file no screen is the right size for.
  it('has a ladder of whole densities, 1x first and 2x at least', () => {
    expect(figure.widths[0]).toBe(figure.width);
    expect(figure.widths.length).toBeGreaterThanOrEqual(2);
    expect(figure.widths.map((width) => width / figure.width)).toEqual(
      figure.widths.map((_, index) => index + 1),
    );
  });

  // Not a length budget — the alt text reads the capture back state by state
  // and runs long on purpose. Only that there is one, and that the caption is
  // a sentence rather than a label.
  it('says what it shows', () => {
    expect(figure.alt.trim().length).toBeGreaterThan(40);
    if (figure.caption) expect(figure.caption).toMatch(/\.$/);
  });
});
