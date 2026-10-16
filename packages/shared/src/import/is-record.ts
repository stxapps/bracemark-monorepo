// A parsed JSON value that is an object with string keys — not null, and not an
// array, which `typeof` also calls 'object'. Shared by the importers that walk a
// foreign app's JSON (Brace.to, LinkWarden) and the bookmark converter's format
// sniffing, so each narrows untrusted input the same way.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
