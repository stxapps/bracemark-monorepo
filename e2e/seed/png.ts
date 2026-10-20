import { crc32, deflateSync } from 'node:zlib';

// The preview-image bytes a seeded extraction points at — a tiny generated PNG,
// one per image, deterministic in its index.
//
// Why generate them at all, rather than seeding links with no image: an
// `extractions/{id}.enc` with an `imageId` is the only thing that puts a `files/`
// blob in the archive, and `files/` is half of what the backup format does
// (`referencedFileIds`, the "and N files" half of the import receipt, the lazy
// per-row fetch on scroll). A seed with no images leaves the card layout a wall
// of monograms and never exercises the content path at all.
//
// Why hand-rolled rather than a checked-in fixture image: 300-odd distinguishable
// bytes beat one PNG repeated 300 times (you can see WHICH row you scrolled to),
// and a binary blob in a repo whose whole seed is a generator would be the one
// piece nobody can regenerate.
//
// This is a deliberately minimal encoder — 8-bit truecolor (with or without
// alpha), one IDAT, filter 0 on every scanline. It is not a general PNG library
// and should never grow into one: if a seed ever needs real photographic
// previews, that is a fixture-file decision, not more code here.

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SIZE = 64;

// One PNG chunk: length, type, data, CRC over type+data.
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, out.length - 4);
  return out;
}

// The shape of an image the everyday seed never makes — what the worst-case
// library (./worst.ts) asks for: a panorama or a tall strip where the layout
// expects a 64×40 slot, and a logo that is mostly transparent, which is
// invisible on whichever theme its one colour matches.
export interface PreviewShape {
  width?: number;
  height?: number;
  // RGBA, with everything outside the band fully transparent.
  transparent?: boolean;
}

// A flat-ish two-tone tile: a band of one colour over a wash of another, angled so
// the two are never confusable at thumbnail size. `index` picks the hue pair, so
// consecutive links in a card grid read as distinct swatches rather than one
// repeated square.
export function previewPng(index: number, shape: PreviewShape = {}): Uint8Array {
  const { width = SIZE, height = SIZE, transparent = false } = shape;
  const channels = transparent ? 4 : 3;
  const hue = (index * 47) % 360;
  const [r1, g1, b1] = hsvToRgb(hue, 0.55, 0.86);
  const [r2, g2, b2] = hsvToRgb((hue + 28) % 360, 0.7, 0.42);

  // Raw scanlines: a leading filter byte (0 = None) then RGB(A) pixels.
  const stride = 1 + width * channels;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const band = (x + y * 2) % 96 < 34;
      const at = row + 1 + x * channels;
      raw[at] = band ? r2 : r1;
      raw[at + 1] = band ? g2 : g1;
      raw[at + 2] = band ? b2 : b1;
      if (transparent) raw[at + 3] = band ? 255 : 0;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = transparent ? 6 : 2; // colour type: truecolour with alpha (RGBA) or without (RGB)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (we only ever use 0/None per row)
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
