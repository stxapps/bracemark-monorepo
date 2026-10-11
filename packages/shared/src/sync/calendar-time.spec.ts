import { isCalendarTime } from './calendar-time';

// ECMAScript's time value: ±100,000,000 days around the epoch, in milliseconds.
// Stated once here so the spec holds the predicate against the platform's
// contract rather than against the predicate's own arithmetic.
const LAST_INSTANT = 8.64e15;

describe('isCalendarTime', () => {
  // The predicate exists for one reason: `toISOString` throws on an instant
  // `Date` cannot represent, and the entity schemas admit such integers. So the
  // property worth pinning is the relation between the two, at the boundary and
  // either side of it — a predicate that is merely "roughly right" leaves a value
  // that still takes a list render down.
  it.each([
    0,
    -1,
    1_700_000_000_000,
    LAST_INSTANT,
    -LAST_INSTANT,
    LAST_INSTANT + 1,
    -LAST_INSTANT - 1,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('is true for %d exactly when toISOString can name it', (epochMs) => {
    let named = true;
    try {
      new Date(epochMs).toISOString();
    } catch {
      named = false;
    }
    expect(isCalendarTime(epochMs)).toBe(named);
  });

  it('admits the last instant on each side and refuses the next millisecond', () => {
    expect(isCalendarTime(LAST_INSTANT)).toBe(true);
    expect(isCalendarTime(-LAST_INSTANT)).toBe(true);
    expect(isCalendarTime(LAST_INSTANT + 1)).toBe(false);
    expect(isCalendarTime(-LAST_INSTANT - 1)).toBe(false);
  });
});
