import { readCappedBytes, safeFetch, SafeFetchError } from './safe-fetch';

// robots.txt, honoured for READ MODE ONLY (docs/link-extraction-server.md, _robots.txt
// and read mode_). The title and preview image are what a publisher wants in an unfurl,
// and the extractor still fetches them without asking, as a chat app's link preview
// does; the article body is the thing a publisher sells, so before this service hands a
// page's text back it reads the site's robots.txt and obeys the group for
// `bracemark-extractor` — or, failing one, the `*` group. That split is published on
// /extractor (apps/bracemark-site/src/app/extractor/page.tsx), so changing which facet
// obeys, or which groups count, changes a sentence an operator may have acted on.
//
// RFC 9309 throughout, with the two status rules that decide most outcomes:
//   - a 4xx (no file, or forbidden) means NO RULES — everything is allowed;
//   - a 5xx, a timeout or a network failure means the file is UNREACHABLE, which the
//     RFC treats as a full disallow. Here that is `unavailable`, a transient answer
//     for this one request, never a settled one.
//
// STATELESS, like everything else here: a verdict is read once per origin PER REQUEST
// (`createRobotsReader`) and dropped with it. No KV, and deliberately not the Workers
// `caches` API either — a cached robots.txt keyed by host is a record, on our side, that
// someone saved a page from that host, which is the thing "persists nothing" rules out.
// The cost is one small extra fetch per origin per read-mode request, and only for read
// mode.

// The product token this service matches a `User-agent:` line against — the first word
// of USER_AGENT in safe-fetch.ts.
export const ROBOTS_PRODUCT_TOKEN = 'bracemark-extractor';
// Per-hop deadline for the robots.txt fetch — shorter than a page's FETCH_TIMEOUT_MS,
// because it sits on the read-mode path in series with the page
// (`EXTRACT_TIMEOUT_MS` in @stxapps/shared extract/endpoints.ts is sized from it).
export const ROBOTS_TIMEOUT_MS = 3_000;
// How much of a robots.txt is read — the RFC's floor for what a crawler must parse
// (500 KiB, i.e. 512,000 bytes). Anything past it is ignored, as the RFC allows.
// /extractor prints this as "first 512 KB" — decimal, like its other ceilings — so
// moving it moves that row (apps/bracemark-site/src/app/extractor/page.tsx).
export const MAX_ROBOTS_BYTES = 512_000;

// The most steps one verdict may spend matching a URL against a file's rules. The matcher is
// linear per rule in the path's length times the pattern's, the file may hold tens of
// thousands of rules, and its operator chooses all of it: 500 rules of 1,000 characters
// against a 2,000-character path was 3.4 s of CPU for one answer. Real files cost a few
// thousand steps. Past the budget the answer is a disallow: nothing is fetched for a file
// this service cannot afford to read. That is `disallowed`, a settled answer: not `unavailable`,
// the transient one for a file that could not be fetched, which a client would ask about again to
// the same end.
export const MAX_ROBOTS_MATCH_STEPS = 2_000_000;

export type RobotsVerdict = 'allowed' | 'disallowed' | 'unavailable';

interface Rule {
  allow: boolean;
  pattern: string; // normalized (normalizePath), may hold `*` and a trailing `$`
}

// The rules that apply to this service, from one robots.txt — or `null` for "no rules"
// (a 4xx, an empty file, no matching group).
export type RobotsRules = Rule[] | null;

// Percent-encoding normalized the RFC's way, so `/%7Efoo` and `/~foo` compare equal:
// a percent-encoded UNRESERVED character is decoded, any other escape is upper-cased,
// and a character outside ASCII is encoded as UTF-8.
// Walked by CODE POINT (`Array.from`), not by UTF-16 unit: half a surrogate pair is what
// makes encodeURIComponent throw, and a lone one (a malformed file) is dropped.
function normalizePath(raw: string): string {
  const chars = Array.from(raw);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const hex = `${chars[i + 1] ?? ''}${chars[i + 2] ?? ''}`;
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      const decoded = String.fromCharCode(parseInt(hex, 16));
      out += /[A-Za-z0-9\-._~]/.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      i += 2;
    } else if ((ch.codePointAt(0) ?? 0) > 0x7e || (ch.codePointAt(0) ?? 0) < 0x21) {
      try {
        out += encodeURIComponent(ch);
      } catch {
        // a lone surrogate — no character to encode
      }
    } else {
      out += ch;
    }
  }
  return out;
}

