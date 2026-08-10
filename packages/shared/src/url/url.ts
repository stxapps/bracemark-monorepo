// URL coercion shared by every link-entry path — the quick-add popover today,
// the full editor and the browser extension next. Centralised here (not copied
// per app) so all entry points store the SAME canonical shape; a link saved on
// web, in the extension, or via paste must normalize identically or dedup and
// `new URL(...)`-based rendering would disagree across surfaces.

// Matches a leading RFC-3986 scheme (`scheme:` — ALPHA then ALPHA/DIGIT/+/-/.).
// Used to detect EXPLICIT-scheme input before we'd otherwise prepend https://,
// because `new URL(...)` can't tell `mailto:x` from `host:port` (both parse as a
// scheme with an empty host), so we discriminate on the raw text first.
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

// Coerce typed text into the absolute http(s) URL we store (the same shape the
// read edge later parses with `new URL(...)`), or null if it can't be one.
//
// - An explicit scheme is trusted only when it's http(s); any other scheme
//   (mailto:, ftp:, tel:, the `javascript:` of a bookmarklet, …) returns null —
//   we never store a non-web or script URL as an href. Note this also rejects a
//   schemeless host:port like "example.com:8080" (indistinguishable from a
//   scheme); the user can prefix http(s):// or confirm-and-save it raw.
// - Schemeless input gets https:// prepended, but must have a DOTTED host, so
//   plain prose ("note to self") isn't silently promoted to a URL.
//
// Normalization is MINIMAL on purpose: we only prepend the missing scheme and
// return the input otherwise untouched. We deliberately do NOT return
// `new URL(value).href`, which would mutate meaning (append a trailing slash,
// re-encode the path, …); query strings, fragments, and trailing slashes can be
// significant, so only the unambiguously-safe missing-scheme fix is applied.
// Heavier canonicalization (for dedup identity) belongs in a separate derived
// key, not in the stored URL.
//
// null is a SOFT result: the caller should warn and let the user confirm-and-save
// the raw text, rather than block on a debatable-but-deliberate URL.
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const scheme = SCHEME_RE.exec(trimmed);
  // An explicit non-http(s) scheme is rejected outright; otherwise it's http(s).
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  const hasScheme = scheme !== null;

  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    // Schemeless input was just promoted to https://; require a dotted host so a
    // lone word ("localhost", "draft") doesn't become a URL. Explicit-scheme
    // input is trusted as deliberate (e.g. http://localhost:3000).
    if (!hasScheme && !u.hostname.includes('.')) return null;
    return candidate;
  } catch {
    return null;
  }
}

// The DISPLAY host for a URL — its hostname with a leading `www.` stripped. The
// provisional title, secondary line, and favicon domain every surface shows for a
// link. Centralised here (not copied per app) so web, the extension, and the
// extractor all render the SAME host string; the extractor's server-side title
// fallback must match what the clients display. Takes an already-parsed URL so
// callers that hold one (the extractor's `finalUrl`, `canonicalUrlKey`'s `u`) don't
// re-parse — see `hostFromText` for the raw-string entry point.
export function hostFromUrl(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

// `hostFromUrl` for raw, possibly-malformed text: the link `url` we store comes
// from user input, so when it won't parse we fall back to the raw string rather
// than throw (better a slightly-off label than a crash). The www-stripping rule
// itself lives only in `hostFromUrl`; this just adds the parse + fallback.
export function hostFromText(text: string): string {
  try {
    return hostFromUrl(new URL(text));
  } catch {
    return text;
  }
}

// The DISPLAY url for a link that has no title — the title-line fallback across
// every layout. Unlike `hostFromText`, it KEEPS THE PATH, so several untitled
// links from the same site (e.g. three medium.com articles) stay distinguishable
// instead of all collapsing to the bare host. Only a leading `https://` is
// stripped for readability; a plain `http://` is kept so the insecure scheme
// stays visible. Everything else (path, query, fragment) is left untouched.
export function displayUrl(url: string): string {
  return url.replace(/^https:\/\//, '');
}

// A canonical DEDUP IDENTITY KEY for a URL — "are these two links the same
// resource?" — NOT something to display or store as the link's url. Two inputs
// that a human would call the same page collapse to the same key.
//
// This is intentionally AGGRESSIVE (unlike normalizeUrl, which is minimal and
// preserves what the user typed): it folds the http/https scheme, drops a leading
// `www.`, drops the default port and a trailing slash, sorts the query string,
// and drops the fragment. Path CASE is preserved — paths can be case-sensitive.
//
// Where it belongs: compute this at the read edge and key a CLIENT-SIDE index on
// it (IndexedDB) — never persist it in the synced plaintext. It's derived from
// `url` and the rules here will evolve (e.g. stripping `utm_*`/tracking params is
// a likely next step), so it must be recomputable from source, not frozen into
// LWW state. Returns null for input normalizeUrl can't coerce.
//
// First cut — deliberately conservative: it does NOT yet strip tracking params or
// fold index files, so it can over-count distinct (those are safe, additive
// refinements to add when dedup is wired up). Keep it next to normalizeUrl so
// every surface (web, full editor, extension) derives identity identically.
export function canonicalUrlKey(value: string): string | null {
  const normalized = normalizeUrl(value);
  if (normalized === null) return null;

  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    return null;
  }

  const host = hostFromUrl(u);
  // URL already drops the default port (80/http, 443/https) → u.port is ''.
  const port = u.port ? `:${u.port}` : '';
  const path = u.pathname.replace(/\/+$/, '');

  // Deterministic codepoint sort (not localeCompare, which is locale-dependent)
  // so the same URL keys identically across every runtime.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const params = [...u.searchParams.entries()].sort(
    ([ak, av], [bk, bv]) => cmp(ak, bk) || cmp(av, bv),
  );
  const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';

  return `${host}${port}${path}${query}`;
}
