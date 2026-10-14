import {
  NEW_PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_GUESSES_LOG10,
  usernameSchema,
} from '@stxapps/shared';

import { newPasswordMessage, type UsernameAvailability, usernameMessage } from './field-messages';

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
    expect(text).toBe('Couldn’t check. Try again.');
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

// Change password's proof is the current password, so the ladder can see it — and
// without this rung a rotation to the same password passes every other rung (it
// cleared the floor when it was set) and opens the gate on a no-op.
describe('newPasswordMessage — the current password', () => {
  const current = 'a'.repeat(NEW_PASSWORD_MIN_LENGTH) + '-correct-length';
  const strong = PASSWORD_MIN_GUESSES_LOG10 + 1;

  it('refuses the current password as the new one', () => {
    expect(newPasswordMessage(current, strong, false, current)).toEqual({
      text: 'That’s your current password.',
      tone: 'error',
    });
  });

  // The KEK derives from the canonical form, so these ARE the same password.
  it('compares the canonical forms', () => {
    expect(newPasswordMessage(` ${current} `, strong, false, current).tone).toBe('error');
    expect(
      newPasswordMessage('caf\u00e9-' + current, strong, false, 'cafe\u0301-' + current).tone,
    ).toBe('error');
  });

  it('passes a different password', () => {
    expect(newPasswordMessage(`${current}x`, strong, false, current).tone).toBe('ok');
  });

  // Unset on create-account and the recovery-code path; an empty proof field is a
  // user who hasn't typed it yet, not a password to compare with.
  it('compares nothing without a current password', () => {
    expect(newPasswordMessage(current, strong).tone).toBe('ok');
    expect(newPasswordMessage(current, strong, false, '').tone).toBe('ok');
  });

  it('keeps the resting rung for an empty field', () => {
    expect(newPasswordMessage('', null, false, '').tone).toBe('muted');
  });
});

// The username ladder's states are reachable by hand, but three of its rungs sit in
// windows a person can't hold still: the ~400ms after a keystroke where the query
// still describes the PREVIOUS name, the frame between mount and fetch start, and a
// request the next keystroke aborted. All three leave `isFetching` false with data
// that is either stale or absent — so the ladder's ordering, not its wording, is what
// keeps them honest, and ordering is exactly what a browser can't be made to hold.
describe('usernameMessage', () => {
  // The shape useUsernameAvailable returns, at rest with a settled answer.
  const settled = (available: boolean) => ({
    current: true,
    isFetching: false,
    isError: false,
    data: { available },
  });

  it('rests on the format rule when the field is empty', () => {
    expect(usernameMessage('', settled(true), false)).toEqual({
      text: '3–32 letters, numbers, _ or -',
      tone: 'muted',
    });
  });

  // The schema's own message, so the rule that FAILED shows through — a catch-all
  // ("Invalid username") leaves the user guessing which of length, charset or
  // reserved-name they tripped.
  it('surfaces the rule that actually failed', () => {
    expect(usernameMessage('ab', settled(true), false)).toEqual({
      text: usernameSchema.safeParse('ab').error?.issues[0]?.message,
      tone: 'error',
    });
    expect(usernameMessage('has space', settled(true), false).text).toBe(
      'Use letters, numbers, _ or -',
    );
    expect(usernameMessage('alice--01', settled(true), false).text).toBe(
      'Use _ or - only as separators',
    );
  });

  // THE rung this ladder exists for. The query answers the DEBOUNCED name, so for
  // ~400ms after a keystroke `data` describes the name as it was before — while
  // `isFetching` is still false, because no request has started. Reading `data`
  // without the `current` guard says "Username is available" about a name the user
  // has already typed past, which is the one direction this line must never be
  // wrong in, and the window is far too short to catch by looking.
  it('never calls a name available while the answer is about the previous one', () => {
    const stale = { ...settled(true), current: false };
    expect(usernameMessage('alice2', stale, false)).toEqual({
      text: 'Checking availability…',
      tone: 'muted',
    });
  });

  // Same guard, the other verdict: a stale "taken" must not be announced either —
  // `error` is what both forms spell `aria-invalid` as, so it would claim "invalid
  // entry" about a name nothing has judged yet.
  it('never calls a name taken while the answer is about the previous one', () => {
    const stale = { ...settled(false), current: false };
    expect(usernameMessage('alice2', stale, false).tone).toBe('muted');
  });

  it('reports a settled verdict either way', () => {
    expect(usernameMessage('alice', settled(true), false)).toEqual({
      text: 'Username is available',
      tone: 'ok',
    });
    expect(usernameMessage('alice', settled(false), false)).toEqual({
      text: 'Username is taken',
      tone: 'error',
    });
  });

  // The server's answer at creation outranks anything the live query cached — the
  // cache can be a minute old (staleTime 60_000) and still say available, so without
  // this rung a create that came back UsernameTakenError leaves a green "Username is
  // available" over a form that refuses to submit.
  it('lets the submit-time verdict outrank a cached available', () => {
    expect(usernameMessage('alice', settled(true), true)).toEqual({
      text: 'Username is taken',
      tone: 'error',
    });
  });

  // The STUCK rung. Nothing about a failed check resolves on its own and editing the
  // name won't help, so it owes both an emphasis and an instruction — but `warn`, not
  // `error`: the name may be perfectly free, and `error` would announce "invalid
  // entry" about it and point at the one repair that fixes nothing.
  it('blames the check, not the name, when the request failed', () => {
    const failed = { current: true, isFetching: false, isError: true, data: undefined };
    expect(usernameMessage('alice', failed, false)).toEqual({
      text: 'Couldn’t check. Try again.',
      tone: 'warn',
    });
  });

  // Enabled but not yet settled — the frame between mount and fetch start, or a
  // request the next keystroke aborted via `signal`. Both leave `isFetching` false
  // for a tick with nothing to report, and both are self-resolving, so this must read
  // as the same wait as the debounce rung rather than as the stuck one above.
  it('reads an unsettled query as waiting, not as failed', () => {
    const unsettled = { current: true, isFetching: false, isError: false, data: undefined };
    expect(usernameMessage('alice', unsettled, false)).toEqual({
      text: 'Checking availability…',
      tone: 'muted',
    });
  });

  // `ok` is THE GATE — both forms spell Continue as `tone === 'ok'`. Nothing short of
  // a current, settled, affirmative answer may open it.
  it('only opens the gate on a current, affirmative answer', () => {
    const blocked = [
      usernameMessage('', settled(true), false),
      usernameMessage('ab', settled(true), false),
      usernameMessage('alice', settled(true), true),
      usernameMessage('alice', { ...settled(true), current: false }, false),
      usernameMessage('alice', { ...settled(true), isFetching: true }, false),
      usernameMessage('alice', settled(false), false),
      usernameMessage('alice', { current: true, isFetching: false, isError: true }, false),
      usernameMessage('alice', { current: true, isFetching: false, isError: false }, false),
    ];
    for (const message of blocked) expect(message.tone).not.toBe('ok');
  });
});

