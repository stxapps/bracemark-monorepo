import { extractionSchema, type Facet, facetSchema, LINK_TITLE_MAX, linkSchema } from './entities';
import {
  backoff,
  cleanTitle,
  EXTRACTION_BACKOFF_BASE_MS,
  EXTRACTION_BACKOFF_MAX_MS,
  isFacetEligible,
  newFacet,
  tierOf,
} from './extraction';

// The extraction OUTCOME rules every client has to agree on — the extension, the
// expo app and `bracemark-extractor` all decide "may I extract this, and is my
// result better than what's there?" from these four functions alone. Nothing in
// the workspace can catch a disagreement: each client makes the call locally, the
// answer is a synced facet the others then trust, and a wrong one shows up as a
// link that never gets a title or a site that gets hammered — never as an error.
//
// These test the RELATIONS the callers depend on, not the literal tier numbers or
// millisecond constants, which are free to move as long as the ordering holds.

describe('tierOf', () => {
  // The upgrade gate: a client may re-extract a `done` facet only when its own
  // tier is STRICTLY higher. So the only thing that matters is the ordering —
  // active-page beats background fetch beats the server.
  it('ranks active-page above background above server', () => {
    expect(tierOf('extension:fg')).toBeGreaterThan(tierOf('expo:bg'));
    expect(tierOf('expo:bg')).toBeGreaterThan(tierOf('server'));
  });

  it('reads the env suffix, not the platform', () => {
    // `platform:env` — a new platform inherits its tier from the suffix alone,
    // which is what lets expo ship without touching this function.
    expect(tierOf('expo:fg')).toBe(tierOf('extension:fg'));
    expect(tierOf('martian:bg')).toBe(tierOf('expo:bg'));
  });

  it('ranks an UNRECOGNIZED value below every known tier', () => {
    // The conservative floor, and the reason `extractedBy` is a free string
    // rather than an enum: a newer client's `platform:env` round-trips through
    // this build (looseObject) and lands here. Ranking it optimistically would
    // let an unknown result out-rank a real active-page one and block the
    // upgrade that would have fixed the link.
    // 'SERVER' is in the list because the match is exact and case-sensitive; the
    // env suffixes are checked FIRST, so a value is unknown only when it carries
    // neither suffix and is not the literal 'server'.
    for (const unknown of ['', 'fg', 'extension', 'extension:xr', 'SERVER', ':fgx']) {
      expect(tierOf(unknown)).toBeLessThan(tierOf('server'));
    }
  });

  it('ranks an absent value at the same floor', () => {
    // `extractedBy` is optional on the facet, so a half-written one lands here.
    expect(tierOf(undefined)).toBeLessThan(tierOf('server'));
  });
});

describe('backoff', () => {
  it('does not delay before the first failure', () => {
    expect(backoff(0)).toBe(0);
    expect(backoff(-1)).toBe(0);
  });

  it('starts at the base delay after one failure', () => {
    expect(backoff(1)).toBe(EXTRACTION_BACKOFF_BASE_MS);
  });

  it('doubles with each further attempt', () => {
    // Exponential, not linear: a host that is down stays down, and a linear
    // curve keeps re-fetching it all day.
    expect(backoff(2)).toBe(2 * EXTRACTION_BACKOFF_BASE_MS);
    expect(backoff(3)).toBe(4 * EXTRACTION_BACKOFF_BASE_MS);
  });

  it('is capped, so a link is never stuck for longer than the ceiling', () => {
    // Without the cap, 2 ** attempts runs away — around 30 attempts it is past a
    // century, and the link is permanently un-retryable while still reporting
    // itself as a transient failure that will be retried.
    expect(backoff(50)).toBe(EXTRACTION_BACKOFF_MAX_MS);
    expect(backoff(1000)).toBe(EXTRACTION_BACKOFF_MAX_MS);
  });

  it('never decreases as attempts climb', () => {
    for (let attempts = 1; attempts < 40; attempts++) {
      expect(backoff(attempts)).toBeGreaterThanOrEqual(backoff(attempts - 1));
      expect(backoff(attempts)).toBeLessThanOrEqual(EXTRACTION_BACKOFF_MAX_MS);
    }
  });
});

