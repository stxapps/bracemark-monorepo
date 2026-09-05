// Fails when a committed picture no longer agrees with the constants it was drawn
// from.
//
//   npm run check:assets
//   npx tsx tools/scripts/check-assets.ts --print-inputs   # the inputs, as JSON
//
// WHY THIS EXISTS. Six PNGs in this repo are read by a build — the social card in
// both apps, and the PWA screenshots `manifest.json` lists — and every one of them
// carried the PREDECESSOR's branding for the product's whole life: the wrong
// tagline, the wrong mark, an encryption claim we no longer make, and eleven
// third-party wordmarks. Nothing caught it, because a picture has nothing to lint.
// No type error, no test, no failing build, and a wrong one renders exactly as
// well as a right one (docs/brand-assets.md, _the generated pictures_).
//
// So each picture is stamped with the strings and tokens it was drawn from, and
// this recomputes those from the live constants and diffs them. A tagline edit now
// fails here instead of shipping.
//
// IT COMPARES INPUTS, NOT PIXELS, and that is the design rather than a shortcut.
// Re-rendering the same geometry does not reproduce the same bytes — a different
// rasteriser differs by up to ~26% alpha on edge pixels alone (brand-assets.md,
// _the mark_) — so a picture-to-picture comparison would fail on every legitimate
// regeneration and tell you nothing. The inputs are exact, and they are the half
// that goes wrong silently.
//
// The file hash IS checked, but for the other direction: it catches a picture
// swapped or hand-edited without re-stamping, which is the same drift arriving
// from the other side.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND } from '@stxapps/shared';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAMP = 'assets.stamp.json';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// --- the inputs ------------------------------------------------------------
// Everything a committed picture is allowed to depend on, resolved from the one
// place each fact actually lives. A picture that depends on something NOT in here
// is a picture this check cannot protect — add the fact rather than the picture.

/**
 * The mark's path, by regex rather than by import, because the module is a `.tsx`
 * React component and this script has no renderer. The same reading the icon PNGs
 * were rendered from; `d` is unique in that file.
 */
function iconPath(): string {
  const source = read('packages/web-ui/src/components/icons/bracemark-icon.tsx');
  const match = source.match(/\sd="([^"]+)"/);
  if (!match) throw new Error('no `d` in bracemark-icon.tsx — did the mark stop being one path?');
  return match[1];
}

/**
 * A custom property's value, read out of ONE named block. The block matters: both
 * `--foreground` and `--muted-foreground` are declared twice in web-ui's sheet, in
 * `:root` and again in `.dark`, and a card has no theme to follow — it is always
 * the light one. A regex over the whole file would take whichever came first and
 * be right by luck.
 */
function token(file: string, block: string, name: string): string {
  const source = read(file);
  const start = source.indexOf(`${block} {`);
  if (start === -1) throw new Error(`no \`${block}\` block in ${file}`);
  const end = source.indexOf('\n}', start);
  const match = source.slice(start, end).match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`no \`${name}\` in ${block} of ${file}`);
  return match[1].trim();
}

interface ManifestScreenshot {
  src: string;
  sizes: string;
  form_factor?: string;
}

function manifest(): { screenshots: ManifestScreenshot[] } {
  return JSON.parse(read('apps/bracemark-web/src/app/manifest.json'));
}

function collectInputs(): Record<string, string> {
  const ui = 'packages/web-ui/src/styles.css';
  const site = 'apps/bracemark-site/src/app/globals.css';
  return {
    'brand.name': BRAND.name,
    'brand.descriptor': BRAND.descriptor,
    'brand.tagline': BRAND.tagline,
    'brand.slogan': BRAND.slogan,
    'brand.subtitle': BRAND.subtitle,
    'icon.d': iconPath(),
    'token.foreground': token(ui, ':root', '--foreground'),
    'token.mutedForeground': token(ui, ':root', '--muted-foreground'),
    'token.border': token(ui, ':root', '--border'),
    'token.signal': token(site, '@theme', '--color-signal'),
  };
}

// --- the checks ------------------------------------------------------------

interface StampedAsset {
  /** `WIDTHxHEIGHT`, checked against the file's own IHDR. */
  pixels: string;
  sha256: string;
  /**
   * The values this picture was drawn from, PER ASSET rather than one snapshot for
   * the whole file. That matters: pictures are regenerated a few at a time, and a
   * single shared snapshot would be rewritten by whichever one ran last — blessing
   * every picture that had NOT been redrawn with inputs it has never seen. The
   * repetition is the point.
   */
  inputs: Record<string, string>;
  /** Present only while the committed file is known to be wrong. */
  stale?: string;
  /** Free-form: which design/variant is committed, for a picture that has more than one. */
  variant?: string;
}

interface Stamp {
  assets: Record<string, StampedAsset>;
}

