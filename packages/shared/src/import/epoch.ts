// An all-digits timestamp string → epoch ms, shared by the netscape and csv
// parsers (Netscape ADD_DATE/TIME_ADDED attributes, Pocket's time_added CSV
// column). The de-facto convention is epoch SECONDS, but real files also carry
// ms (some exporters) and µs (Firefox's places exports) — magnitude, not digit
// count, tells them apart, so a pre-2001 (9-digit-seconds) date still converts
// right.
export function parseEpoch(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 1e11) return n * 1000; // seconds (any date before year ~5138)
  if (n < 1e14) return n; // already milliseconds
  return Math.floor(n / 1000); // microseconds
}
