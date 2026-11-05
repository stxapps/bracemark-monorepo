import { PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';

import {
  STRENGTH_BANDS,
  STRENGTH_LABELS,
  strengthDisplayScore,
  STRONGEST_DISPLAY_SCORE,
} from './password-strength-bands';

// The banding both platforms' meters render. The behaviour end to end (a real
// zxcvbn estimate through `usePasswordStrength`) is pinned on web by
// web-ui password-strength-meter.spec.tsx; this pins the pure step and the
// invariants that join the bands, the labels and the gate.
describe('strength bands', () => {
  it('ends on the gate, so a full meter and a passing gate are one condition', () => {
    expect(STRENGTH_BANDS.at(-1)).toBe(PASSWORD_MIN_GUESSES_LOG10);
  });

  it('has a label for every displayScore, and the top one is Strong', () => {
    expect(STRENGTH_LABELS).toHaveLength(STRONGEST_DISPLAY_SCORE + 1);
    expect(STRENGTH_LABELS[STRONGEST_DISPLAY_SCORE]).toBe('Strong');
  });

  it('lights the top band only at the gate', () => {
    expect(strengthDisplayScore(PASSWORD_MIN_GUESSES_LOG10, 30, 20)).toBe(STRONGEST_DISPLAY_SCORE);
    expect(strengthDisplayScore(PASSWORD_MIN_GUESSES_LOG10 - 0.01, 30, 20)).toBe(
      STRONGEST_DISPLAY_SCORE - 1,
    );
  });

  it('bands a weak estimate at the bottom', () => {
    expect(strengthDisplayScore(5, 30, 20)).toBe(0);
  });

  // THE RULE: the meter may never read "Strong" while the length floor blocks submit.
  it('holds a too-short password one band under the top', () => {
    expect(strengthDisplayScore(24, 19, 20)).toBe(STRONGEST_DISPLAY_SCORE - 1);
  });

  it('does not clamp when no length floor was asked for', () => {
    expect(strengthDisplayScore(24, 19, 0)).toBe(STRONGEST_DISPLAY_SCORE);
  });

  it('does not lift a lower band when clamping', () => {
    expect(strengthDisplayScore(5, 3, 20)).toBe(0);
  });
});
