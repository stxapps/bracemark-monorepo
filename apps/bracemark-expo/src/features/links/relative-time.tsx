// A relative date ("3d") with its verb — the expo port of bracemark-web's
// `_layouts/relative-time.tsx`, on its own for the same reason: so it can be
// rendered without the list around it (relative-time.spec.tsx). Today its one
// caller is link-row.tsx's sorted-field date column, which supplies the verb and
// its own placement classes.
//
// Formatted by hand rather than Intl.RelativeTimeFormat — Hermes' Intl coverage
// is uneven across platforms, and the compact "3d" style suits the narrow column
// anyway. So web's two formats diverge here on purpose, and they are not shared:
// web's is localized by the platform, this one is not.

import { isCalendarTime } from '@stxapps/shared';

import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

const MINUTE = 60 * 1000;
// Past a year either way the column names the month instead ("Mar 2009"), as
// web does: a count of years rounds a long way (17.6 years read "18y"). Spelled
// out by hand for the same Hermes reason as the units — and English, like the
// rest of this app's copy.
const YEAR_MS = 365 * 24 * 60 * MINUTE;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
function monthOf(epochMs: number, spoken: boolean): string {
  const date = new Date(epochMs);
  const month = MONTHS[date.getMonth()];
  return `${spoken ? month : month.slice(0, 3)} ${date.getFullYear()}`;
}
// [visible suffix, spoken unit, length]
const RELATIVE_UNITS: [string, string, number][] = [
  ['mo', 'month', 30 * 24 * 60 * MINUTE],
  ['w', 'week', 7 * 24 * 60 * MINUTE],
  ['d', 'day', 24 * 60 * MINUTE],
  ['h', 'hour', 60 * MINUTE],
  ['m', 'minute', MINUTE],
];

// Compact "3d" / "2mo" for the date column: the largest unit that fits. A
// date in the FUTURE — another device's clock running fast — reads "in 3d"; it
// used to fall through every unit to "now".
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const abs = Math.abs(diff);
  if (abs >= YEAR_MS) return monthOf(epochMs, false);
  for (const [unit, , ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      const count = `${Math.round(abs / ms)}${unit}`;
      return diff < 0 ? `in ${count}` : count;
    }
  }
  return 'now';
}

// The same value in words, for the accessible name. The visible suffixes are
// abbreviations a screen reader cannot expand — "3d" reads as "3 d", "2mo" as
// "2 mo" — so the label spells them out, the way web's Intl output already reads
// ("3 days ago"). Same unit, same count as the visible text, so the two cannot
// disagree.
function spokenRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const abs = Math.abs(diff);
  if (abs >= YEAR_MS) return monthOf(epochMs, true);
  for (const [, unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      const count = Math.round(abs / ms);
      const units = `${count} ${unit}${count === 1 ? '' : 's'}`;
      return diff < 0 ? `in ${units}` : `${units} ago`;
    }
  }
  return 'just now';
}

// The visible text is bare to keep the column narrow, so the verb ("Added" /
// "Updated" — which field the list is sorted by) rides the label only. Inside the
// row's Pressable the label is what folds into the row's composite name ("…,
// journal.example.net, Added 3 days ago") — the same route the pinned and note
// badges take (shared.tsx; docs/accessibility.md). `aria-label` is right here
// where it is wrong on those badges: this is RN's own Text, which translates it.
// There is no web `title` twin — a touch surface has no hover.
//
// A stored date can be an integer the calendar cannot name (@stxapps/shared
// sync/calendar-time.ts). Nothing here throws on one — this column never calls
// `toISOString` — but the arithmetic turns it into nonsense ("285193y", or "now"
// for one far in the future), so it says the date is unknown instead, as web
// does.
//
// `className` is the caller's placement; the look — small, muted, one line — is
// the component's.
export function RelativeTime({
  epochMs,
  verb,
  className,
}: {
  epochMs: number;
  verb: string;
  className?: string;
}) {
  const known = isCalendarTime(epochMs);
  return (
    <Text
      numberOfLines={1}
      aria-label={known ? `${verb} ${spokenRelativeTime(epochMs)}` : `${verb} date unknown`}
      className={cn('text-xs text-muted-foreground', className)}
    >
      {known ? formatRelativeTime(epochMs) : '—'}
    </Text>
  );
}
