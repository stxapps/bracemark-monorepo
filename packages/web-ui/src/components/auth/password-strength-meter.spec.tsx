import { render, waitFor } from '@testing-library/react';

import { NEW_PASSWORD_MIN_LENGTH } from '@stxapps/shared';

import { PasswordStrengthMeter, usePasswordStrength } from './password-strength';

// The METER's half of the entropy gate. `password-strength.spec.ts` beside this
// pins WHICH dictionaries the gate scores against; this pins what the user is
// shown about the result, and the one rule connecting the two:
//
//   the meter may never read "Strong" while submit is blocked.
//
// That rule is not free, because the two floors are enforced in different places.
// zxcvbn can't be told either of them — it reports guess counts — so the entropy
// floor is folded in by making the top display band BE
// `PASSWORD_MIN_GUESSES_LOG10`, while the LENGTH floor has to be applied by hand
// afterwards. Drop that second step and a 19-character random password lights the
// meter green, labels itself Strong, and sits under a disabled Continue button
// with the message line saying it is too short. Nothing catches it: both numbers
// are individually correct.
//
// These drive the real loader (a genuine dynamic import of ~1.7 MB of dictionary),
// which is why the timeouts are generous — the same deal as the dictionary spec.

const PASSES_ENTROPY_BUT_TOO_SHORT = 'Qx7-vT2m_pR9wLd4Zk1'; // 19 chars, ~10^19 guesses
const PASSES_BOTH = 'Qx7-vT2m_pR9wLd4Zk1B-nH6'; // 24 chars, ~10^24

function probeStrength(password: string, userInputs: string[] = [], minLength = 0) {
  const result = { current: null as ReturnType<typeof usePasswordStrength> | null };
  function Probe() {
    result.current = usePasswordStrength(password, userInputs, minLength);
    return null;
  }
  render(<Probe />);
  return result;
}

/** Waits for the dynamically-imported estimator to land. */
const settled = async (result: { current: ReturnType<typeof usePasswordStrength> | null }) => {
  await waitFor(() => expect(result.current?.ready).toBe(true), { timeout: 30_000 });
  const current = result.current;
  if (!current) throw new Error('the probe never rendered');
  return current;
};

describe('usePasswordStrength — what the meter is told', () => {
  it('reports nothing until the estimator has loaded', async () => {
    const result = probeStrength(PASSES_BOTH);

    // Never gate-open before the estimator is ready: the caller reads a null
    // `guessesLog10` as "no answer yet" and keeps submit disabled.
    expect(result.current).toEqual({
      guessesLog10: null,
      displayScore: null,
      ready: false,
      failed: false,
    });

    // Let the import land before the test ends, so its state update isn't
    // orphaned outside `act`.
    await settled(result);
  }, 30_000);

  it('scores an empty password as no answer rather than as zero', async () => {
    const result = probeStrength('');
    await waitFor(() => expect(result.current?.ready).toBe(true), { timeout: 30_000 });

    // A 0 here would light the first (red) segment on a field the user hasn't
    // touched, and would read as a verdict on nothing.
    expect(result.current?.guessesLog10).toBeNull();
    expect(result.current?.displayScore).toBeNull();
  }, 30_000);

  it('lights the top band for a password that clears both floors', async () => {
    const result = probeStrength(PASSES_BOTH, [], NEW_PASSWORD_MIN_LENGTH);
    const { guessesLog10, displayScore } = await settled(result);

    expect(guessesLog10).toBeGreaterThanOrEqual(18);
    expect(displayScore).toBe(3);
  }, 30_000);

  // THE RULE. Entropy passes, length doesn't — so the gate is shut, and the meter
  // must say so.
  it('holds the display one band under the top while the length floor blocks submit', async () => {
    expect(PASSES_ENTROPY_BUT_TOO_SHORT.length).toBeLessThan(NEW_PASSWORD_MIN_LENGTH);

    const result = probeStrength(PASSES_ENTROPY_BUT_TOO_SHORT, [], NEW_PASSWORD_MIN_LENGTH);
    const { guessesLog10, displayScore } = await settled(result);

    expect(guessesLog10).toBeGreaterThanOrEqual(18);
    expect(displayScore).toBe(2);
  }, 30_000);

  // The same string with no length floor asked for is band 3 — i.e. the clamp
  // above is the length floor doing it, not the estimate coming out lower.
  it('does not clamp when no length floor was asked for', async () => {
    const result = probeStrength(PASSES_ENTROPY_BUT_TOO_SHORT);
    const { displayScore } = await settled(result);

    expect(displayScore).toBe(3);
  }, 30_000);

  it('bands a weak password at the bottom', async () => {
    const result = probeStrength('password123', [], NEW_PASSWORD_MIN_LENGTH);
    const { displayScore } = await settled(result);

    expect(displayScore).toBe(0);
  }, 30_000);
});

describe('PasswordStrengthMeter', () => {
  // The meter renders inside a `polite` live region so the verdict is announced
  // as it changes, without interrupting typing.
  it('announces politely', () => {
    const { container } = render(<PasswordStrengthMeter displayScore={3} />);

    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it.each([
    [0, 'Very weak'],
    [1, 'Weak'],
    [2, 'Fair'],
    [3, 'Strong'],
  ])('labels band %i as %s', (score, text) => {
    const { container } = render(<PasswordStrengthMeter displayScore={score} />);

    expect(container.textContent).toBe(text);
  });

  // A null score is the empty TRACK, not an absent component: the meter is a
  // permanent part of the typed-password field, so appearing on the first
  // keystroke would shove the message line and both help paragraphs down the card
  // exactly as the user starts typing.
  it('renders the empty track rather than nothing when there is no score', () => {
    const { container } = render(<PasswordStrengthMeter displayScore={null} />);

    expect(container.textContent).toBe('');
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    // Four segments, always — the row's height does not depend on the score.
    expect(container.querySelectorAll('[aria-live="polite"] > div > span')).toHaveLength(4);
  });

  it('keeps the same four segments once a score arrives', () => {
    const { container } = render(<PasswordStrengthMeter displayScore={1} />);

    expect(container.querySelectorAll('[aria-live="polite"] > div > span')).toHaveLength(4);
  });
});