describe('isFacetEligible', () => {
  const facet = (over: Partial<Facet> = {}): Facet => ({ status: 'failed', attempts: 1, ...over });
  const NOW = 1_700_000_000_000;

  it('treats an ABSENT facet as pending', () => {
    // There is no `pending` status — absence IS pending (the writer split: a link
    // with no extractions file has no facets at all). Reading absence as settled
    // would mean no link is ever extracted a first time.
    expect(isFacetEligible(undefined, NOW)).toBe(true);
  });

  it('never re-runs a settled facet, however long ago it settled', () => {
    // `done` and `permanent` are SYNCED, so this is what stops every OTHER
    // device re-fetching a 404 that one device already resolved.
    const longAfter = NOW + 10 * 365 * 24 * 60 * 60 * 1000;
    for (const status of ['done', 'permanent'] as const) {
      expect(isFacetEligible(facet({ status, extractedAt: NOW, attempts: 9 }), longAfter)).toBe(
        false,
      );
    }
  });

  it('holds a transient failure until its backoff has elapsed', () => {
    const failed = facet({ status: 'failed', extractedAt: NOW, attempts: 1 });
    expect(isFacetEligible(failed, NOW)).toBe(false);
    expect(isFacetEligible(failed, NOW + backoff(1) - 1)).toBe(false);
  });

  it('releases it exactly at the boundary, not a tick later', () => {
    const failed = facet({ status: 'failed', extractedAt: NOW, attempts: 1 });
    expect(isFacetEligible(failed, NOW + backoff(1))).toBe(true);
  });

  it('paces a repeatedly-failing facet further out each time', () => {
    // The escalation the `attempts` counter exists for: the same elapsed time
    // that released attempt 1 is not enough for attempt 3.
    const elapsed = NOW + backoff(1);
    expect(isFacetEligible(facet({ extractedAt: NOW, attempts: 1 }), elapsed)).toBe(true);
    expect(isFacetEligible(facet({ extractedAt: NOW, attempts: 3 }), elapsed)).toBe(false);
  });

  it('treats a failure with no timestamp as immediately eligible', () => {
    // `extractedAt` is optional on the schema, so a half-written facet reaches
    // here. Falling back to epoch 0 retries now, which is the safe direction —
    // the alternative is a facet that can never be retried at all.
    expect(isFacetEligible(facet({ extractedAt: undefined, attempts: 1 }), NOW)).toBe(true);
  });
});

