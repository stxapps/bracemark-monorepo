import { cutToLength, type Extraction, type Facet, LINK_TITLE_MAX } from './entities';

// The shared extraction OUTCOME rules — title normalization, quality ranking, retry pacing,
// and (re)extraction eligibility — that every client must agree on. They operate on the
// `facetSchema` fields in entities.ts (`extractedBy`, `attempts`/`extractedAt`) but are kept here, beside
// each other rather than in the schema file, the same split `rank.ts`/`tree.ts`
// make: entities.ts is the plaintext SHAPE contract; this is the BEHAVIOR.
//
// Both live in `shared`, not in any client, so the extension, the future Expo app,
// and `bracemark-extractor` rank quality and pace retries by identical rules — the
// reason the docs (link-extraction.md "the extraction entity") put them in `shared`.
// Neither value is stored on the facet: each is a pure function of a stored input
// (`extractedBy`, `attempts`/`extractedAt`), so there's no drift-prone second field
// to keep in sync (the same reason there's no `tier` / `nextEligibleAt` column).

// QUALITY rank derived from a facet's `extractedBy` (`platform:env`, e.g.
// `extension:fg`). Higher = better: active-page (`:fg`, live DOM / WebView) beats
// bg-fetch (`:bg`, raw HTML) beats `server` (bracemark-extractor). An UNRECOGNIZED value
// ranks 0 — conservatively lowest — so a future platform/env a newer client emits
// (round-tripped through `looseObject`) can never wrongly out-rank a known active-page
// result. A client may re-extract (UPGRADE) a `done` facet only when its own tier is
// strictly higher than the facet's.
export function tierOf(extractedBy: string | undefined): number {
  if (!extractedBy) return 0;
  if (extractedBy.endsWith(':fg')) return 3; // active-page — live DOM / WebView
  if (extractedBy.endsWith(':bg')) return 2; // background — raw-HTML fetch
  if (extractedBy === 'server') return 1; // bracemark-extractor
  return 0; // unknown → conservatively lowest
}

// Retry pacing for a TRANSIENT `failed` facet: the deciding client retries once
// `now >= extractedAt + backoff(attempts)`. `attempts` is the number of tries so far
// (1 after the first failure), so the delay grows exponentially from a base and is
// capped — long enough that a flaky host isn't hammered, bounded so a link isn't
// stuck forever. A HARD failure is `status: 'permanent'` instead (never retried), so
// this curve only ever paces transient retries.
export const EXTRACTION_BACKOFF_BASE_MS = 10 * 60 * 1000; // 10 min after the first failure
export const EXTRACTION_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000; // capped at 1 day
export function backoff(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(EXTRACTION_BACKOFF_BASE_MS * 2 ** (attempts - 1), EXTRACTION_BACKOFF_MAX_MS);
}

// Is a facet eligible for (re)extraction right now? The READ-side pacing rule paired with the
// writers here: `newFacet` stamps `extractedAt`/`attempts`, this consumes them via `backoff`.
// Pending when the facet is ABSENT (absence = pending — the writer-split, see entities.ts), or
// when a transient `failed` facet has cooled past its backoff (`now >= extractedAt +
// backoff(attempts)`). `done` and `permanent` (404/410, robots) are settled — never eligible,
// so one device's synced outcome stops every device. Facet-agnostic: the rule is identical for
// `titleImage`, `screenshot`, etc., so callers pull the facet they care about and pass it in.
// Shared for the same reason as `backoff`/`tierOf`: every client (bracemark-web, the future Expo
// app) must decide eligibility by identical rules.
export function isFacetEligible(facet: Facet | undefined, now: number): boolean {
  if (!facet) return true;
  if (facet.status === 'done' || facet.status === 'permanent') return false;
  return now >= (facet.extractedAt ?? 0) + backoff(facet.attempts);
}