// The width budget, from the note at the top of field-messages.ts: one line in the
// slot, budgeted against a PHONE and not the card's maximum — ~220px, roughly 33
// characters at text-sm. A rung that wraps to two lines reintroduces the reflow the
// permanent slot exists to remove, and it does so only below ~430px, so it is
// invisible on the desktop viewport every one of these is written on. One rung
// already shipped over the line ("Looks strong — save it in your password manager.",
// 334px) after passing a looser reading of the same rule.
//
// Characters are a proxy for pixels and a crude one; it is the only form of this
// constraint a test can hold, and it is calibrated with headroom — every rung in
// both ladders is at 27 or under today — so it fires on a rung written to the wrong
// budget, not on one that is merely a word longer.
describe('the slot is one line wide', () => {
  const MAX_CHARS = 33;

  const availability = (over: Partial<UsernameAvailability> = {}): UsernameAvailability => ({
    current: true,
    isFetching: false,
    isError: false,
    data: { available: true },
    ...over,
  });

  const strong = 'a'.repeat(NEW_PASSWORD_MIN_LENGTH) + '-correct-length';

  // Every rung either ladder can print, reached through the public functions rather
  // than listed as strings, so a reworded rung is measured as it now reads.
  const rungs = [
    usernameMessage('', availability(), false),
    usernameMessage('ab', availability(), false),
    usernameMessage('has space', availability(), false),
    usernameMessage('a'.repeat(33), availability(), false),
    usernameMessage('admin', availability(), false),
    usernameMessage('alice', availability({ current: false }), false),
    usernameMessage('alice', availability(), false),
    usernameMessage('alice', availability({ data: { available: false } }), false),
    usernameMessage('alice', availability(), true),
    usernameMessage('alice', availability({ isError: true, data: undefined }), false),
    usernameMessage('alice', availability({ data: undefined }), false),
    newPasswordMessage('', null),
    newPasswordMessage('short', null),
    newPasswordMessage(strong, null),
    newPasswordMessage(strong, null, true),
    newPasswordMessage(strong, PASSWORD_MIN_GUESSES_LOG10 - 1),
    newPasswordMessage(strong, PASSWORD_MIN_GUESSES_LOG10 + 1),
    newPasswordMessage(strong, PASSWORD_MIN_GUESSES_LOG10 + 1, false, strong),
  ];

  it.each(rungs.map((rung) => [rung.text]))('“%s” fits the slot', (text) => {
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  // A rung that says nothing is the other half of the same rule: the slot is
  // permanent, so an empty one is a state that went silent while submit sat
  // disabled — the exact gap the ladders replaced.
  it('never leaves the slot blank', () => {
    for (const rung of rungs) expect(rung.text).not.toBe('');
  });
});
