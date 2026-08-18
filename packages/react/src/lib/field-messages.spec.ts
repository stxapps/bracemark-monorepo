import { NEW_PASSWORD_MIN_LENGTH, PASSWORD_MIN_GUESSES_LOG10 } from '@stxapps/shared';

import { newPasswordMessage } from './field-messages';

// `guessesLog10 === null` is THREE states wearing one value — no password typed yet,
// the estimator still loading, and the estimator failed to load — and the whole reason
// the message slot is permanent is that a state with no rung of its own goes silent
// while submit sits disabled (see the note at the top of field-messages.ts).
//
// The failed one is the state that can't be seen by looking: it needs the zxcvbn chunk
// to actually not arrive, so it shows up in a browser only when offline or against a
// stale deploy, and it FALLS BACK to the loading rung — an in-flight, self-resolving
// message on a condition that resolves itself never. That is the exact bug this rung
// was added for, and nothing but a test can tell the two apart, since both are `null`
// and the rungs differ only in their words.
describe('newPasswordMessage — the three ways there is no estimate', () => {
  const strong = 'a'.repeat(NEW_PASSWORD_MIN_LENGTH) + '-correct-length';

  it('rests on the length rule when the field is empty', () => {
    expect(newPasswordMessage('', null)).toEqual({
      text: `At least ${NEW_PASSWORD_MIN_LENGTH} characters.`,
      tone: 'muted',
    });
  });

  it('says it is still checking while the estimator loads', () => {
    const { tone, text } = newPasswordMessage(strong, null);
    expect(tone).toBe('muted'); // in-flight: blocked, but self-resolving
    expect(text).toBe('Checking strength…');
  });

  it('says the check FAILED, not that it is still running, once the load is lost', () => {
    const { tone, text } = newPasswordMessage(strong, null, true);
    expect(text).not.toBe('Checking strength…');
    expect(text).toBe("Couldn't check. Try again.");
    // `warn`, never `error`: the check failed, not the password. `error` is what both
    // forms spell `aria-invalid` as, and this password may well be strong.
    expect(tone).toBe('warn');
  });

  // Every rung above blocks: `ok` is the gate, and no estimate can ever open it.
  it('never opens the gate without an estimate', () => {
    for (const message of [
      newPasswordMessage('', null),
      newPasswordMessage(strong, null),
      newPasswordMessage(strong, null, true),
    ]) {
      expect(message.tone).not.toBe('ok');
    }
  });

  // The failure is about the CHECK, so it must not mask a fault in the value itself —
  // a too-short password is fixable by typing whether or not zxcvbn ever loads.
  it('still reports a too-short password while the load is lost', () => {
    expect(newPasswordMessage('short', null, true).tone).toBe('error');
  });

  // And it must not outrank a real verdict: once an estimate exists, `strengthFailed`
  // is stale by construction (the retry succeeded) and the ladder reads the estimate.
  it('yields to a real estimate', () => {
    expect(newPasswordMessage(strong, PASSWORD_MIN_GUESSES_LOG10 + 1, true).tone).toBe('ok');
  });
});