// Parse a robots.txt into the rules for this service: every group whose `User-agent`
// names ROBOTS_PRODUCT_TOKEN (case-insensitively, a version suffix tolerated), merged;
// failing any, every `*` group, merged; failing that, none.
export function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // a rule before any group belongs to none
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "nothing disallowed" — no rule at all.
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: normalizePath(value) });
    }
  }

  const named = (agent: string) =>
    agent === ROBOTS_PRODUCT_TOKEN || agent.startsWith(`${ROBOTS_PRODUCT_TOKEN}/`);
  const mine = groups.filter((group) => group.agents.some(named));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((group) => group.rules);
  return rules.length > 0 ? rules : null;
}

// Does `pattern` (with `*` wildcards and an optional trailing `$`) match the START of
// `path`? A linear scan with single-star backtracking — never a RegExp built from the
// file, which a pattern of many stars could make catastrophically slow on a Worker.
function matches(pattern: string, path: string, budget: { left: number }): boolean {
  const anchored = pattern.endsWith('$');
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < path.length) {
    if (--budget.left < 0) return false; // the caller reads an empty budget as a disallow
    if (p < pat.length && pat[p] === '*') {
      star = p++;
      mark = s;
    } else if (p < pat.length && pat[p] === path[s]) {
      p++;
      s++;
    } else if (p === pat.length && !anchored) {
      return true; // the pattern is a prefix of what is left
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

// The verdict for one URL under parsed rules: the LONGEST matching pattern wins, and on
// a tie between an Allow and a Disallow the Allow does (the RFC's "least restrictive").
// `/robots.txt` itself is always allowed.
export function robotsVerdictFor(rules: RobotsRules, url: URL): 'allowed' | 'disallowed' {
  if (!rules) return 'allowed';
  const path = normalizePath(`${url.pathname}${url.search}`);
  if (path === '/robots.txt') return 'allowed';
  let best: Rule | null = null;
  const budget = { left: MAX_ROBOTS_MATCH_STEPS };
  for (const rule of rules) {
    const hit = matches(rule.pattern, path, budget);
    if (budget.left < 0) return 'disallowed';
    if (!hit) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best && !best.allow ? 'disallowed' : 'allowed';
}

// Fetch and parse one origin's robots.txt. `unavailable` when it can't be read; rules
// (or `null`, no rules) otherwise. Never throws.
async function readRobots(origin: string): Promise<RobotsRules | 'unavailable'> {
  try {
    const { response } = await safeFetch(
      new URL('/robots.txt', origin).toString(),
      'text/plain',
      ROBOTS_TIMEOUT_MS,
    );
    const bytes = await readCappedBytes(response, MAX_ROBOTS_BYTES);
    return parseRobots(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof SafeFetchError) {
      // 4xx — "unavailable" in the RFC's sense: no file, no rules.
      if (err.code === 'bad_status' && err.status !== undefined && err.status < 500) {
        return null;
      }
      // A redirect walk the guard refused (a hop into private space, too many hops) is
      // the RFC's "unavailable" too — there is no file this service may read.
      if (err.code === 'blocked') return null;
    }
    // 5xx, a timeout, a network failure: unreachable, which reads as a full disallow.
    return 'unavailable';
  }
}

// A per-request reader: each origin's robots.txt is fetched at most once while this
// request runs, and forgotten when it ends. Two pages of one site in one batch share
// the fetch; the next request reads it afresh.
export function createRobotsReader(): (url: URL) => Promise<RobotsVerdict> {
  const byOrigin = new Map<string, Promise<RobotsRules | 'unavailable'>>();
  return async (url) => {
    let rules = byOrigin.get(url.origin);
    if (!rules) {
      rules = readRobots(url.origin);
      byOrigin.set(url.origin, rules);
    }
    const resolved = await rules;
    return resolved === 'unavailable' ? 'unavailable' : robotsVerdictFor(resolved, url);
  };
}
