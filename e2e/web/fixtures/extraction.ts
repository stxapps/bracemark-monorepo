import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type Link, LINKS_PREFIX, MY_LIST_ID, pathFromId } from '@stxapps/shared';

import { E2E_ROOT } from '../../paths';
import { buildBackupArchive } from '../../seed/archive';
import { unique } from './data';

// The deliberately-online half of the URL contract: pages the REAL extractors
// (bracemark-extractor's Worker, Expo's on-device fetch) are allowed to reach, so
// an extraction case can assert on what was extracted rather than on the typed
// fallback every other case keeps (docs/e2e.md, _what e2e may not assert_).
//
// The table lives in e2e/fixtures.json, not here, so the registry check can see
// it; this module only reads it. It is example.com and nothing else — IANA's
// reserved documentation domain, about the most stable HTML on the public web
// and a host we do not own. That choice bounds what these cases can prove:
//
//   - a known title (`Example Domain`) — yes;
//   - a controlled permanent failure — yes, because the origin answers any other
//     path with a real HTTP 404, which `verdictForStatus` settles as permanent;
//   - a controlled transient failure — yes, but from the `.invalid` suffix
//     rather than from this origin (DNS failure → `fetch_failed` → transient);
//   - a preview image, a redirect chain, a no-metadata page — NO. The page has
//     no og:image and never redirects. Those stay at the unit layer
//     (apps/bracemark-extractor lib/*.spec.ts, expo-react device-extraction.spec.ts)
//     until an origin we own replaces this one (e2e/NEXT.md, EXTRACT-FIXTURE-001).
//
// No Playwright import, so the native runner can build the same fixtures.

interface OnlineFixture {
  id: string;
  url: string;
  namespace: 'query' | 'path';
  expectedTitle?: string;
  expectedStatus?: number;
  expectedVerdict: 'done' | 'permanent';
  trait: string;
}

function onlineFixture(id: string): OnlineFixture {
  const registry = JSON.parse(readFileSync(join(E2E_ROOT, 'fixtures.json'), 'utf8')) as {
    urls: { onlineExtraction: OnlineFixture[] };
  };
  const fixture = registry.urls.onlineExtraction.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`e2e/fixtures.json has no online fixture ${id}`);
  return fixture;
}

// A run-scoped token, safe in a query value, a path segment AND a Maestro regex
// (lowercase hex and hyphens only).
function token(label: string): string {
  return unique(label)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
}

// The page whose title extraction must find. Namespaced by query string: the
// origin serves the same document for any query, so every case — and every
// account — saves a URL of its own and a duplicate check never short-circuits the
// save the case is about.
export function knownPage(label = 'e2e-known'): { url: string; title: string } {
  const fixture = onlineFixture('example-known-page');
  if (!fixture.expectedTitle) throw new Error('example-known-page has no expectedTitle');
  return { url: `${fixture.url}?e2e=${token(label)}`, title: fixture.expectedTitle };
}

// A page on the same origin that answers 404 — the controlled permanent failure.
export function missingPage(label = 'e2e-missing'): { url: string } {
  const fixture = onlineFixture('example-missing-page');
  return { url: `${fixture.url}-${token(label)}` };
}

export interface PendingExtractionLibrary {
  archivePath: string;
  known: { url: string; title: string };
  missing: { url: string };
  // Unresolvable, so it settles as a transient failure ("Will retry").
  unreachable: { url: string };
  // Newest-first `.invalid` rows that sit ABOVE the three targets.
  fillerUrls: string[];
  total: number;
}

// A small library with NO `extractions/` entities — absence is the pending signal
// (docs/link-extraction.md, _imported links_) — and no titles, so nothing the
// import writes can be mistaken for an extraction result.
//
// The three targets are the OLDEST rows. With `fillers` above them they start
// below the fold, which is what makes a Generate all case honest on a client
// whose automatic drain is displayed-scoped: only the full-library job can reach
// them. The web case needs no fillers because it never renders the list before
// pressing the button; the native case lands on the list at sign-in.
//
// Writer, not oracle, exactly as web/fixtures/library.ts argues: shared supplies
// the entity shape and path rule the importer reads, and every value a case
// asserts on is one this function typed.
export async function writePendingExtractionLibrary(
  archivePath: string,
  options: { label: string; fillers?: number },
): Promise<PendingExtractionLibrary> {
  const known = knownPage(`${options.label}-known`);
  const missing = missingPage(`${options.label}-missing`);
  const unreachable = { url: `https://${token(options.label)}.invalid/pending` };
  const fillerHost = `${token(`${options.label}-filler`)}.invalid`;
  const fillerUrls = Array.from(
    { length: options.fillers ?? 0 },
    (_, index) => `https://${fillerHost}/row-${String(index).padStart(3, '0')}`,
  );

  // Newest first, a minute apart, all in the past: fillers, then the targets.
  const ordered = [...fillerUrls, unreachable.url, missing.url, known.url];
  const now = Date.now();
  const items = ordered.map((url, index) => {
    const at = now - (index + 1) * 60_000;
    const link: Link = { url, listId: MY_LIST_ID, tagIds: [], createdAt: at, updatedAt: at };
    return { path: pathFromId(`${token(options.label)}-${index}`, LINKS_PREFIX), data: link };
  });

  const archive = buildBackupArchive({
    items,
    files: [],
    counts: { links: items.length, lists: 0, tags: 0, pins: 0, extractions: 0, files: 0 },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);

  return { archivePath, known, missing, unreachable, fillerUrls, total: items.length };
}
