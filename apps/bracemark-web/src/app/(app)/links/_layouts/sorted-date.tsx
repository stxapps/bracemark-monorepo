// The list layout's sorted-field date cell, on its own so it can be rendered
// without the virtualized list around it (sorted-date.spec.tsx).

import { isCalendarTime } from '@stxapps/shared';

// Compact, localized "N ago" for the wide-pane date column (the sorted field —
// created or updated; the row supplies the verb). Intl.RelativeTimeFormat
// only formats a (count, unit) pair, so we pick the largest unit that fits and hand it the
// count; `numeric: 'auto'` yields "yesterday"/"last week" where they read better than
// "1 … ago", and `style: 'short'` keeps the column narrow ("3 days ago", "2 mo. ago").
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
});
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];
function formatRelativeTime(epochMs: number): string {
  const diff = epochMs - Date.now(); // < 0 for the past
  const abs = Math.abs(diff);
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return relativeTimeFormat.format(Math.round(diff / ms), unit);
  }
  return relativeTimeFormat.format(Math.round(diff / 1000), 'second');
}

// The sorted-field date cell. A stored date can be an integer the calendar
// cannot name — `toISOString` THROWS on one, and it did so in render, hidden
// column or not, for every list containing the row (@stxapps/shared
// sync/calendar-time.ts). The import edges refuse such a value now, but one
// already stored or synced from another device still arrives here, so the row
// renders without a machine-readable instant and says the date is unknown
// rather than taking the page down with it.
export function SortedDate({ epochMs, verb }: { epochMs: number; verb: string }) {
  const className = 'hidden shrink-0 text-xs whitespace-nowrap text-muted-foreground @xl:block';
  if (!isCalendarTime(epochMs)) {
    const unknown = `${verb} date unknown`;
    return (
      <time title={unknown} aria-label={unknown} className={className}>
        —
      </time>
    );
  }
  return (
    <time
      dateTime={new Date(epochMs).toISOString()}
      title={`${verb} ${new Date(epochMs).toLocaleString()}`}
      aria-label={`${verb} ${formatRelativeTime(epochMs)}`}
      className={className}
    >
      {formatRelativeTime(epochMs)}
    </time>
  );
}
