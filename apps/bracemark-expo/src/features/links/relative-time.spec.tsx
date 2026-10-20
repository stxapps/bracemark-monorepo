import { render, screen } from '@testing-library/react-native';

import { RelativeTime } from './relative-time';

// The link row's date column, which only appears once a row is wide enough —
// so on phones nobody sees it, and on the coming tablets nobody would notice it
// reading wrong to a screen reader. The visible text is a bare abbreviation
// ("3d"); the accessible name is the only place the verb and the unit in words
// live, and the row folds it into its own name.

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60 * 1000;
const LAST_INSTANT = 8.64e15;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('names the verb and spells out the unit the visible text abbreviates', () => {
  render(<RelativeTime epochMs={NOW - 3 * DAY} verb="Added" />);

  expect(screen.getByLabelText('Added 3 days ago')).toHaveTextContent('3d');
});

it('says a single unit in the singular, and under a minute as just now', () => {
  render(
    <>
      <RelativeTime epochMs={NOW - DAY} verb="Updated" />
      <RelativeTime epochMs={NOW - 1000} verb="Updated" />
    </>,
  );

  expect(screen.getByLabelText('Updated 1 day ago')).toHaveTextContent('1d');
  expect(screen.getByLabelText('Updated just now')).toHaveTextContent('now');
});

it('names the month past a year, either way', () => {
  render(
    <>
      <RelativeTime epochMs={Date.UTC(2009, 2, 14, 12)} verb="Added" />
      <RelativeTime epochMs={NOW + 400 * DAY} verb="Added" />
    </>,
  );

  // A count of years rounded 17.6 up to "18y"; the month is exact.
  expect(screen.getByLabelText('Added March 2009')).toHaveTextContent('Mar 2009');
  expect(screen.getByLabelText('Added November 2027')).toHaveTextContent('Nov 2027');
});

it('counts forward for a date in the future instead of saying now', () => {
  // Another device's clock ran fast. Every unit used to test `diff >= ms`
  // against a negative diff and fall through to "now".
  render(<RelativeTime epochMs={NOW + 3 * DAY} verb="Added" />);

  expect(screen.getByLabelText('Added in 3 days')).toHaveTextContent('in 3d');
});

// A date the calendar cannot name doesn't throw here as it did on web — the
// arithmetic just turns it into a figure ("285193y", or "now" from the far
// future) that reads as a real date.
it.each([LAST_INSTANT + 1, -LAST_INSTANT - 1, Number.MAX_SAFE_INTEGER])(
  'says %d is an unknown date instead of inventing one',
  (epochMs) => {
    render(<RelativeTime epochMs={epochMs} verb="Updated" />);

    expect(screen.getByLabelText('Updated date unknown')).toHaveTextContent('—');
  },
);
