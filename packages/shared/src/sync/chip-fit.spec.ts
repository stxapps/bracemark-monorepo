// The tag strip's estimated fit. bracemark-expo draws its strip straight from this, so
// a wrong answer is a wrong strip on every phone: a "+N" with no named tag, a line the
// list never budgeted (and so a jump), or more lines than the user's cap.

import { advanceUnits, chipStripHeight, fitChips, TAG_CHIP_METRICS } from './chip-fit';

// 16 + 4 × 6.6 = 42.4 wide each.
const four = (count: number) => Array.from({ length: count }, (_, i) => `tag${i}`);

describe('fitChips', () => {
  it('fits everything on one line when there is room', () => {
    expect(fitChips(four(3), 400, 1)).toEqual({ lines: [3], overflow: 0 });
  });

  // Before the strip knows its width it can prove room for nothing — so one named
  // chip and "+N", on ONE line, whatever the cap.
  it('keeps one named chip on one line while the width is unknown', () => {
    expect(fitChips(four(6), 0, 3)).toEqual({ lines: [1], overflow: 5 });
  });

  it('wraps onto further lines up to the cap, then overflows', () => {
    // 100 wide holds two 42.4 chips (88.8) per line.
    const fit = fitChips(four(7), 100, 2, 1, { ...TAG_CHIP_METRICS, moreWidth: 10 });
    expect(fit.lines.length).toBe(2);
    expect(fit.overflow).toBe(7 - fit.lines.reduce((a, b) => a + b, 0));
    expect(fit.overflow).toBeGreaterThan(0);
  });

  it('makes room for "+N" on the last line only', () => {
    // Two per line; "+N" (38) doesn't fit after two on the last, so one goes.
    expect(fitChips(four(7), 100, 2)).toEqual({ lines: [2, 1], overflow: 4 });
  });

  it('never leaves a line without a named chip', () => {
    expect(fitChips(['a-very-long-tag-name-indeed'], 30, 1)).toEqual({ lines: [1], overflow: 0 });
    expect(fitChips(four(3), 30, 3).lines.every((count) => count >= 1)).toBe(true);
  });

  it('caps a line at the per-line ceiling', () => {
    expect(fitChips(four(8), 10_000, 1).lines).toEqual([5]);
  });

  it('a short strip uses one line at every cap', () => {
    expect(fitChips(four(2), 400, 3).lines).toEqual([2]);
  });

  it('scales the label, not the padding, with the text size', () => {
    expect(fitChips(four(4), 180, 1, 1).lines[0]).toBeGreaterThan(
      fitChips(four(4), 180, 1, 2).lines[0],
    );
  });
});

describe('chipStripHeight', () => {
  it('is 24 per line plus the gaps between', () => {
    expect(chipStripHeight({ lines: [], overflow: 0 })).toBe(0);
    expect(chipStripHeight({ lines: [3], overflow: 0 })).toBe(24);
    expect(chipStripHeight({ lines: [2, 2, 1], overflow: 4 })).toBe(80);
  });
});

describe('advanceUnits', () => {
  // The small-card break: emoji and CJK counted as one Latin letter each.
  it('counts wide characters and emoji as two, Latin and Arabic as one', () => {
    expect(advanceUnits('to-read')).toBe(7);
    expect(advanceUnits('⭐')).toBe(2);
    expect(advanceUnits('読む')).toBe(4);
    expect(advanceUnits('مهم')).toBe(3);
    expect(advanceUnits('🦊 Side')).toBe(7);
  });

  it('fits fewer wide chips on a line than narrow ones of the same length', () => {
    expect(fitChips(['読む読む', 'あとで読む'], 150, 1).lines[0]).toBeLessThan(
      fitChips(['abcd', 'abcde'], 150, 1).lines[0],
    );
  });
});
