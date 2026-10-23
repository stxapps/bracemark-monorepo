// The two window widths a native run is made at (docs/e2e.md, _narrow and
// wide_). bracemark-expo changes shape at ONE window width and asks nothing else
// about the device — below it the rails are drawers, at or above it they dock
// (docs/safe-area.md, _wide windows on native_) — so a native run is made on a
// device that sits wholly on one side of that line, and a case says which sides
// it has been written for (`widths` in cases.json).
//
// A device's width is its UPRIGHT width, the short side: the one every
// orientation keeps at least. A phone is narrow (a Pixel 8 is 411dp, an iPhone
// 17 Pro 402pt), a tablet is wide in both orientations (the tablet AVD is 800dp,
// an iPad (A16) 820pt). The iPad mini (744pt) is narrow, which is why the class
// is read from the screen rather than from the product family: an "iPad" run on
// one would photograph drawers and call them rails.

export type E2EWidth = 'narrow' | 'wide';

export const E2E_WIDTHS: E2EWidth[] = ['narrow', 'wide'];

// bracemark-expo's `WIDE_MIN_WIDTH` (src/lib/window-class.ts), repeated rather
// than imported: e2e drives the app and never imports it. Keep the two in step.
export const WIDE_MIN_WIDTH = 768;

// What to boot for each width, for the messages that say none is up.
export const WIDTH_DEVICES = {
  ios: { narrow: 'an iPhone', wide: 'an iPad 768pt or wider upright (not the iPad mini)' },
  android: { narrow: 'the bracemark-pixel8 AVD', wide: 'the bracemark-tablet AVD' },
} as const;

export function widthOf(shortSide: number): E2EWidth {
  return shortSide >= WIDE_MIN_WIDTH ? 'wide' : 'narrow';
}

// `adb shell wm size` / `wm density`: a `Physical` line, and an `Override` line
// when something has set one — the override is what the app is laid out in.
function wmValue(output: string, pattern: RegExp, what: string): string {
  const physical = new RegExp(`Physical ${pattern.source}`).exec(output)?.[1];
  const override = new RegExp(`Override ${pattern.source}`).exec(output)?.[1];
  const value = override ?? physical;
  if (!value) throw new Error(`unreadable \`wm ${what}\` output: ${output.trim()}`);
  return value;
}

// The display's size in pixels, natural orientation first, as the app has it.
export function wmSize(output: string): [number, number] {
  const [width, height] = wmValue(output, /size: (\d+x\d+)/, 'size')
    .split('x')
    .map(Number);
  return [width, height];
}

export function wmDensity(output: string): number {
  return Number(wmValue(output, /density: (\d+)/, 'density'));
}

// The short side in dp, from the two `wm` outputs.
export function androidShortSide(sizeOutput: string, densityOutput: string): number {
  return Math.round((Math.min(...wmSize(sizeOutput)) * 160) / wmDensity(densityOutput));
}

// The short side in points, from a simulator device type's profile.plist.
export function iosShortSide(profile: {
  mainScreenWidth: number;
  mainScreenHeight: number;
  mainScreenScale: number;
}): number {
  return Math.round(
    Math.min(profile.mainScreenWidth, profile.mainScreenHeight) / profile.mainScreenScale,
  );
}
