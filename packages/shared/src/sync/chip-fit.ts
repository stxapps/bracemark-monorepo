// How many tag chips fit a strip of a given width, over up to `maxLines` lines —
// ESTIMATED from the names' lengths, not measured. The one home of the arithmetic
// both apps lean on (docs/link-layouts.md, _heights_):
//
//   - bracemark-expo RENDERS from it. React Native has no synchronous pre-paint
//     measure, so its strip packs chips into lines from this estimate and draws each
//     line as its own single-line row. A wrong estimate then truncates a chip
//     (they're `shrink` with one line of text) instead of wrapping onto a line
//     nothing budgeted — so the strip's height is exactly what this says, and is
//     known at the strip's first render whenever its width is.
//   - bracemark-web ESTIMATES from it. Web measures the real chips before paint
//     (its LinkTagChips), so this only picks the virtualizer's height guess for a
//     row not yet mounted.
//
// The numbers are rounded AGAINST fitting: overestimate a chip and the strip shows
// one fewer than it could; underestimate and the overflow lands as truncation.

export interface ChipMetrics {
  // Both sides' padding — in dp/px, so it does NOT scale with the text size.
  padding: number;
  // The gap between chips, both axes.
  gap: number;
  // The cap a long label's chip can reach (`max-w-32`).
  maxWidth: number;
  // The average advance of one character at the chip's text size and a scale of 1.
  charWidth: number;
  // The "+N" chip at a realistic widest N ("+12").
  moreWidth: number;
  // A ceiling per line on top of the width fit (bracemark-expo caps a line at five:
  // past that, tags compete with the title they annotate). Infinity for none.
  maxPerLine: number;
}

// The chip both apps draw: `px-2` (8+8), `gap-1`, `max-w-32`, text-xs (12) —
// web's `TAG_CHIP_CLASS` and expo's `TAG_CHIP_CLASS`. 6.6 is ~6.2 rounded up.
export const TAG_CHIP_METRICS: ChipMetrics = {
  padding: 16,
  gap: 4,
  maxWidth: 128,
  charWidth: 6.6,
  moreWidth: 38,
  maxPerLine: 5,
};

// One line of the strip is the chip's 24 tall; lines sit a `gap` apart.
export const TAG_CHIP_LINE_HEIGHT = 24;

// A label's width in average Latin advances. An East Asian wide character or an
// emoji is about TWO — counting either as one is what packed `a`, `⭐`, `読む` and
// `مهم` onto one small-card line where they then shrank to ".." (break-ui, the
// Pixel 8 AVD). By code point, not UTF-16 unit, so a surrogate pair counts once;
// a ZWJ sequence still counts per part, which only ever errs wide — the safe side.
// Explicit ranges rather than `\p{Extended_Pictographic}`: Hermes's support for
// Unicode property escapes is not something to bet a layout on.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u2600-\u27BF\u2B00-\u2BFF]|[\u{1F000}-\u{1FAFF}]/u;
export function advanceUnits(name: string): number {
  let units = 0;
  for (const ch of name) units += WIDE.test(ch) ? 2 : 1;
  return units;
}

export interface ChipFit {
  // How many chips each line holds, in order. Never empty for a non-empty input.
  lines: number[];
  // How many chips go behind "+N" (0: none, and no "+N").
  overflow: number;
}

// Pack `names` into at most `maxLines` lines of `width`, mirroring web's measured
// two passes: take chips while they fit, then — only if any are left over — give
// back trailing chips on the LAST line until the "+N" chip fits after them.
//
// Floors at one chip per line, where a strict fit could fall to zero: a line of
// nothing but "+3" says a link has tags without naming one, and the one kept chip is
// `shrink` so it fits whatever is left. And a strip whose width isn't known yet
// (0) keeps one named chip plus "+N" on ONE line — never more lines than it can
// prove room for.
export function fitChips(
  names: readonly string[],
  width: number,
  maxLines: number,
  fontScale = 1,
  metrics: ChipMetrics = TAG_CHIP_METRICS,
): ChipFit {
  const n = names.length;
  if (n === 0) return { lines: [], overflow: 0 };
  if (width <= 0) return { lines: [1], overflow: n - 1 };

  const widthOf = (name: string) =>
    Math.min(
      metrics.padding + advanceUnits(name) * metrics.charWidth * fontScale,
      metrics.maxWidth,
    );

  const lines: number[] = [];
  const used: number[] = [];
  let next = 0;
  while (next < n && lines.length < Math.max(1, maxLines)) {
    let lineUsed = 0;
    let count = 0;
    while (next < n && count < metrics.maxPerLine) {
      const cost = (count === 0 ? 0 : metrics.gap) + widthOf(names[next]);
      if (count > 0 && lineUsed + cost > width) break;
      lineUsed += cost;
      count += 1;
      next += 1;
    }
    lines.push(count);
    used.push(lineUsed);
  }

  const last = lines.length - 1;
  while (next < n && lines[last] > 1 && used[last] + metrics.gap + metrics.moreWidth > width) {
    next -= 1;
    lines[last] -= 1;
    used[last] -= widthOf(names[next]) + metrics.gap;
  }
  return { lines, overflow: n - next };
}

// The strip's height for a fit: its lines, a gap apart.
export function chipStripHeight(fit: ChipFit, metrics: ChipMetrics = TAG_CHIP_METRICS): number {
  const lines = fit.lines.length;
  return lines === 0 ? 0 : lines * TAG_CHIP_LINE_HEIGHT + (lines - 1) * metrics.gap;
}
