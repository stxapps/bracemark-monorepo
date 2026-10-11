// Whether an epoch-ms value is an instant the platform's calendar can name.
//
// An entity's `createdAt`/`updatedAt` are `z.number().int()` (entities.ts), and
// an integer is a much larger set than a date: `Date` represents ±8.64e15 ms
// around the epoch and nothing past it, while the schema admits every integer
// zod calls safe. A value in the gap decodes, sorts and syncs like any other —
// and then `new Date(value).toISOString()` THROWS a RangeError, in render, for
// every list that contains the row.
//
// So the question is asked in two places and never in the schema. At the two
// ADMISSION edges, of a file somebody hands us — the interop projection
// (import/project.ts) drops such a date, the backup classifier (data/backup.ts)
// refuses the line. And at the READERS that convert to a calendar string (the
// web list row, export/csv.ts), which must tolerate one anyway: admission only
// covers what arrives from now on, and a stricter entity schema would turn a
// record that is already stored, or pulled from another device, unreadable.
//
// Asked of `Date` itself rather than compared against a constant, so the bound
// is the platform's and cannot drift from it.
export function isCalendarTime(epochMs: number): boolean {
  return Number.isFinite(new Date(epochMs).getTime());
}