/** Width and height straight out of the PNG header — no decoder, no dependency. */
function pngPixels(buffer: Buffer): string {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

const failures: string[] = [];
const fail = (file: string, message: string) => failures.push(`${file}\n    ${message}`);

function main(): void {
  const live = collectInputs();

  if (process.argv.includes('--print-inputs')) {
    console.log(JSON.stringify(live, null, 2));
    return;
  }

  const stamp: Stamp = JSON.parse(read(STAMP));

  for (const [file, asset] of Object.entries(stamp.assets)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(REPO_ROOT, file));
    } catch {
      fail(file, 'stamped but missing from the tree');
      continue;
    }

    if (asset.stale) {
      fail(file, `KNOWN STALE — ${asset.stale}\n    Regenerate it, then drop \`stale\` here.`);
      continue;
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== asset.sha256) {
      fail(file, `the file changed without a re-stamp (sha256 ${sha256.slice(0, 12)}…)`);
    }

    const pixels = pngPixels(bytes);
    if (pixels !== asset.pixels) {
      fail(file, `is ${pixels}; the stamp says ${asset.pixels}`);
    }

    for (const [key, was] of Object.entries(asset.inputs)) {
      if (live[key] === undefined) {
        fail(file, `was drawn from \`${key}\`, which no longer exists`);
      } else if (was !== live[key]) {
        fail(
          file,
          `was drawn from ${key} = ${JSON.stringify(was)}\n` +
            `    which now reads ${JSON.stringify(live[key])}`,
        );
      }
    }
  }

  // The alt text is the one thing beside a card that is TEXT, so it is checked
  // exactly rather than stamped: it is defined as the name and the tagline, and a
  // sidecar is the easiest file in this repo to forget when the tagline moves.
  const alt = `${BRAND.name} — ${BRAND.tagline}`;
  for (const file of Object.keys(stamp.assets).filter((f) => f.includes('/src/app/'))) {
    const sidecar = file.replace(/\.png$/, '.alt.txt');
    let text: string;
    try {
      text = read(sidecar);
    } catch {
      fail(sidecar, 'missing — a static card gets its alt text from this sidecar or none at all');
      continue;
    }
    if (text.trim() !== alt) {
      fail(sidecar, `reads ${JSON.stringify(text.trim())}\n    expected ${JSON.stringify(alt)}`);
    }
  }

  // Both directions between manifest.json and the files on disk. The second one is
  // not hypothetical: two v1 screenshots sat in `public/` referenced by nothing,
  // deploying 2MB per release for no reader, which no build step could notice
  // because an unreferenced file is not an error anywhere.
  const declared = manifest().screenshots;
  for (const shot of declared) {
    const file = `apps/bracemark-web/public/${shot.src}`;
    if (!stamp.assets[file]) {
      fail(file, 'listed in manifest.json but not stamped');
      continue;
    }
    if (stamp.assets[file].pixels !== shot.sizes) {
      fail(
        file,
        `manifest.json declares ${shot.sizes}; the stamp says ${stamp.assets[file].pixels}`,
      );
    }
  }
  // The three rules Chrome applies to `screenshots`, none of which it reports:
  // a set that breaks one is dropped from the install dialog and the dialog still
  // opens, so the symptom is a picture that simply is not there. They are checked
  // against what the MANIFEST declares rather than the files, because the manifest
  // is what Chrome reads — and the row above has already tied the two together.
  //
  //   320 <= every dimension <= 3840
  //   the long side is at most 2.3x the short side
  //   every screenshot of one form factor shares one aspect ratio
  //
  // The last is the one that bites: capture three narrow shots at one viewport and
  // a fourth at another, and the set is inconsistent. The ceiling is the one to
  // watch when picking a phone — a 20:9 screen is 2.22 and a 21:9 is 2.33, which
  // is over.
  const ratios = new Map<string, { first: string; ratio: number }>();
  for (const shot of declared) {
    const [width, height] = shot.sizes.split('x').map(Number);
    if (!width || !height) {
      fail(`apps/bracemark-web/public/${shot.src}`, `manifest sizes \`${shot.sizes}\` is not WxH`);
      continue;
    }
    const file = `apps/bracemark-web/public/${shot.src}`;

    if (Math.min(width, height) < 320 || Math.max(width, height) > 3840) {
      fail(file, `${shot.sizes} is outside Chrome's 320–3840 bounds`);
    }

    const ratio = Math.max(width, height) / Math.min(width, height);
    if (ratio > 2.3) {
      fail(file, `${shot.sizes} is ${ratio.toFixed(3)}:1 — Chrome's ceiling is 2.3`);
    }

    const factor = shot.form_factor ?? '(none)';
    const seen = ratios.get(factor);
    if (!seen) {
      ratios.set(factor, { first: shot.src, ratio });
    } else if (Math.abs(seen.ratio - ratio) > 0.005) {
      fail(
        file,
        `is ${ratio.toFixed(3)}:1 but \`${seen.first}\` is ${seen.ratio.toFixed(3)}:1 — every ` +
          `\`${factor}\` screenshot must share one aspect ratio`,
      );
    }
  }

  const referenced = new Set(declared.map((shot) => shot.src));
  for (const file of Object.keys(stamp.assets)) {
    const name = path.basename(file);
    if (file.startsWith('apps/bracemark-web/public/') && !referenced.has(name)) {
      fail(file, 'committed and stamped, but manifest.json lists no such screenshot');
    }
  }

  if (failures.length === 0) {
    const count = Object.keys(stamp.assets).length;
    console.log(
      `ok — ${count} committed pictures still agree with the constants they were drawn from`,
    );
    return;
  }

  console.error(`BLOCKED: ${failures.length} committed picture(s) no longer match the repo.\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error('Regenerate the affected pictures, then update assets.stamp.json.');
  console.error('docs/brand-assets.md, _the generated pictures_, has the contract.');
  process.exit(1);
}

main();