// Normalize a discovered title to satisfy `extractionSchema.title`'s `LINK_TITLE_MAX`
// cap (entities.ts): collapse internal whitespace, trim, drop-if-empty, then cap. The
// single normalizer every title WRITER runs before the value lands in the schema — the
// server extractor (raw-HTML og:title/<title>) and the extension (live-DOM og:title/
// document.title) both feed the same capped field, so a long or whitespace-noisy title
// can't be valid from one writer but rejected from the other. Returns undefined for an
// absent/blank title so callers can fall back (`customTitle ?? title ?? host(url)`).
export function cleanTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return cutToLength(collapsed, LINK_TITLE_MAX);
}

// Build a facet-state write — the single constructor every extraction WRITER uses to
// stamp an outcome, so the four base fields are filled the same way by every tier
// (server `bracemark-extractor`, `extension:fg`, and any future Expo client) instead of each
// re-spelling the literal:
//   - `extractedAt: Date.now()` is ALWAYS set — eligibility is `extractedAt + backoff(attempts)`,
//     so omitting it would key off epoch 0 (instantly eligible → no cooldown). Centralizing
//     it here means no client can forget it.
//   - `attempts: 0` is a PLACEHOLDER: on a `failed` write `writeExtraction` overrides it with
//     the prior facet's `attempts + 1` (the real cross-cycle counter, so `backoff` escalates
//     across repeated failures); a `done` write resets to 0; `permanent` never retries so it's
//     irrelevant. The writer owns the number because only its read-merge sees the prior value.
// `extractedBy` is the caller's `platform:env` tier string (`tierOf` ranks quality from it).
// `extra` carries any tier-specific looseObject passthrough — round-tripped by
// `facetSchema`'s `looseObject`. Never a file ref: a blob a facet produces is named by a
// display field in EXTRACTION_FILE_REF_FIELDS, or nothing exports, restores or deletes it.
export function newFacet(
  status: Facet['status'],
  extractedBy: string,
  extra?: Record<string, unknown>,
): Facet {
  return { status, extractedBy, extractedAt: Date.now(), attempts: 0, ...extra };
}

// Every display field on an extraction that names a `files/{id}.enc` blob. THE list —
// every place that has to find an extraction's blobs reads it through
// `extractionFileIds`: the backup's referenced-files walk (data/backup.ts, which also
// gates each id to the path grammar on restore), both platforms' exporters, the link
// destroy paths, and the dangling-extraction sweep. Spelling the fields out at each site
// is how the read-mode copy came to be written as a facet passthrough (`fileId`) that
// none of them knew about: exported by nobody, restored by nobody, and orphaned in R2 by
// every delete. A new blob-producing facet adds its field here and to `extractionSchema`,
// and nowhere else.
export const EXTRACTION_FILE_REF_FIELDS = [
  'imageId',
  'readModeId',
  'screenshotId',
  'pageCopyId',
] as const satisfies readonly (keyof Extraction)[];
export type ExtractionFileRefField = (typeof EXTRACTION_FILE_REF_FIELDS)[number];

// The `files/` ids an extraction references, in EXTRACTION_FILE_REF_FIELDS order. Takes a
// partial so a caller holding `undefined` (a link with no extraction yet) or a view that
// carries only some of the fields can pass it straight through. The fields are typed, but
// a non-string is skipped rather than turned into a path — the guard costs nothing.
export function extractionFileIds(
  extraction: Partial<Pick<Extraction, ExtractionFileRefField>> | undefined,
): string[] {
  if (!extraction) return [];
  const ids: string[] = [];
  for (const field of EXTRACTION_FILE_REF_FIELDS) {
    const id = extraction[field];
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

// The ids `next` no longer references that `prev` did — the blobs a write-back REPLACED
// (a re-capture minting a new screenshot id, a tier upgrade minting a new preview). The
// writer deletes these after the new ref is stored (metadata before content on the way
// down), so a re-capture doesn't leave its predecessor counting against the quota with
// nothing pointing at it.
export function replacedExtractionFileIds(
  prev: Partial<Pick<Extraction, ExtractionFileRefField>> | undefined,
  next: Partial<Pick<Extraction, ExtractionFileRefField>> | undefined,
): string[] {
  const kept = new Set(extractionFileIds(next));
  return extractionFileIds(prev).filter((id) => !kept.has(id));
}
