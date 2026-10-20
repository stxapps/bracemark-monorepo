// A relative date ("3 days ago") with its verb, on its own so it can be rendered
// without the virtualized list around it (relative-time.spec.tsx). Today its one
// caller is the list layout's sorted-field date column, which supplies the verb
// and its own placement classes. Expo's twin is features/links/relative-time.tsx.

import { isCalendarTime } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

// Compact, localized "N ago" for the wide-pane date column (the sorted field —
// created or updated; the row supplies the verb). Intl.RelativeTimeFormat
// only formats a (count, unit) pair, so we pick the largest unit that fits and hand it the
// count; `numeric: 'auto'` yields "yesterday"/"last week" where they read better than
// "1 … ago", and `style: 'short'` keeps the column narrow ("3 days ago", "2 mo. ago").
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
});
// Past a year either way the column names the month instead ("Mar 2009"). A
// count of years rounds a long way — 17.6 years read "18 yr. ago" — and at that
// distance the month is what a reader places a bookmark by. The tooltip still
// carries the exact instant. Long months for the accessible name, which a
// screen reader would otherwise spell out.
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const monthFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' });
const spokenMonthFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];
function formatRelativeTime(epochMs: number, spoken = false): string {
  const diff = epochMs - Date.now(); // < 0 for the past
  const abs = Math.abs(diff);
  if (abs >= YEAR_MS) return (spoken ? spokenMonthFormat : monthFormat).format(epochMs);
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return relativeTimeFormat.format(Math.round(diff / ms), unit);
  }
  return relativeTimeFormat.format(Math.round(diff / 1000), 'second');
}

// A stored date can be an integer the calendar cannot name — `toISOString`
// THROWS on one, and it did so in render, hidden column or not, for every list
// containing the row (@stxapps/shared sync/calendar-time.ts). The import edges
// refuse such a value now, but one already stored or synced from another device
// still arrives here, so the cell renders without a machine-readable instant and
// says the date is unknown rather than taking the page down with it.
//
// `className` is the caller's placement (the list layout's `@xl` reveal); the
// look — small, muted, unwrapped — is the component's.
export function RelativeTime({
  epochMs,
  verb,
  className: placement,
}: {
  epochMs: number;
  verb: string;
  className?: string;
}) {
  const className = cn('text-xs whitespace-nowrap text-muted-foreground', placement);
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
      aria-label={`${verb} ${formatRelativeTime(epochMs, true)}`}
      className={className}
    >
      {formatRelativeTime(epochMs)}
    </time>
  );
}
