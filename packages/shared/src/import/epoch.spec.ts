import { parseEpoch } from './epoch';

// The one timestamp rule two parsers share (netscape's ADD_DATE/TIME_ADDED,
// csv's time_added). Its whole content is the MAGNITUDE ladder — seconds vs ms
// vs µs decided by size, not digit count — and every rung of it is silent when
// wrong: a µs stamp read as ms dates a bookmark to the year 55000, and a seconds
// stamp read as ms dates it to January 1970. Either way the row imports, sorts
// somewhere absurd, and nothing errors.

describe('parseEpoch', () => {
  it('reads the de-facto seconds convention', () => {
    expect(parseEpoch('1700000000')).toBe(1_700_000_000_000);
  });

  it('passes milliseconds through', () => {
    expect(parseEpoch('1700000000000')).toBe(1_700_000_000_000);
  });

  it('divides Firefox’s microseconds', () => {
    // `places` exports are µs; without this rung every Firefox bookmark lands
    // ~50 000 years from now, which sorts fine and reads as a bug in the app.
    expect(parseEpoch('1700000000000000')).toBe(1_700_000_000_000);
  });

  it('goes by magnitude, not digit count', () => {
    // The header's own claim: a pre-2001 date is 9 digits of seconds, and a rule
    // that counted digits (">= 10 is seconds") would leave it undated or in 1970.
    expect(parseEpoch('999999999')).toBe(999_999_999_000); // 2001-09-09, in seconds
    expect(parseEpoch('86400')).toBe(86_400_000); // 1970-01-02, still seconds
    // And a zero-padded seconds value is the same number, not a longer one.
    expect(parseEpoch('01700000000')).toBe(1_700_000_000_000);
  });

  // The two thresholds, walked from both sides. Nothing else in either parser's
  // spec sits within an order of magnitude of them, so a comparison that slipped a
  // factor of ten would go unnoticed everywhere else.
  it.each([
    ['just under the ms threshold — still seconds', '99999999999', 99_999_999_999_000],
    ['exactly at the ms threshold', '100000000000', 100_000_000_000],
    ['just under the µs threshold — still ms', '99999999999999', 99_999_999_999_999],
    ['exactly at the µs threshold', '100000000000000', 100_000_000_000],
  ])('%s', (_name, input, expected) => {
    expect(parseEpoch(input)).toBe(expected);
  });

  it('floors a microsecond value rather than carrying a fraction', () => {
    // The result feeds `createdAt`, which `linkSchema` requires to be an INTEGER —
    // a fractional ms would fail the row's validation at the end of the import.
    expect(parseEpoch('1700000000000999')).toBe(1_700_000_000_000);
    expect(Number.isInteger(parseEpoch('1700000000000999'))).toBe(true);
  });

  it.each([
    ['undefined (the attribute was absent)', undefined],
    ['an ISO date', '2023-11-14T22:13:20.000Z'],
    ['prose', 'not-a-date'],
    ['empty', ''],
    ['a signed number', '-1700000000'],
    ['a decimal', '1700000000.5'],
    ['exponent notation', '17e8'],
    ['padding the parser has not trimmed', ' 1700000000'],
  ])('refuses %s', (_name, input) => {
    expect(parseEpoch(input)).toBeUndefined();
  });

  it('refuses zero, however it is spelled', () => {
    // Epoch 0 is what a source writes when it has no date at all; taking it would
    // stamp the link 1970-01-01 instead of letting the projection date it from the
    // import (project.ts stamps an undated row from `now`).
    expect(parseEpoch('0')).toBeUndefined();
    expect(parseEpoch('0000')).toBeUndefined();
  });

  it('refuses a value too large to be a number at all', () => {
    // All digits, so the shape test passes; `parseInt` then overflows to Infinity,
    // and only the isFinite guard keeps `Infinity` out of a timestamp field.
    expect(parseEpoch('9'.repeat(400))).toBeUndefined();
  });
});
