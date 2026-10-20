import { render, screen } from '@testing-library/react';

import { RelativeTime } from './relative-time';

// The date a list row shows is whichever field the list is sorted by, read
// straight off the stored link. Its schema asks for an integer, and an integer
// can be an instant `Date` cannot represent: `toISOString` throws a RangeError
// on it. This cell called it in render — for every row, whether or not the
// column was visible — so one such link took down the list layout of every view
// that contained it. The import edges refuse the value now (@stxapps/shared
// sync/calendar-time.ts); what is already stored, or arrives from another
// device, still lands here.

const LAST_INSTANT = 8.64e15;

describe('RelativeTime', () => {
  it.each([LAST_INSTANT + 1, -LAST_INSTANT - 1, Number.MAX_SAFE_INTEGER])(
    'renders %d as an unknown date instead of throwing',
    (epochMs) => {
      render(<RelativeTime epochMs={epochMs} verb="Updated" />);

      // Named for assistive tech and on hover, with no machine-readable instant —
      // a `dateTime` that is not a date is worse than none.
      const cell = screen.getByLabelText('Updated date unknown');
      expect(cell.getAttribute('title')).toBe('Updated date unknown');
      expect(cell.hasAttribute('datetime')).toBe(false);
    },
  );

  // The control: a cell that called every date unknown would pass the case above.
  it('carries the exact instant for a date the calendar can name', () => {
    const epochMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    render(<RelativeTime epochMs={epochMs} verb="Added" />);

    const cell = screen.getByLabelText(/^Added /);
    expect(cell.getAttribute('datetime')).toBe('2026-01-02T03:04:05.000Z');
    expect(cell.getAttribute('aria-label')).not.toBe('Added date unknown');
  });

  it('names the month past a year, either way, and counts within one', () => {
    const now = Date.UTC(2026, 9, 20, 12);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const day = 24 * 60 * 60 * 1000;
    const months = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' });
    try {
      const { container } = render(
        <>
          <RelativeTime epochMs={Date.UTC(2009, 2, 14)} verb="Added" />
          <RelativeTime epochMs={now + 400 * day} verb="Added" />
          <RelativeTime epochMs={now + 3 * day} verb="Added" />
        </>,
      );
      const cells = [...container.querySelectorAll('time')].map((cell) => cell.textContent);
      // A count of years rounded 17.6 up to "18 yr. ago"; the month is exact.
      expect(cells[0]).toBe(months.format(Date.UTC(2009, 2, 14)));
      expect(cells[1]).toBe(months.format(now + 400 * day));
      expect(cells[2]).not.toBe(months.format(now + 3 * day));
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('still names the last instant on either side', () => {
    const { container } = render(
      <>
        <RelativeTime epochMs={LAST_INSTANT} verb="Added" />
        <RelativeTime epochMs={-LAST_INSTANT} verb="Added" />
      </>,
    );

    expect([...container.querySelectorAll('time')].map((cell) => cell.dateTime)).toEqual([
      '+275760-09-13T00:00:00.000Z',
      '-271821-04-20T00:00:00.000Z',
    ]);
  });
});
