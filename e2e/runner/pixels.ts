import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

import { type NativePlatform } from './cli';
import { type Box } from './hierarchy';
import { capture } from './process';

// What the device actually PAINTED, for the viewport claims a selector cannot
// make (docs/e2e.md, _gestures and waits the runner performs_). A node in the
// accessibility tree has bounds whether or not anything was drawn in them — a
// recycled FlashList cell that lost its content is still "visible" — so the
// painted half of a claim is read off a device screenshot.
//
// The decoder is deliberately minimal, the twin of seed/png.ts's encoder: 8-bit
// RGB or RGBA, non-interlaced, which is what `simctl io screenshot` and
// `screencap -p` write. It is not a general PNG library and should not become one.

export interface Raster {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}

export function decodePng(bytes: Uint8Array): Raster {
  const buffer = Buffer.from(bytes);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(
          `unsupported PNG: depth ${depth}, color ${colorType}, interlace ${interlace}`,
        );
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

async function androidScreencap(deviceId: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('adb', ['-s', deviceId, 'exec-out', 'screencap', '-p']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`adb screencap exited ${code}`));
    });
  });
}

// A screenshot of the device as it is now, written to `path` and decoded.
export async function screenshot(
  platform: NativePlatform,
  deviceId: string,
  path: string,
): Promise<Raster> {
  if (platform === 'ios') {
    await capture('xcrun', ['simctl', 'io', deviceId, 'screenshot', '--type=png', path]);
    return decodePng(await readFile(path));
  }
  const bytes = await androidScreencap(deviceId);
  await writeFile(path, bytes);
  return decodePng(bytes);
}

// The share of `box` (in the hierarchy's units — points on iOS, pixels on
// Android) painted away from its own dominant colour. A cell that drew its row
// has text and a thumbnail in it; an empty one is one flat colour.
//
// `screenWidth` is the hierarchy's width in the same units as `box`, which is
// what scales it onto the raster (3x on the iPhone 17 Pro simulator, 1x on the
// AVD, where both are already pixels).
export function inkShare(raster: Raster, box: Box, screenWidth: number): number {
  const scale = raster.width / screenWidth;
  const left = Math.max(0, Math.floor(box.left * scale));
  const right = Math.min(raster.width, Math.ceil(box.right * scale));
  const top = Math.max(0, Math.floor(box.top * scale));
  const bottom = Math.min(raster.height, Math.ceil(box.bottom * scale));
  const luma = (x: number, y: number) => {
    const i = (y * raster.width + x) * raster.channels;
    return (
      (raster.pixels[i] * 299 + raster.pixels[i + 1] * 587 + raster.pixels[i + 2] * 114) / 1000
    );
  };
  const histogram = new Map<number, number>();
  const samples: number[] = [];
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const value = Math.round(luma(x, y));
      samples.push(value);
      histogram.set(value, (histogram.get(value) ?? 0) + 1);
    }
  }
  if (samples.length === 0) return 0;
  const [background] = [...histogram.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
  return samples.filter((value) => Math.abs(value - background) > 40).length / samples.length;
}