describe('cleanTitle', () => {
  it('passes an ordinary title through', () => {
    expect(cleanTitle('How to braise a short rib')).toBe('How to braise a short rib');
  });

  it('collapses internal whitespace and trims the ends', () => {
    // og:title and document.title routinely carry newlines and runs of spaces
    // from the page's markup.
    expect(cleanTitle('  How to\n\tbraise   a  rib  ')).toBe('How to braise a rib');
  });

  it('returns undefined for a title that is absent or only whitespace', () => {
    // Callers resolve `customTitle ?? title ?? host(url)`, so an empty string
    // here would win that chain and render a link with a blank title instead of
    // falling back to its host.
    expect(cleanTitle(undefined)).toBeUndefined();
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle('   \n\t  ')).toBeUndefined();
  });

  it('never leaves half an emoji at the cap', () => {
    // An og:title is cut at LINK_TITLE_MAX UTF-16 units; one whose 300th unit is
    // the first half of an emoji used to be stored ending in a lone surrogate.
    const title = 'a'.repeat(LINK_TITLE_MAX - 1) + '😀 and more';
    const cleaned = cleanTitle(title);
    expect(cleaned).toBe('a'.repeat(LINK_TITLE_MAX - 1));
    expect(cleaned).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('caps an over-long title to something the schema accepts', () => {
    // The cap is not cosmetic: `extractionSchema.title` is `.max(LINK_TITLE_MAX)`,
    // so an uncapped title fails the parse — and because zod fails the OBJECT,
    // the whole extraction blob is rejected and the link loses its image and
    // facet bookkeeping too, not just its title.
    const long = 'a'.repeat(LINK_TITLE_MAX + 50);
    const cleaned = cleanTitle(long);
    expect(cleaned).toHaveLength(LINK_TITLE_MAX);
    expect(
      extractionSchema.safeParse({
        id: 'x',
        title: cleaned,
        facets: {},
        createdAt: 0,
        updatedAt: 0,
      }).success,
    ).toBe(true);
  });

  it('caps to the SHARED bound, so a title is valid in either file', () => {
    // `customTitle` (links/) and `title` (extractions/) share LINK_TITLE_MAX — a
    // title the user types at save lands in one, a discovered title in the other,
    // and the same normalizer feeds both.
    const cleaned = cleanTitle(' x '.repeat(LINK_TITLE_MAX));
    expect(
      linkSchema.safeParse({
        url: 'https://example.com',
        listId: 'my-list',
        tagIds: [],
        customTitle: cleaned,
        createdAt: 0,
        updatedAt: 0,
      }).success,
    ).toBe(true);
  });

  it('collapses BEFORE capping, so whitespace never costs title', () => {
    // Markup indentation lands inside a title as long runs of spaces and
    // newlines. Capping first would spend the budget on characters that are
    // about to collapse to one space, truncating real words to pay for
    // whitespace the user never sees.
    const padded = `A${' '.repeat(80)}${'b'.repeat(LINK_TITLE_MAX)}`;
    const cleaned = cleanTitle(padded);
    expect(cleaned).toHaveLength(LINK_TITLE_MAX);
    expect(cleaned).toBe(`A ${'b'.repeat(LINK_TITLE_MAX - 2)}`);
  });
});

describe('newFacet', () => {
  it('always stamps extractedAt', () => {
    // The field this constructor exists for. Eligibility is
    // `extractedAt + backoff(attempts)`, so an omitted stamp keys off epoch 0 —
    // instantly eligible, no cooldown at all, and the failing host is re-fetched
    // on every pass. Nothing downstream would report that as wrong.
    const before = Date.now();
    const facet = newFacet('failed', 'extension:fg');
    expect(facet.extractedAt).toBeGreaterThanOrEqual(before);
    expect(facet.extractedAt).toBeLessThanOrEqual(Date.now());
  });

  it('gives a fresh failure a real cooldown', () => {
    // The end-to-end version of the assertion above, stated as the behaviour
    // that actually matters: a facet just written as failed is NOT eligible.
    const facet = { ...newFacet('failed', 'server'), attempts: 1 };
    expect(isFacetEligible(facet, Date.now())).toBe(false);
  });

  it('carries the tier string through for tierOf to rank', () => {
    expect(tierOf(newFacet('done', 'extension:fg').extractedBy)).toBe(tierOf('extension:fg'));
  });

  it('leaves attempts at 0 for the writer to overwrite', () => {
    // A placeholder, not the real counter: only `writeExtraction`'s read-merge
    // sees the prior facet, so it owns the increment.
    expect(newFacet('failed', 'server').attempts).toBe(0);
  });

  it('passes tier-specific extras through', () => {
    // `facetSchema` is a looseObject precisely so a tier can attach its own
    // field (the extension's read-mode fileId) without every other client
    // stripping it on the next write.
    const facet = newFacet('done', 'extension:fg', { fileId: 'abc' });
    expect(facet).toMatchObject({ fileId: 'abc' });
    expect(facetSchema.parse(facet)).toMatchObject({ fileId: 'abc' });
  });

  it('builds a facet the schema accepts, for every status', () => {
    for (const status of ['done', 'failed', 'permanent'] as const) {
      expect(facetSchema.safeParse(newFacet(status, 'server')).success).toBe(true);
    }
  });
});
